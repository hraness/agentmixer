use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use xcb_core::{Id, Provider};
use xcb_core::models::{Mode, ModelChoice};
use xcb_core::session::{Message, Role};
use xcb_runtime::store::Store;

fn root() -> tempfile::TempDir { let directory = tempfile::tempdir().unwrap(); fs::create_dir(directory.path().join("work")).unwrap(); directory }
fn choice() -> ModelChoice {
    ModelChoice { provider: Provider::Claude, id: Id::new("claude-fable-5-1").unwrap(), label: "Fable 5.1".into(), mode: Mode::Fixed, effort: Some(Id::new("max").unwrap()), observed_at_ms: 1 }
}

#[test]
fn accounts_are_separate_and_labels_cannot_override_a_credential_path() {
    let dir = root();
    let path = dir.path().canonicalize().unwrap().join("state");
    let store = Store::open(&path).unwrap();
    let a = store.add_account(Provider::Claude, "Personal", "Max", 1).unwrap();
    let b = store.add_account(Provider::Claude, "Work", "Team", 1).unwrap();
    assert_ne!(a.id, b.id);
    assert_ne!(store.account_root(&a.id).unwrap(), store.account_root(&b.id).unwrap());
    assert_eq!(store.accounts().unwrap().len(), 2);
    assert!(store.add_account(Provider::Claude, "\u{1b}[2J", "Max", 1).is_err());
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
}

#[test]
fn private_state_rejects_symlinks_and_public_permissions() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    drop(store);
    symlink(base.join("state"), base.join("link")).unwrap();
    assert!(Store::open(&base.join("link")).is_err());
    fs::set_permissions(base.join("state"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Store::open(&base.join("state")).is_err());
}

#[test]
fn revision_checked_messages_persist_across_reopen() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    let path = base.join("state");
    let store = Store::open(&path).unwrap();
    let account = store.add_account(Provider::Claude, "Personal", "Max", 1).unwrap();
    let session = store.create_session(&account.id, choice(), &base.join("work"), 2).unwrap();
    let message = Message { id: Id::new("m1").unwrap(), role: Role::User, text: "hello".into(), attachments: vec![], at_ms: 3 };
    let revised = store.append_message(&session.id, session.revision, &message).unwrap();
    assert_eq!(revised.revision, session.revision + 1);
    assert!(store.append_message(&session.id, session.revision, &message).is_err());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.messages(&session.id, 100).unwrap()[0].text, "hello");
}

#[test]
fn a_prepared_run_keeps_exclusive_account_custody_after_restart() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    let path = base.join("state");
    let store = Store::open(&path).unwrap();
    let account = store.add_account(Provider::Claude, "Personal", "Max", 1).unwrap();
    let session = store.create_session(&account.id, choice(), &base.join("work"), 2).unwrap();
    let run = store.prepare_run(&session.id, session.revision, 3).unwrap();
    assert!(store.prepare_run(&session.id, run.revision, 4).is_err());
    assert!(store.remove_session(&session.id).is_err());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert!(store.prepare_run(&session.id, run.revision, 1_000_000).is_err());
    assert_eq!(store.unsettled_runs().unwrap().len(), 1);
}

#[test]
fn pruning_never_erases_an_active_session() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    let store = Store::open(&base.join("state")).unwrap();
    let account = store.add_account(Provider::Claude, "Personal", "Max", 1).unwrap();
    let idle = store.create_session(&account.id, choice(), &base.join("work"), 2).unwrap();
    let active = store.create_session(&account.id, choice(), &base.join("work"), 2).unwrap();
    store.prepare_run(&active.id, active.revision, 3).unwrap();
    assert_eq!(store.prune_candidates(10, 100).unwrap(), vec![idle.id.clone()]);
    assert!(store.remove_session(&idle.id).unwrap());
    assert!(store.session(&active.id).unwrap().is_some());
}
