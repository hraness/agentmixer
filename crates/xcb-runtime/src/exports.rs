use crate::{Error, Result, digest, private, store::Store};
use aicharts_core::sessions::{MAX_RECORDS, MAX_SESSIONS, PROFILE};
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf};
use xcb_core::{Id, Provider};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_WINDOW_MS: u64 = 366 * 86_400_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u8,
    profile: &'static str,
    sessions: Vec<SessionRecord>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    provider: &'static str,
    session_id: String,
    conversation_id: Option<String>,
    window: Window,
    source: &'static str,
    usage: Vec<UsageRecord>,
    spans: Vec<serde_json::Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    start_ms: u64,
    end_ms: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecord {
    id: String,
    at_ms: u64,
    model: Option<String>,
    model_basis: &'static str,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: Option<u64>,
}

fn public_id(id: &Id) -> String {
    digest(id.as_str())[..32].to_owned()
}
fn provider(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude_code",
        Provider::Codex => "codex",
        Provider::Devin => "devin",
    }
}

pub fn report(store: &Store) -> Result<Vec<u8>> {
    let mut sessions: BTreeMap<Id, (Provider, Vec<UsageRecord>)> = BTreeMap::new();
    for observation in store.usage(None, 2048)? {
        observation.counters.total()?;
        let records = sessions
            .entry(observation.session.clone())
            .or_insert_with(|| (observation.model.provider, Vec::new()));
        if records.0 != observation.model.provider {
            return Err(Error::Conflict("session usage provider changed"));
        }
        records.1.push(UsageRecord {
            id: public_id(&observation.id),
            at_ms: observation.at_ms,
            model: None,
            model_basis: "unknown",
            input_tokens: observation.counters.input,
            cache_read_tokens: observation.counters.cache_read,
            cache_write_tokens: observation.counters.cache_write,
            output_tokens: observation.counters.output,
            reasoning_tokens: observation.counters.reasoning,
        });
    }
    if sessions.len() > MAX_SESSIONS
        || sessions
            .values()
            .map(|(_, usage)| usage.len())
            .sum::<usize>()
            > MAX_RECORDS
    {
        return Err(xcb_core::Error::Limit("aiCharts records").into());
    }
    let mut output = Vec::with_capacity(sessions.len());
    for (session, (provider_id, mut usage)) in sessions {
        usage.sort_by(|a, b| a.at_ms.cmp(&b.at_ms).then_with(|| a.id.cmp(&b.id)));
        let start_ms = usage.first().map(|record| record.at_ms).unwrap_or(0);
        let end_ms = usage.last().map(|record| record.at_ms).unwrap_or(start_ms);
        if end_ms.saturating_sub(start_ms) > MAX_WINDOW_MS {
            return Err(xcb_core::Error::Invalid("aiCharts observation window").into());
        }
        output.push(SessionRecord {
            provider: provider(provider_id),
            session_id: public_id(&session),
            conversation_id: None,
            window: Window { start_ms, end_ms },
            source: "history",
            usage,
            spans: Vec::new(),
        });
    }
    let bytes = serde_json::to_vec(&Report {
        schema_version: 1,
        profile: PROFILE,
        sessions: output,
    })?;
    if bytes.len() > MAX_BYTES {
        return Err(xcb_core::Error::Limit("aiCharts export bytes").into());
    }
    Ok(bytes)
}

pub fn write(store: &Store) -> Result<PathBuf> {
    let bytes = report(store)?;
    let directory = private::directory(&store.root().join("exports"))?;
    let path = directory.join(format!("aicharts-sessions-{}.json", &digest(&bytes)[..16]));
    match private::create(&path, &bytes) {
        Ok(()) => Ok(path),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if private::read(&path, MAX_BYTES)? == bytes {
                Ok(path)
            } else {
                Err(Error::Conflict("aiCharts export digest collision"))
            }
        }
        Err(error) => Err(error),
    }
}
