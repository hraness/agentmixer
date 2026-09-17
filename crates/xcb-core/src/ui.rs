use crate::{
    Id, Provider,
    models::ModelChoice,
    panes::Pane,
    session::{Attachment, Message, Session, State, Subagent},
    usage::Estimate,
};

#[derive(Debug, Clone)]
pub struct AccountRow {
    pub id: Id,
    pub provider: Provider,
    pub label: String,
    pub subscription: String,
    pub remaining_percent: Option<f64>,
    pub resets_at_ms: Option<u64>,
    pub runway: Estimate,
    pub busy: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct View {
    pub session: Option<Session>,
    pub sessions: Vec<Session>,
    pub accounts: Vec<AccountRow>,
    pub models: Vec<ModelChoice>,
    pub messages: Vec<Message>,
    pub subagents: Vec<Subagent>,
    pub activity: Vec<String>,
    pub extensions: Vec<(String, String)>,
    pub pane: Pane,
    pub panes: Vec<Pane>,
    pub pane_revision: Option<String>,
    pub pane_error: Option<String>,
    pub state: State,
    pub tokens_per_second: Option<f64>,
    pub share_percent: Option<f64>,
    pub total_runway_seconds: Option<f64>,
    pub runway_coverage: (usize, usize),
    pub reduced_motion: bool,
}
impl Default for View {
    fn default() -> Self {
        Self {
            session: None,
            sessions: vec![],
            accounts: vec![],
            models: vec![],
            messages: vec![],
            subagents: vec![],
            activity: vec![],
            extensions: vec![],
            pane: Pane::focus(),
            panes: Pane::presets(),
            pane_revision: None,
            pane_error: None,
            state: State::Idle,
            tokens_per_second: None,
            share_percent: None,
            total_runway_seconds: None,
            runway_coverage: (0, 0),
            reduced_motion: false,
        }
    }
}

pub enum Intent {
    Submit {
        text: String,
        attachments: Vec<Attachment>,
    },
    Cancel,
    Quit,
    NewSession,
    Resume(Id),
    Account(Id),
    Model(String),
    SetDefault,
    Pane(Id),
    SavePane {
        pane: Pane,
        expected: Option<String>,
    },
    GeneratePane(String),
    AttachPath(String),
    AttachRgba {
        width: usize,
        height: usize,
        bytes: Vec<u8>,
    },
    Extension {
        name: String,
        enabled: bool,
    },
    Refresh,
}

pub enum Update {
    View(Box<View>),
    Delta {
        session: Id,
        thinking: bool,
        text: String,
    },
    ClearStream(Id),
    Attachment(Attachment),
    PaneCandidate(Pane),
    Notice(String),
    Stopped,
}
