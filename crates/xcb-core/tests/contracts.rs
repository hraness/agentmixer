use xcb_core::{Id, Provider};
use xcb_core::models::{Mode, parse_devin_catalog};
use xcb_core::panes::Pane;
use xcb_core::policy::{AutoContinue, EffectState, Failure, Terminal, TurnFacts, should_continue};
use xcb_core::usage::{Counters, Estimate, QuotaPoint, VelocitySample, runway, velocity};

#[test]
fn identifiers_cannot_be_paths_or_terminal_controls() {
    for value in ["", "..", "a/b", "../account", "\u{1b}[2J", "é", "a b"] {
        assert!(Id::new(value).is_err(), "{value:?}");
    }
    assert_eq!(Id::new("personal-2").unwrap().as_str(), "personal-2");
    assert!(serde_json::from_str::<Id>("\"../escape\"").is_err());
}

#[test]
fn adaptive_and_fusion_keep_exact_provider_issued_identifiers() {
    let bytes = br#"{"families":[
      {"family_label":"Adaptive","slug":"adaptive","variants":[{"model_uid":"adaptive","label":"Adaptive"}]},
      {"family_label":"Fusion","slug":"fusion","variants":[{"model_uid":"fusion-gpt-6-astra-high-sidekick-swe-2-medium","label":"Fusion (Astra High + SWE-2 Medium)"}]},
      {"family_label":"SWE-2","slug":"swe-2","variants":[{"model_uid":"swe-2-high","label":"SWE-2 High"}]}
    ]}"#;
    let choices = parse_devin_catalog(bytes, 10).unwrap();
    assert_eq!(choices[0].mode, Mode::Adaptive);
    assert_eq!(choices[1].mode, Mode::Fusion);
    assert_eq!(choices[1].id.as_str(), "fusion-gpt-6-astra-high-sidekick-swe-2-medium");
    assert_eq!(choices[2].mode, Mode::Fixed);
    assert!(choices.iter().all(|choice| choice.provider == Provider::Devin));
}

#[test]
fn duplicate_or_malformed_catalog_entries_are_not_silently_accepted() {
    let bytes = br#"{"families":[{"family_label":"x","slug":"x","variants":[{"model_uid":"x","label":"X"},{"model_uid":"x","label":"Y"}]}]}"#;
    assert!(parse_devin_catalog(bytes, 10).is_err());
    assert!(parse_devin_catalog(br#"{"families":null}"#, 10).is_err());
}

#[test]
fn reasoning_is_an_output_subset_not_additional_billable_tokens() {
    let counters = Counters { input: 100, cache_read: 20, cache_write: 30, output: 50, reasoning: Some(40) };
    assert_eq!(counters.total().unwrap(), 200);
    let invalid = Counters { reasoning: Some(51), ..counters };
    assert!(invalid.total().is_err());
}

fn quota(at: u64, used: f64) -> QuotaPoint {
    QuotaPoint { pool: Id::new("paid").unwrap(), window: Id::new("weekly").unwrap(), used_percent: used, observed_at_ms: at, resets_at_ms: 1_000_000 }
}

#[test]
fn runway_is_an_estimate_from_comparable_fresh_quota_observations() {
    let estimate = runway(&[quota(10_000, 20.0), quota(70_000, 30.0)], 70_000);
    let Estimate::Known { seconds } = estimate else { panic!("missing estimate"); };
    assert!((seconds - 420.0).abs() < 0.001);
    assert!(matches!(runway(&[quota(70_000, 30.0)], 70_000), Estimate::Unknown { .. }));
    assert!(matches!(runway(&[quota(10_000, 30.0), quota(70_000, 20.0)], 70_000), Estimate::Unknown { .. }));
    assert!(matches!(runway(&[quota(10_000, 20.0), quota(70_000, 30.0)], 800_000), Estimate::Unknown { .. }));
    assert!(matches!(runway(&[quota(10_000, f64::NAN), quota(70_000, 30.0)], 70_000), Estimate::Unknown { .. }));
}

#[test]
fn velocity_never_converts_resets_or_missing_samples_to_zero_usage() {
    let samples = [VelocitySample { at_ms: 10_000, output_tokens: 10 }, VelocitySample { at_ms: 20_000, output_tokens: 110 }];
    assert_eq!(velocity(&samples, 20_000, 60_000), Some(10.0));
    assert_eq!(velocity(&samples[..1], 20_000, 60_000), None);
    assert_eq!(velocity(&samples, 200_000, 60_000), None);
    assert_eq!(velocity(&[samples[1], samples[0]], 20_000, 60_000), None);
}

fn stopped() -> TurnFacts {
    TurnFacts { terminal: Terminal::TokenLimit, joined: true, effects: EffectState::Settled, pending_attention: false, failure: None }
}

#[test]
fn enabled_by_default_continuation_never_approves_or_replays_uncertain_work() {
    let policy = AutoContinue::default();
    assert!(policy.enabled);
    assert!(should_continue(&policy, &stopped(), 0, 1000, false));
    assert!(!should_continue(&policy, &stopped(), policy.max_consecutive, 1000, false));
    assert!(!should_continue(&policy, &stopped(), 0, 1000, true));
    for facts in [
        TurnFacts { joined: false, ..stopped() },
        TurnFacts { pending_attention: true, ..stopped() },
        TurnFacts { effects: EffectState::Uncertain, ..stopped() },
        TurnFacts { terminal: Terminal::Cancelled, ..stopped() },
        TurnFacts { failure: Some(Failure::Policy), ..stopped() },
        TurnFacts { terminal: Terminal::Completed, ..stopped() },
    ] {
        assert!(!should_continue(&policy, &facts, 0, 1000, false));
    }
}

#[test]
fn pane_presets_roundtrip_without_executable_authority() {
    for pane in Pane::presets() {
        let bytes = serde_json::to_vec(&pane).unwrap();
        assert_eq!(Pane::parse(&bytes).unwrap(), pane);
    }
    assert!(Pane::parse(br#"{"version":1,"id":"evil","title":"x","root":{"type":"text","value":"hello","command":"sh"}}"#).is_err());
    assert!(Pane::parse(br#"{"version":2,"id":"v2","title":"x","root":{"type":"text","value":"hello"}}"#).is_err());
}

proptest::proptest! {
    #[test]
    fn arbitrary_pane_bytes_never_panic(input in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..8192)) {
        let _ = Pane::parse(&input);
    }
    #[test]
    fn arbitrary_catalog_bytes_never_panic(input in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..8192)) {
        let _ = parse_devin_catalog(&input, 1);
    }
}
