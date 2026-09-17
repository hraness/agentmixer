use crate::{
    Error, Id, MAX_TEXT_BYTES, Result, bounded_text, label,
    models::ModelChoice,
    policy::{Failure, Terminal, TurnFacts},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Idle,
    Working,
    NeedsAnswer,
    NeedsAction,
    NeedsApproval,
    Limited,
    Failed,
    Cancelled,
    Uncertain,
}
impl State {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::NeedsAnswer => "needs answer",
            Self::NeedsAction => "needs action",
            Self::NeedsApproval => "needs approval",
            Self::Limited => "usage limit",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Uncertain => "needs recovery",
        }
    }
    pub fn attention(self) -> bool {
        matches!(
            self,
            Self::NeedsAnswer | Self::NeedsAction | Self::NeedsApproval | Self::Uncertain
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    Thinking,
    Tool,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub digest: String,
    pub media_type: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}
impl Attachment {
    pub fn validate(&self) -> Result<()> {
        if self.digest.len() != 64
            || !self
                .digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !matches!(
                self.media_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
            || self.bytes == 0
            || self.bytes > 10 * 1024 * 1024
            || self.width == 0
            || self.height == 0
            || self.width > 8192
            || self.height > 8192
            || u64::from(self.width) * u64::from(self.height) > 32_000_000
        {
            return Err(Error::Invalid("image attachment"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: Id,
    pub role: Role,
    pub text: String,
    pub at_ms: u64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}
impl Message {
    pub fn validate(&self) -> Result<()> {
        bounded_text(&self.text, MAX_TEXT_BYTES)?;
        if self.attachments.len() > 8 {
            return Err(Error::Limit("attachments"));
        }
        for image in &self.attachments {
            image.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub id: Id,
    pub account: Id,
    pub model: ModelChoice,
    pub workspace: String,
    pub title: String,
    pub pane: Id,
    pub state: State,
    pub revision: u64,
    pub created_at_ms: u64,
    pub last_active_at_ms: u64,
}
impl Session {
    pub fn validate(&self) -> Result<()> {
        self.model.validate()?;
        bounded_text(&self.workspace, 4096)?;
        label(&self.title, 160)?;
        if self.workspace.is_empty() || self.last_active_at_ms < self.created_at_ms {
            return Err(Error::Invalid("session"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subagent {
    pub id: Id,
    pub label: String,
    pub state: State,
    pub model: Option<String>,
}

pub fn classify(text: &str, facts: &TurnFacts) -> State {
    if !facts.joined || facts.effects == crate::policy::EffectState::Uncertain {
        return State::Uncertain;
    }
    if facts.terminal == Terminal::Cancelled {
        return State::Cancelled;
    }
    if facts.failure == Some(Failure::Authentication) {
        return State::NeedsAction;
    }
    if matches!(
        facts.failure,
        Some(Failure::AccountQuota | Failure::ModelQuota)
    ) {
        return State::Limited;
    }
    if facts.pending_attention {
        return State::NeedsApproval;
    }
    if facts.terminal == Terminal::Failed {
        return State::Failed;
    }
    let lower = text
        .chars()
        .rev()
        .take(1200)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .to_lowercase();
    if [
        "please sign in",
        "please log in",
        "verification code",
        "scan the qr",
        "paste your",
        "attach the",
        "run this manually",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
    {
        return State::NeedsAction;
    }
    if [
        "please approve",
        "please confirm",
        "do you approve",
        "your approval",
        "your consent",
    ]
    .iter()
    .any(|cue| lower.contains(cue))
    {
        return State::NeedsApproval;
    }
    if lower.trim_end().ends_with('?') {
        return State::NeedsAnswer;
    }
    State::Idle
}
