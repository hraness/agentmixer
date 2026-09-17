use std::collections::BTreeSet;
use xcb_core::models::{Mode, ModelChoice, default_preferences, sort_choices};
use xcb_core::panes::{Pane, PaneSlot};
use xcb_core::policy::{EffectState, Failure, RouteCandidate, Terminal, TurnFacts, next_route};
use xcb_core::usage::{Estimate, QuotaPoint, runway};
use xcb_core::{Id, Provider};

fn route(account: &str, model: &str) -> RouteCandidate {
    RouteCandidate {
        account: Id::new(account).unwrap(),
        model: ModelChoice {
            provider: Provider::Devin,
            id: Id::new(model).unwrap(),
            label: model.into(),
            mode: Mode::Fixed,
            effort: None,
            observed_at_ms: 1,
        },
        admitted: true,
        quota_fresh: true,
        available: true,
    }
}
fn facts(failure: Failure) -> TurnFacts {
    TurnFacts {
        terminal: Terminal::Failed,
        joined: true,
        effects: EffectState::Settled,
        pending_attention: false,
        failure: Some(failure),
    }
}

#[test]
fn account_limits_do_not_retry_the_same_accounts_other_models() {
    let current = route("personal", "swe-2-high");
    let candidates = [
        route("personal", "gpt-6-astra-max"),
        route("work", "gpt-6-astra-max"),
    ];
    assert_eq!(
        next_route(
            &current,
            &candidates,
            &BTreeSet::new(),
            &facts(Failure::AccountQuota),
            true
        )
        .unwrap()
        .account
        .as_str(),
        "work"
    );
    assert_eq!(
        next_route(
            &current,
            &candidates,
            &BTreeSet::new(),
            &facts(Failure::ModelQuota),
            true
        )
        .unwrap()
        .account
        .as_str(),
        "personal"
    );
}

#[test]
fn switching_is_not_a_recovery_for_policy_auth_or_transport_failures() {
    let current = route("personal", "swe-2-high");
    let candidates = [route("work", "gpt-6-astra-max")];
    for failure in [
        Failure::Policy,
        Failure::Authentication,
        Failure::Transport,
        Failure::Unknown,
    ] {
        assert!(
            next_route(
                &current,
                &candidates,
                &BTreeSet::new(),
                &facts(failure),
                true
            )
            .is_none()
        );
    }
    assert!(
        next_route(
            &current,
            &candidates,
            &BTreeSet::new(),
            &facts(Failure::AccountQuota),
            false
        )
        .is_none()
    );
    let pending = TurnFacts {
        effects: EffectState::Uncertain,
        ..facts(Failure::AccountQuota)
    };
    assert!(next_route(&current, &candidates, &BTreeSet::new(), &pending, true).is_none());
}

#[test]
fn unadmitted_stale_or_already_tried_targets_are_excluded() {
    let current = route("personal", "swe-2-high");
    let target = route("work", "gpt-6-astra-max");
    for invalid in [
        RouteCandidate {
            admitted: false,
            ..target.clone()
        },
        RouteCandidate {
            quota_fresh: false,
            ..target.clone()
        },
        RouteCandidate {
            available: false,
            ..target.clone()
        },
    ] {
        assert!(
            next_route(
                &current,
                &[invalid],
                &BTreeSet::new(),
                &facts(Failure::AccountQuota),
                true
            )
            .is_none()
        );
    }
    let tried = BTreeSet::from([format!("{}/{}", target.account, target.model.key())]);
    assert!(
        next_route(
            &current,
            &[target],
            &tried,
            &facts(Failure::AccountQuota),
            true
        )
        .is_none()
    );
}

#[test]
fn favorites_precede_provider_modes_and_other_models() {
    let mut choices = vec![
        route("a", "other").model,
        route("a", "gpt-6-astra-max").model,
        route("a", "swe-2-high").model,
    ];
    sort_choices(&mut choices, &default_preferences());
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice.id.as_str())
            .collect::<Vec<_>>(),
        ["swe-2-high", "gpt-6-astra-max", "other"]
    );
}

#[test]
fn failed_hot_reload_preserves_the_previous_pane() {
    let previous = Pane::focus();
    let mut slot = PaneSlot::new(previous.clone()).unwrap();
    assert!(!slot.reload(b"{incomplete"));
    assert_eq!(slot.current, previous);
    assert!(slot.error.is_some());
    let mut other = previous.clone();
    other.id = Id::new("other").unwrap();
    assert!(!slot.reload(&serde_json::to_vec(&other).unwrap()));
    assert!(slot.reload(&serde_json::to_vec(&previous).unwrap()));
    assert!(slot.error.is_none());
}

#[test]
fn mismatched_reset_windows_never_generate_runway() {
    let point = QuotaPoint {
        pool: Id::new("paid").unwrap(),
        window: Id::new("weekly").unwrap(),
        used_percent: 10.0,
        observed_at_ms: 1_000,
        resets_at_ms: 100_000,
    };
    let next = QuotaPoint {
        used_percent: 90.0,
        observed_at_ms: 61_000,
        resets_at_ms: 200_000,
        ..point.clone()
    };
    assert!(matches!(
        runway(&[point, next], 61_000),
        Estimate::Unknown { .. }
    ));
}
