use crate::{Error, Id, MAX_JSON_BYTES, Provider, Result, label};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode { Fixed, Adaptive, Fusion }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChoice {
    pub provider: Provider,
    pub id: Id,
    pub label: String,
    pub mode: Mode,
    pub effort: Option<Id>,
    pub observed_at_ms: u64,
}

impl ModelChoice {
    pub fn validate(&self) -> Result<()> {
        label(&self.label, 256)?;
        if self.provider != Provider::Devin && self.mode != Mode::Fixed { return Err(Error::Invalid("model mode")); }
        if self.mode != Mode::Fixed && self.effort.is_some() { return Err(Error::Invalid("mode effort")); }
        Ok(())
    }
    pub fn key(&self) -> String {
        format!("{}/{}{}", self.provider, self.id, self.effort.as_ref().map(|effort| format!("/{effort}")).unwrap_or_default())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preference {
    pub provider: Provider,
    pub model: Id,
    pub effort: Option<Id>,
}

pub fn default_preferences() -> Vec<Preference> {
    [
        (Provider::Devin, "swe-2-high", None),
        (Provider::Devin, "gpt-6-astra-max", None),
        (Provider::Devin, "gpt-5-6-sol-max", None),
        (Provider::Claude, "claude-fable-5-1", Some("max")),
        (Provider::Claude, "claude-opus-5", Some("max")),
        (Provider::Codex, "gpt-6-astra", Some("ultra")),
        (Provider::Codex, "gpt-5.6-sol", Some("ultra")),
    ].into_iter().map(|(provider, model, effort)| Preference {
        provider, model: Id::new(model).expect("static model"), effort: effort.map(|value| Id::new(value).expect("static effort")),
    }).collect()
}

pub fn sort_choices(choices: &mut [ModelChoice], favorites: &[Preference]) {
    let rank = |choice: &ModelChoice| favorites.iter().position(|fav| fav.provider == choice.provider && fav.model == choice.id && fav.effort == choice.effort).unwrap_or(usize::MAX);
    choices.sort_by(|left, right| rank(left).cmp(&rank(right))
        .then_with(|| (left.mode == Mode::Fixed).cmp(&(right.mode == Mode::Fixed)))
        .then_with(|| left.provider.cmp(&right.provider))
        .then_with(|| left.label.cmp(&right.label))
        .then_with(|| left.key().cmp(&right.key())));
}

#[derive(Deserialize)]
struct DevinCatalog { families: Vec<DevinFamily> }
#[derive(Deserialize)]
struct DevinFamily { slug: String, variants: Vec<DevinVariant> }
#[derive(Deserialize)]
struct DevinVariant { model_uid: String, label: String }

pub fn parse_devin_catalog(bytes: &[u8], now: u64) -> Result<Vec<ModelChoice>> {
    if bytes.len() > MAX_JSON_BYTES { return Err(Error::Limit("model catalog")); }
    let catalog: DevinCatalog = serde_json::from_slice(bytes).map_err(|_| Error::Invalid("model catalog"))?;
    if catalog.families.len() > 128 { return Err(Error::Limit("model families")); }
    let mut choices = Vec::new();
    let mut seen = BTreeSet::new();
    for family in catalog.families {
        label(&family.slug, 160)?;
        let mode = match family.slug.as_str() { "adaptive" => Mode::Adaptive, "fusion" => Mode::Fusion, _ => Mode::Fixed };
        if family.variants.len() > 1024 { return Err(Error::Limit("model variants")); }
        for variant in family.variants {
            let choice = ModelChoice { provider: Provider::Devin, id: Id::new(variant.model_uid)?, label: variant.label, mode, effort: None, observed_at_ms: now };
            choice.validate()?;
            if !seen.insert(choice.id.clone()) { return Err(Error::Invalid("duplicate model")); }
            choices.push(choice);
            if choices.len() > 4096 { return Err(Error::Limit("models")); }
        }
    }
    Ok(choices)
}
