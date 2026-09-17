use crate::{Error, Result, digest, new_id, private, process};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use tokio::process::Command;
use xcb_core::{
    Id,
    session::{Session, State},
};

const MAX_HOOKS: usize = 128;
const MAX_INPUT: usize = 16 * 1024;
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    SessionStart,
    SessionEnd,
    TurnStart,
    TurnEnd,
}
impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "session_start",
            Self::SessionEnd => "session_end",
            Self::TurnStart => "turn_start",
            Self::TurnEnd => "turn_end",
        }
    }
}
impl FromStr for Event {
    type Err = Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "session_start" => Ok(Self::SessionStart),
            "session_end" => Ok(Self::SessionEnd),
            "turn_start" => Ok(Self::TurnStart),
            "turn_end" => Ok(Self::TurnEnd),
            _ => Err(xcb_core::Error::Invalid("hook event").into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hook {
    pub id: Id,
    pub event: Event,
    pub executable: PathBuf,
    pub sha256: String,
    pub timeout_ms: u64,
    pub enabled: bool,
}
impl Hook {
    fn validate(&self) -> Result<()> {
        if !self.executable.is_absolute()
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !(100..=300_000).contains(&self.timeout_ms)
        {
            return Err(xcb_core::Error::Invalid("hook").into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HookInput {
    pub event: Event,
    pub session: Id,
    pub workspace: String,
    pub model: String,
    pub state: State,
}
impl HookInput {
    pub fn new(event: Event, session: &Session, state: State) -> Self {
        Self {
            event,
            session: session.id.clone(),
            workspace: session.workspace.clone(),
            model: session.model.key(),
            state,
        }
    }
}

fn path(root: &Path, id: &Id) -> PathBuf {
    root.join("hooks").join(format!("{id}.json"))
}

pub fn list(root: &Path) -> Result<Vec<Hook>> {
    let directory = private::directory(&root.join("hooks"))?;
    let mut hooks = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if entry.file_type()?.is_file() && name.to_str().is_some_and(|name| name.ends_with(".json"))
        {
            if hooks.len() >= MAX_HOOKS {
                return Err(xcb_core::Error::Limit("hooks").into());
            }
            let hook: Hook = serde_json::from_slice(&private::read(&entry.path(), 32 * 1024)?)?;
            hook.validate()?;
            if path(root, &hook.id) != entry.path() {
                return Err(Error::Conflict("hook identity mismatch"));
            }
            hooks.push(hook);
        }
    }
    hooks.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(hooks)
}

pub fn add(root: &Path, event: Event, executable: &Path, timeout_ms: u64) -> Result<Hook> {
    if !executable.is_absolute() {
        return Err(Error::Unavailable("hook executable path must be absolute"));
    }
    let executable = executable.canonicalize()?;
    if executable.starts_with(root) {
        return Err(Error::Unavailable(
            "hook executable must be outside xcb state",
        ));
    }
    if list(root)?.len() >= MAX_HOOKS {
        return Err(xcb_core::Error::Limit("hooks").into());
    }
    let hook = Hook {
        id: new_id("h"),
        event,
        sha256: process::executable_digest(&executable)?,
        executable,
        timeout_ms,
        enabled: false,
    };
    hook.validate()?;
    private::create(&path(root, &hook.id), &serde_json::to_vec_pretty(&hook)?)?;
    Ok(hook)
}

pub fn set_enabled(root: &Path, id: &Id, enabled: bool) -> Result<Hook> {
    let hook_path = path(root, id);
    let bytes = private::read(&hook_path, 32 * 1024)?;
    let mut hook: Hook = serde_json::from_slice(&bytes)?;
    hook.validate()?;
    if hook.id != *id {
        return Err(Error::Conflict("hook identity mismatch"));
    }
    hook.enabled = enabled;
    private::replace(
        &hook_path,
        &serde_json::to_vec_pretty(&hook)?,
        &digest(bytes),
    )?;
    Ok(hook)
}

async fn invoke(root: &Path, hook: &Hook, input: &[u8]) -> Result<String> {
    if process::executable_digest(&hook.executable)? != hook.sha256 {
        return Err(Error::Unavailable(
            "hook executable changed; register it again",
        ));
    }
    let home = private::directory(&root.join("hooks").join("home"))?;
    private::directory(&home.join("tmp"))?;
    let mut command = Command::new(&hook.executable);
    command
        .env_clear()
        .envs(process::environment(&home))
        .current_dir(&home);
    let output = process::capture_with_input(
        command,
        input,
        MAX_OUTPUT,
        Duration::from_millis(hook.timeout_ms),
    )
    .await?;
    String::from_utf8(output).map_err(|_| Error::Protocol("hook output encoding"))
}

pub async fn fire(root: &Path, event: Event, input: &HookInput) -> Result<Vec<String>> {
    let mut payload = serde_json::to_vec(input)?;
    if payload.len() > MAX_INPUT {
        return Err(xcb_core::Error::Limit("hook input").into());
    }
    payload.push(b'\n');
    let mut notices = Vec::new();
    for hook in list(root)?
        .into_iter()
        .filter(|hook| hook.enabled && hook.event == event)
    {
        match invoke(root, &hook, &payload).await {
            Ok(output) if !output.trim().is_empty() => notices.push(format!(
                "Hook {}: {}",
                hook.id,
                xcb_core::display_text(output.trim(), 256)
            )),
            Err(error) => notices.push(format!("Hook {} failed: {error}", hook.id)),
            _ => {}
        }
    }
    Ok(notices)
}
