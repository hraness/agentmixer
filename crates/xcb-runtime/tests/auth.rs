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
    auth::store_token(&store, &account, fixture).unwrap();
}

#[test]
fn tokens_rotate_atomically_and_invalid_input_preserves_the_current_credential() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store
        .add_account(Provider::Claude, "Test", "Test", 1)
        .unwrap();
    let previous = b"sk-ant-oat01-previous_synthetic_fixture_not_real";
    let rotated = b"sk-ant-oat01-rotated_synthetic_fixture_not_real";
    auth::store_token(&store, &account.id, previous).unwrap();
    auth::store_token(&store, &account.id, rotated).unwrap();
    let path = store
        .account_root(&account.id)
        .unwrap()
        .join("subscription-token");
    assert_eq!(private::read(&path, 2048).unwrap(), rotated);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(auth::store_token(&store, &account.id, b"invalid").is_err());
    assert_eq!(private::read(&path, 2048).unwrap(), rotated);
}

#[test]
fn credential_rotation_rejects_symlink_targets() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store
        .add_account(Provider::Claude, "Test", "Test", 1)
        .unwrap();
    let sibling = private::directory(&base.join("sibling")).unwrap();
    let target = sibling.join("another-account-token");
    let previous = b"sk-ant-oat01-previous_synthetic_fixture_not_real";
    private::create(&target, previous).unwrap();
    let path = store
        .account_root(&account.id)
        .unwrap()
        .join("subscription-token");
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(
        auth::store_token(
            &store,
            &account.id,
            b"sk-ant-oat01-rotated_synthetic_fixture_not_real"
        )
        .is_err()
    );
    assert_eq!(private::read(&target, 2048).unwrap(), previous);
}
