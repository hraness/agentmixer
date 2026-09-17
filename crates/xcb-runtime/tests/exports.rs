use std::{fs, os::unix::fs::PermissionsExt};
use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    usage::Counters,
};
use xcb_runtime::{
    exports,
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
