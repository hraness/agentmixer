use crate::{Error, Id, Result, bounded_text, label};
use serde::{Deserialize, Serialize};

pub const MAX_PANE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    LastUser,
    Responses,
    Thinking,
    Subagents,
    Accounts,
    Models,
    Usage,
    Activity,
    Extensions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Node {
    Column {
        children: Vec<Node>,
    },
    Row {
        children: Vec<Node>,
    },
    Widget {
        source: Source,
        #[serde(default)]
        lines: Option<u16>,
    },
    Text {
        value: String,
    },
    Spacer {
        lines: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pane {
    pub version: u32,
    pub id: Id,
    pub title: String,
    pub root: Node,
}

impl Pane {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_PANE_BYTES {
            return Err(Error::Limit("pane bytes"));
        }
        let pane: Self =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("pane declaration"))?;
        pane.validate()?;
        Ok(pane)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(Error::Invalid("pane version"));
        }
        label(&self.title, 80)?;
        let mut count = 0;
        self.root.validate(0, &mut count)
    }
    pub fn presets() -> Vec<Self> {
        let widget = |source, lines| Node::Widget { source, lines };
        let pane = |id: &str, title: &str, children| Self {
            version: 1,
            id: Id::new(id).expect("static pane"),
            title: title.to_owned(),
            root: Node::Column { children },
        };
        vec![
            pane(
                "focus",
                "Focus",
                vec![
                    widget(Source::LastUser, Some(5)),
                    widget(Source::Thinking, Some(2)),
                    widget(Source::Responses, None),
                    widget(Source::Subagents, Some(3)),
                ],
            ),
            pane(
                "swarm",
                "Swarm",
                vec![
                    Node::Row {
                        children: vec![
                            widget(Source::Subagents, None),
                            widget(Source::Accounts, None),
                        ],
                    },
                    widget(Source::LastUser, Some(4)),
                    widget(Source::Responses, None),
                ],
            ),
            pane(
                "inspect",
                "Inspect",
                vec![
                    widget(Source::LastUser, Some(4)),
                    widget(Source::Responses, None),
                    widget(Source::Activity, Some(8)),
                    widget(Source::Extensions, Some(3)),
                ],
            ),
        ]
    }
    pub fn focus() -> Self {
        Self::presets().remove(0)
    }
}

impl Node {
    fn validate(&self, depth: usize, count: &mut usize) -> Result<()> {
        *count += 1;
        if depth > 8 || *count > 96 {
            return Err(Error::Limit("pane structure"));
        }
        match self {
            Self::Column { children } | Self::Row { children } => {
                if children.is_empty() || children.len() > 12 {
                    return Err(Error::Invalid("pane children"));
                }
                for child in children {
                    child.validate(depth + 1, count)?;
                }
            }
            Self::Widget {
                lines: Some(lines), ..
            }
            | Self::Spacer { lines } => {
                if !(1..=80).contains(lines) {
                    return Err(Error::Invalid("pane height"));
                }
            }
            Self::Text { value } => bounded_text(value, 4096)?,
            Self::Widget { .. } => (),
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PaneSlot {
    pub current: Pane,
    pub error: Option<String>,
    pub revision: u64,
}
impl PaneSlot {
    pub fn new(pane: Pane) -> Result<Self> {
        pane.validate()?;
        Ok(Self {
            current: pane,
            error: None,
            revision: 0,
        })
    }
    pub fn reload(&mut self, bytes: &[u8]) -> bool {
        match Pane::parse(bytes) {
            Ok(pane) if pane.id == self.current.id => {
                self.current = pane;
                self.error = None;
                self.revision = self.revision.saturating_add(1);
                true
            }
            Ok(_) => {
                self.error = Some("pane identity changed; keeping the previous view".to_owned());
                false
            }
            Err(error) => {
                self.error = Some(error.to_string());
                false
            }
        }
    }
}
