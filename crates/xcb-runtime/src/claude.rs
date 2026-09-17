use crate::{Error, Result};
use serde_json::Value;
use xcb_core::{
    MAX_JSON_BYTES, MAX_TEXT_BYTES, display_text,
    policy::{Failure, Terminal},
    usage::Counters,
};

pub const VERSION: &str = "2.1.268";

#[derive(Debug)]
pub enum Event {
    Initialize(Value),
    Control(Value),
    ControlResponse(Value),
    Delta {
        thinking: bool,
        text: String,
    },
    Assistant {
        text: String,
        thinking: String,
    },
    Quota {
        window: Option<String>,
        utilization: Option<f64>,
        resets_at_ms: Option<u64>,
        failure: Option<Failure>,
    },
    Result {
        terminal: Terminal,
        text: String,
        models: Vec<(String, Counters)>,
    },
    Subagent {
        id: String,
        status: String,
        label: String,
        model: Option<String>,
    },
    Notice,
}
fn string<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Protocol("missing string"))?;
    if text.len() > max {
        return Err(Error::Protocol("oversized string"));
    }
    Ok(text)
}
fn optional_string(value: &Value, key: &str, max: usize) -> Result<Option<String>> {
    value
        .get(key)
        .filter(|value| !value.is_null())
        .map(|_| string(value, key, max).map(str::to_owned))
        .transpose()
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(Error::Protocol("missing counter"))
}
fn maybe_count(value: &Value, key: &str) -> Result<u64> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value.as_u64().ok_or(Error::Protocol("invalid counter")),
    }
}
fn counters(value: &Value) -> Result<Counters> {
    let value = Counters {
        input: number(value, "inputTokens")?,
        output: number(value, "outputTokens")?,
        cache_read: maybe_count(value, "cacheReadInputTokens")?,
        cache_write: maybe_count(value, "cacheCreationInputTokens")?,
        reasoning: value
            .get("thinkingTokens")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_u64()
                    .ok_or(Error::Protocol("invalid thinking counter"))
            })
            .transpose()?,
    };
    value.total()?;
    Ok(value)
}

pub fn parse_event(bytes: &[u8]) -> Result<Event> {
    if bytes.len() > MAX_JSON_BYTES {
        return Err(Error::Protocol("frame limit"));
    }
    let value: Value = serde_json::from_slice(bytes)?;
    match string(&value, "type", 80)? {
        "control_request" => Ok(Event::Control(value)),
        "control_response" => Ok(Event::ControlResponse(value)),
        "system" => match value.get("subtype").and_then(Value::as_str) {
            Some("init") => Ok(Event::Initialize(value)),
            Some("task_started") => Ok(Event::Subagent {
                id: string(&value, "task_id", 160)?.to_owned(),
                status: "working".into(),
                label: display_text(
                    value
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("Subagent"),
                    160,
                ),
                model: optional_string(&value, "model", 160)?,
            }),
            Some("task_notification") => Ok(Event::Subagent {
                id: string(&value, "task_id", 160)?.to_owned(),
                status: string(&value, "status", 40)?.to_owned(),
                label: "Subagent".into(),
                model: optional_string(&value, "model", 160)?,
            }),
            _ => Ok(Event::Notice),
        },
        "stream_event" => {
            let event = value
                .get("event")
                .ok_or(Error::Protocol("missing stream event"))?;
            if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return Ok(Event::Notice);
            }
            let delta = event.get("delta").ok_or(Error::Protocol("missing delta"))?;
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => Ok(Event::Delta {
                    thinking: false,
                    text: display_text(string(delta, "text", MAX_TEXT_BYTES)?, MAX_TEXT_BYTES),
                }),
                Some("thinking_delta") => Ok(Event::Delta {
                    thinking: true,
                    text: display_text(string(delta, "thinking", MAX_TEXT_BYTES)?, MAX_TEXT_BYTES),
                }),
                _ => Ok(Event::Notice),
            }
        }
        "assistant" => {
            let blocks = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .ok_or(Error::Protocol("assistant content"))?;
            if blocks.len() > 128 {
                return Err(Error::Protocol("content block limit"));
            }
            let mut text = String::new();
            let mut thinking = String::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(string(block, "text", MAX_TEXT_BYTES)?);
                    }
                    Some("thinking") => {
                        if !thinking.is_empty() {
                            thinking.push('\n');
                        }
                        thinking.push_str(string(block, "thinking", MAX_TEXT_BYTES)?);
                    }
                    _ => (),
                }
                if text.len() + thinking.len() > MAX_TEXT_BYTES {
                    return Err(Error::Protocol("assistant text limit"));
                }
            }
            Ok(Event::Assistant {
                text: display_text(&text, MAX_TEXT_BYTES),
                thinking: display_text(&thinking, MAX_TEXT_BYTES),
            })
        }
        "rate_limit_event" => {
            let info = value
                .get("rate_limit_info")
                .ok_or(Error::Protocol("rate limit info"))?;
            let status = string(info, "status", 80)?;
            if !matches!(status, "allowed" | "allowed_warning" | "rejected") {
                return Err(Error::Protocol("unknown quota status"));
            }
            let utilization = info
                .get("utilization")
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                        .ok_or(Error::Protocol("quota utilization"))
                })
                .transpose()?;
            let resets_at_ms = info
                .get("resetsAt")
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|value| *value < 100_000_000_000)
                        .and_then(|value| value.checked_mul(1000))
                        .ok_or(Error::Protocol("quota reset"))
                })
                .transpose()?;
            let window = info
                .get("rateLimitType")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| {
                            [
                                "five_hour",
                                "seven_day",
                                "seven_day_opus",
                                "seven_day_sonnet",
                                "seven_day_overage_included",
                                "overage",
                            ]
                            .contains(value)
                        })
                        .map(str::to_owned)
                        .ok_or(Error::Protocol("quota window"))
                })
                .transpose()?;
            let failure = (status == "rejected").then_some(
                if matches!(
                    window.as_deref(),
                    Some("seven_day_opus" | "seven_day_sonnet")
                ) {
                    Failure::ModelQuota
                } else {
                    Failure::AccountQuota
                },
            );
            Ok(Event::Quota {
                window,
                utilization,
                resets_at_ms,
                failure,
            })
        }
        "result" => {
            let subtype = string(&value, "subtype", 80)?;
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .ok_or(Error::Protocol("result status"))?;
            let terminal = match (
                subtype,
                is_error,
                value.get("stop_reason").and_then(Value::as_str),
            ) {
                ("error_max_turns", _, _) => Terminal::TurnLimit,
                ("success", false, Some("max_tokens")) => Terminal::TokenLimit,
                ("success", false, _) => Terminal::Completed,
                _ => Terminal::Failed,
            };
            let mut text = value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let Some(errors) = value.get("errors") {
                let errors = errors.as_array().ok_or(Error::Protocol("result errors"))?;
                if errors.len() > 32 {
                    return Err(Error::Protocol("result error limit"));
                }
                for error in errors {
                    let error = error.as_str().ok_or(Error::Protocol("result error text"))?;
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(error);
                }
            }
            if text.len() > MAX_TEXT_BYTES {
                return Err(Error::Protocol("result text limit"));
            }
            let mut models = Vec::new();
            if let Some(raw) = value.get("modelUsage") {
                let raw = raw.as_object().ok_or(Error::Protocol("model accounting"))?;
                if raw.len() > 32 {
                    return Err(Error::Protocol("model accounting limit"));
                }
                for (id, value) in raw {
                    xcb_core::Id::new(id)?;
                    models.push((id.to_owned(), counters(value)?));
                }
            }
            Ok(Event::Result {
                terminal,
                text: display_text(&text, MAX_TEXT_BYTES),
                models,
            })
        }
        _ => Ok(Event::Notice),
    }
}
