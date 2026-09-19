//! Provider-neutral judgment port.
//!
//! A `Judge` answers a batch of questions against one state object in a single
//! fast request. It is a routing/classification helper, never an execution or
//! custody boundary: every consumer must keep a deterministic path when no
//! judge is configured or a call fails, and must bound what it sends.
//!
//! Question kinds mirror the System One wire shape so additional backends can
//! implement the same port: `noul` (yes/no probability), `choice` (pick one of
//! labelled options with confidence), and `score` (score against criteria).

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use xcb_core::{Id, bounded_text};
use zeroize::Zeroizing;

use crate::{Error, Result, config::JudgeConfig, private};

/// One yes/no question; the answer is a probability in `[0, 1]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoulCriteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#true: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#false: Option<String>,
}

/// One judgment question sent to a `Judge`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum JudgeQuestion {
    Noul {
        instructions: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        criteria: Option<NoulCriteria>,
    },
    Choice {
        instructions: String,
        criteria: BTreeMap<String, Option<String>>,
    },
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
}

/// One validated answer.
#[derive(Debug, Clone, PartialEq)]
pub enum JudgeAnswer {
    Noul(f64),
    Choice {
        choice: String,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
    },
    Score {
        score: f64,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
    },
}

impl JudgeAnswer {
    /// Probability for a `noul` question; `None` for other answer kinds.
    pub fn noul(&self) -> Option<f64> {
        match self {
            Self::Noul(noul) => Some(*noul),
            _ => None,
        }
    }
    /// Picked option for a `choice` question; `None` for other answer kinds.
    pub fn choice(&self) -> Option<(&str, f64)> {
        match self {
            Self::Choice {
                choice, confidence, ..
            } => Some((choice.as_str(), *confidence)),
            _ => None,
        }
    }
    /// Numeric score for a `score` question; `None` for other answer kinds.
    pub fn score(&self) -> Option<(f64, f64)> {
        match self {
            Self::Score {
                score, confidence, ..
            } => Some((*score, *confidence)),
            _ => None,
        }
    }
}

/// A complete validated response: one answer per asked question name.
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeAnswers {
    pub answers: BTreeMap<String, JudgeAnswer>,
    pub model: Option<String>,
}

/// Questions are keyed by short stable names chosen by the caller.
pub type JudgeQuestions = BTreeMap<String, JudgeQuestion>;

/// Anything that can answer a batch of judgment questions: the System One
/// backend, a test double, or a future provider with the same shape.
pub trait Judge: Send + Sync {
    fn ask<'a>(
        &'a self,
        state: &'a serde_json::Value,
        questions: &'a JudgeQuestions,
    ) -> Pin<Box<dyn Future<Output = Result<JudgeAnswers>> + Send + 'a>>;
}

/// Bounds shared by every backend and enforced before transport.
pub const MAX_JUDGE_STATE_BYTES: usize = 128 * 1024;
pub const MAX_JUDGE_QUESTIONS: usize = 64;
pub const MAX_JUDGE_INSTRUCTION_BYTES: usize = 4 * 1024;
pub const MAX_JUDGE_NAME_BYTES: usize = 256;

fn check_name(name: &str) -> Result<()> {
    Id::new(name).map_err(|_| xcb_core::Error::Invalid("judge question name"))?;
    Ok(bounded_text(name, MAX_JUDGE_NAME_BYTES)?)
}

/// Validates a question batch before it reaches any backend.
pub fn check_questions(questions: &JudgeQuestions) -> Result<()> {
    if questions.is_empty() || questions.len() > MAX_JUDGE_QUESTIONS {
        return Err(xcb_core::Error::Limit("judge questions").into());
    }
    for (name, question) in questions {
        check_name(name)?;
        let instructions = match question {
            JudgeQuestion::Noul {
                instructions,
                criteria,
            } => {
                if let Some(criteria) = criteria {
                    for text in [&criteria.r#true, &criteria.r#false].into_iter().flatten() {
                        bounded_text(text, MAX_JUDGE_INSTRUCTION_BYTES)?;
                    }
                }
                instructions
            }
            JudgeQuestion::Choice {
                instructions,
                criteria,
            } => {
                if criteria.is_empty() || criteria.len() > 64 {
                    return Err(xcb_core::Error::Limit("judge choice options").into());
                }
                for (option, description) in criteria {
                    check_name(option)?;
                    if let Some(description) = description {
                        bounded_text(description, MAX_JUDGE_INSTRUCTION_BYTES)?;
                    }
                }
                instructions
            }
            JudgeQuestion::Score {
                instructions,
                criteria,
            } => {
                if criteria.is_empty() || criteria.len() > 16 {
                    return Err(xcb_core::Error::Limit("judge score criteria").into());
                }
                for criterion in criteria {
                    bounded_text(criterion, MAX_JUDGE_INSTRUCTION_BYTES)?;
                }
                instructions
            }
        };
        if instructions.is_empty() {
            return Err(xcb_core::Error::Invalid("judge instructions").into());
        }
        bounded_text(instructions, MAX_JUDGE_INSTRUCTION_BYTES)?;
    }
    Ok(())
}

fn valid_probability(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

/// Validates that a response is complete, matches every asked question's type,
/// and cannot select an option or probability bucket outside that question.
pub fn check_answers(questions: &JudgeQuestions, response: &JudgeAnswers) -> Result<()> {
    check_questions(questions)?;
    if response.answers.len() != questions.len() {
        return Err(Error::Unavailable("judge response question mismatch"));
    }
    for (name, question) in questions {
        let answer = response
            .answers
            .get(name)
            .ok_or(Error::Unavailable("judge response missing answer"))?;
        let valid = match (question, answer) {
            (JudgeQuestion::Noul { .. }, JudgeAnswer::Noul(value)) => valid_probability(*value),
            (
                JudgeQuestion::Choice { criteria, .. },
                JudgeAnswer::Choice {
                    choice,
                    confidence,
                    probabilities,
                },
            ) => {
                criteria.contains_key(choice)
                    && probabilities.contains_key(choice)
                    && valid_probability(*confidence)
                    && !probabilities.is_empty()
                    && probabilities.iter().all(|(option, probability)| {
                        criteria.contains_key(option) && valid_probability(*probability)
                    })
            }
            (
                JudgeQuestion::Score { criteria, .. },
                JudgeAnswer::Score {
                    score,
                    confidence,
                    probabilities,
                },
            ) => {
                score.is_finite()
                    && (0.0..=(criteria.len() - 1) as f64).contains(score)
                    && valid_probability(*confidence)
                    && !probabilities.is_empty()
                    && probabilities.iter().all(|(bucket, probability)| {
                        bucket
                            .parse::<usize>()
                            .is_ok_and(|index| index < criteria.len())
                            && valid_probability(*probability)
                    })
            }
            _ => false,
        };
        if !valid {
            return Err(Error::Unavailable("judge response does not match question"));
        }
    }
    Ok(())
}

/// Validates the serialized state before it reaches any backend.
pub fn check_state(state: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(state).map_err(|_| xcb_core::Error::Invalid("judge state"))?;
    if bytes.is_empty() || bytes.len() > MAX_JUDGE_STATE_BYTES {
        return Err(xcb_core::Error::Limit("judge state").into());
    }
    Ok(())
}

/// Where a resolved judge key came from; `status` reports it, secrets never print.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JudgeKeySource {
    Env,
    Vault,
}

pub const JUDGE_TOKEN_FILE: &str = "jev-api-token";
pub const JUDGE_KEY_ENV: &str = "XCB_JEV_API_KEY";
pub const JUDGE_KEY_VENDOR_ENV: &str = "TYPESAFE_API_KEY";
const MAX_JUDGE_TOKEN_BYTES: usize = 2048;

fn valid_judge_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 512
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '+'))
}

/// Stores a judge key under the private state root; refuses to clobber.
pub fn store_judge_token(root: &Path, bytes: &[u8]) -> Result<()> {
    let token = std::str::from_utf8(bytes)
        .map_err(|_| Error::Unavailable("invalid judge key"))?
        .trim();
    if !valid_judge_token(token) {
        return Err(Error::Unavailable("invalid judge key"));
    }
    private::create(&root.join(JUDGE_TOKEN_FILE), token.as_bytes())
}

pub fn has_judge_token(root: &Path) -> Result<bool> {
    Ok(root.join(JUDGE_TOKEN_FILE).exists())
}

/// Removes the vault key. Returns whether a file was removed.
pub fn remove_judge_token(root: &Path) -> Result<bool> {
    let path = root.join(JUDGE_TOKEN_FILE);
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(path)?;
    Ok(true)
}

fn vault_token(root: &Path) -> Result<Option<(Zeroizing<String>, JudgeKeySource)>> {
    let path = root.join(JUDGE_TOKEN_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = Zeroizing::new(private::read(&path, MAX_JUDGE_TOKEN_BYTES)?);
    let token = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Unavailable("invalid stored judge key"))?
        .trim();
    if !valid_judge_token(token) {
        return Err(Error::Unavailable(
            "stored judge key is invalid; replace it with xcb judge token",
        ));
    }
    Ok(Some((
        Zeroizing::new(token.to_owned()),
        JudgeKeySource::Vault,
    )))
}

fn env_token() -> Option<(Zeroizing<String>, JudgeKeySource)> {
    for name in [JUDGE_KEY_ENV, JUDGE_KEY_VENDOR_ENV] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim().to_owned();
            if valid_judge_token(&value) {
                return Some((Zeroizing::new(value), JudgeKeySource::Env));
            }
        }
    }
    None
}

/// Resolves the effective judge key: environment first (host override), then
/// the vault file. Never prints or persists the key anywhere else.
pub fn judge_token(root: &Path) -> Result<Option<(Zeroizing<String>, JudgeKeySource)>> {
    if let Some(token) = env_token() {
        return Ok(Some(token));
    }
    vault_token(root)
}

/// Resolves a ready-to-use judge when the extension is enabled and a key is
/// configured. Returns `Ok(None)` for either absence — consumers keep their
/// deterministic path in both cases.
pub fn resolve(root: &Path, config: &JudgeConfig) -> Result<Option<Arc<dyn Judge>>> {
    if !config.enabled {
        return Ok(None);
    }
    let Some((token, _)) = judge_token(root)? else {
        return Ok(None);
    };
    Ok(Some(Arc::new(crate::jev::SystemOne::new(
        token,
        config.model.clone(),
        config.endpoint.clone(),
    )?)))
}
