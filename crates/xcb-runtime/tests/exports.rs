use std::{fs, os::unix::fs::PermissionsExt};
use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    policy::{EffectState, Failure, Terminal, TurnFacts},
    session::State,
    usage::Counters,
};
use xcb_runtime::{
    exports, runner,
    store::{Store, UsageObservation},
};

#[test]
fn local_aicharts_session_export_is_deterministic_bounded_and_private() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    fs::create_dir(base.join("work")).unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store
        .add_account(Provider::Claude, "Personal", "Max", 1)
        .unwrap();
    let model = ModelChoice {
        provider: Provider::Claude,
        id: Id::new("default").unwrap(),
        label: "Default".into(),
        mode: Mode::Fixed,
        resolved: Some(Id::new("claude-opus-5[1m]").unwrap()),
        effort: Some(Id::new("high").unwrap()),
        observed_at_ms: 1,
    };
    let session = store
        .create_session(&account.id, model.clone(), &base.join("work"), 2)
        .unwrap();
    store
        .record_usage(&UsageObservation {
            id: Id::new("usage_1").unwrap(),
            session: session.id,
            account: account.id,
            model,
            counters: Counters {
                input: 10,
                cache_read: 3,
                cache_write: 2,
                output: 5,
                reasoning: Some(1),
            },
            at_ms: 1_700_000_000_000,
        })
        .unwrap();
    let first = exports::report(&store).unwrap();
    assert_eq!(first, exports::report(&store).unwrap());
    let value: serde_json::Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["profile"], "session-observations-v1");
    assert_eq!(value["sessions"][0]["provider"], "claude_code");
    assert_eq!(value["sessions"][0]["source"], "history");
    assert_eq!(
        value["sessions"][0]["usage"][0]["model"],
        serde_json::Value::Null
    );
    assert_eq!(value["sessions"][0]["usage"][0]["outputTokens"], 5);
    assert_eq!(value["sessions"][0]["spans"], serde_json::json!([]));
    assert_eq!(
        value["sessions"][0]["sessionId"].as_str().unwrap().len(),
        32
    );
    let path = exports::write(&store).unwrap();
    assert_eq!(path, exports::write(&store).unwrap());
    assert_eq!(fs::read(&path).unwrap(), first);
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn idle_export_predicate_rejects_pane_failed_and_uncertain_outcomes() {
    let idle_facts = TurnFacts {
        terminal: Terminal::Completed,
        joined: true,
        effects: EffectState::None,
        pending_attention: false,
        failure: None,
    };
    assert!(runner::should_idle_export(false, &idle_facts, State::Idle));
    assert!(!runner::should_idle_export(true, &idle_facts, State::Idle));
    assert!(!runner::should_idle_export(
        false,
        &idle_facts,
        State::NeedsAnswer
    ));

    let uncertain_facts = TurnFacts {
        terminal: Terminal::Completed,
        joined: true,
        effects: EffectState::Uncertain,
        pending_attention: false,
        failure: None,
    };
    assert!(!runner::should_idle_export(
        false,
        &uncertain_facts,
        State::Idle
    ));

    let unjoined_facts = TurnFacts {
        terminal: Terminal::Completed,
        joined: false,
        effects: EffectState::Settled,
        pending_attention: false,
        failure: None,
    };
    assert!(!runner::should_idle_export(
        false,
        &unjoined_facts,
        State::Idle
    ));

    let failed_facts = TurnFacts {
        terminal: Terminal::Failed,
        joined: true,
        effects: EffectState::None,
        pending_attention: false,
        failure: Some(Failure::Unknown),
    };
    assert!(!runner::should_idle_export(
        false,
        &failed_facts,
        State::Idle
    ));

    let cancelled_facts = TurnFacts {
        terminal: Terminal::Cancelled,
        joined: true,
        effects: EffectState::None,
        pending_attention: false,
        failure: None,
    };
    assert!(!runner::should_idle_export(
        false,
        &cancelled_facts,
        State::Idle
    ));

    let limit_facts = TurnFacts {
        terminal: Terminal::TokenLimit,
        joined: true,
        effects: EffectState::None,
        pending_attention: false,
        failure: None,
    };
    assert!(!runner::should_idle_export(
        false,
        &limit_facts,
        State::Idle
    ));
}

#[test]
fn per_session_aicharts_export_is_stable_and_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    fs::create_dir(base.join("work")).unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store
        .add_account(Provider::Claude, "Personal", "Max", 1)
        .unwrap();
    let model = ModelChoice {
        provider: Provider::Claude,
        id: Id::new("default").unwrap(),
        label: "Default".into(),
        mode: Mode::Fixed,
        resolved: None,
        effort: None,
        observed_at_ms: 1,
    };
    let session = store
        .create_session(&account.id, model.clone(), &base.join("work"), 2)
        .unwrap();
    store
        .record_usage(&UsageObservation {
            id: Id::new("usage_1").unwrap(),
            session: session.id.clone(),
            account: account.id.clone(),
            model: model.clone(),
            counters: Counters {
                input: 10,
                cache_read: 3,
                cache_write: 2,
                output: 5,
                reasoning: Some(1),
            },
            at_ms: 1_700_000_000_000,
        })
        .unwrap();

    let report = exports::session_report(&store, &session.id).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&report).unwrap();
    assert_eq!(value["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["sessions"][0]["sessionId"].as_str().unwrap().len(),
        32
    );

    let first = exports::write_session(&store, &session.id, &report).unwrap();
    let second = exports::write_session(&store, &session.id, &report).unwrap();
    assert_eq!(first, second);
    assert_eq!(fs::read(&first).unwrap(), report);
    assert_eq!(
        fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o600
    );

    store
        .record_usage(&UsageObservation {
            id: Id::new("usage_2").unwrap(),
            session: session.id.clone(),
            account: account.id,
            model: model.clone(),
            counters: Counters {
                input: 10,
                cache_read: 3,
                cache_write: 2,
                output: 6,
                reasoning: Some(1),
            },
            at_ms: 1_700_000_000_001,
        })
        .unwrap();
    let updated_report = exports::session_report(&store, &session.id).unwrap();
    assert_ne!(updated_report, report);
    let third = exports::write_session(&store, &session.id, &updated_report).unwrap();
    assert_eq!(first, third);
    assert_eq!(fs::read(&third).unwrap(), updated_report);
    assert_eq!(
        fs::metadata(&third).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn idle_export_writes_no_file_when_session_has_no_usage() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    fs::create_dir(base.join("work")).unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store
        .add_account(Provider::Claude, "Personal", "Max", 1)
        .unwrap();
    let model = ModelChoice {
        provider: Provider::Claude,
        id: Id::new("default").unwrap(),
        label: "Default".into(),
        mode: Mode::Fixed,
        resolved: None,
        effort: None,
        observed_at_ms: 1,
    };
    let session = store
        .create_session(&account.id, model, &base.join("work"), 2)
        .unwrap();

    assert!(
        exports::export_session(&store, &session.id)
            .unwrap()
            .is_none()
    );
    let exports_dir = store.root().join("exports");
    if exports_dir.exists() {
        assert!(fs::read_dir(&exports_dir).unwrap().next().is_none());
    }
}
