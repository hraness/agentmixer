use crate::{Error, Result, digest, private};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};
use xcb_core::{
    Id,
    models::{Preference, default_preferences},
    policy::AutoContinue,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ContextPolicy {
    pub enabled: bool,
    pub trigger_tokens: u64,
    pub floor_tokens: u64,
    pub min_interval_ms: u64,
}
impl Default for ContextPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            trigger_tokens: 250_000,
            floor_tokens: 40_000,
            min_interval_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Extensions {
    pub auto_continue: AutoContinue,
    pub gobstopper: ContextPolicy,
    pub usage: bool,
    pub aicharts_upload: bool,
}
impl Default for Extensions {
    fn default() -> Self {
        Self {
            auto_continue: AutoContinue::default(),
            gobstopper: ContextPolicy::default(),
            usage: true,
            aicharts_upload: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub default_account: Option<Id>,
    pub favorites: Vec<Preference>,
    pub pane: Id,
    pub reduced_motion: bool,
    pub auto_failover: bool,
    pub extensions: Extensions,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            default_account: None,
            favorites: default_preferences(),
            pane: Id::new("focus").expect("static pane"),
            reduced_motion: false,
            auto_failover: true,
            extensions: Extensions::default(),
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        let context = &self.extensions.gobstopper;
        let continuation = &self.extensions.auto_continue;
        if self.version != 1
            || self.favorites.len() > 128
            || context.floor_tokens < 1024
            || context.floor_tokens >= context.trigger_tokens
            || context.trigger_tokens > 1_000_000
            || !(1000..=3_600_000).contains(&context.min_interval_ms)
            || !(1..=16).contains(&continuation.max_consecutive)
            || !(1000..=3_600_000).contains(&continuation.max_elapsed_ms)
        {
            return Err(xcb_core::Error::Invalid("configuration").into());
        }
        let keys: BTreeSet<_> = self
            .favorites
            .iter()
            .map(|fav| (fav.provider, &fav.model, &fav.effort))
            .collect();
        if keys.len() != self.favorites.len() {
            return Err(xcb_core::Error::Invalid("duplicate favorite").into());
        }
        Ok(())
    }
    pub fn load(root: &Path) -> Result<(Self, Option<String>)> {
        let path = root.join("config.json");
        match private::read(&path, 64 * 1024) {
            Ok(bytes) => {
                let config: Self = serde_json::from_slice(&bytes)?;
                config.validate()?;
                Ok((config, Some(digest(bytes))))
            }
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok((Self::default(), None))
            }
            Err(error) => Err(error),
        }
    }
    pub fn save(&self, root: &Path, revision: Option<&str>) -> Result<()> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self)?;
        let path = root.join("config.json");
        match revision {
            Some(revision) => private::replace(&path, &bytes, revision),
            None => private::create(&path, &bytes),
        }
    }
}
