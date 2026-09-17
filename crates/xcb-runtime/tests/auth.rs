use xcb_core::Provider;
use xcb_runtime::{auth, private, store::Store};

#[test]
fn importing_one_explicit_legacy_token_preserves_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let source = private::directory(&base.join("legacy")).unwrap();
    let fixture = b"sk-ant-oat01-synthetic_fixture_not_a_real_token";
    private::create(&source.join("claude-oauth-token"), fixture).unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = auth::import_agentmixer_token(&store, &source, "Legacy").unwrap();
    assert!(auth::has_token(&store, &account).unwrap());
    assert_eq!(
        private::read(&source.join("claude-oauth-token"), 2048).unwrap(),
        fixture
    );
    let other = store
        .add_account(Provider::Claude, "Other", "Max", 1)
        .unwrap();
    assert!(!auth::has_token(&store, &other.id).unwrap());
    assert!(auth::store_token(&store, &account, fixture).is_err());
}
