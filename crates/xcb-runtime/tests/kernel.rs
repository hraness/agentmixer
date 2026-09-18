use std::{
    fs,
    sync::{Arc, mpsc::sync_channel},
    time::Duration,
};
use xcb_core::{
    Id, Provider,
    models::{Mode, ModelChoice},
    session::{Attachment, State},
    ui::{Intent, Update},
};
use xcb_runtime::{kernel, store::Store};

fn root() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("work")).unwrap();
    directory
}
fn choice() -> ModelChoice {
    ModelChoice {
        provider: Provider::Claude,
        id: Id::new("claude-fable-5-1").unwrap(),
        label: "Fable 5.1".into(),
        mode: Mode::Fixed,
        resolved: None,
        effort: Some(Id::new("max").unwrap()),
        observed_at_ms: 1,
    }
}
fn image() -> Attachment {
    Attachment {
        digest: "a".repeat(64),
        media_type: "image/png".into(),
        bytes: 512,
        width: 16,
        height: 16,
    }
}

/// A submission the kernel rejects must hand the complete draft — text and
/// attachments — back to the composer instead of losing it to history.
#[tokio::test]
async fn a_rejected_submission_returns_the_full_draft() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    // No accounts exist, so every submission is rejected before it can run.
    let store = Arc::new(Store::open(&base.join("state")).unwrap());
    let (updates, display) = sync_channel(256);
    let (commands, input) = sync_channel(32);
    let serve = tokio::spawn(kernel::serve(
        store,
        base.join("work"),
        None,
        input,
        updates,
    ));

    commands
        .send(Intent::Submit {
            text: "do the thing".into(),
            attachments: vec![image()],
        })
        .unwrap();
    let collected = tokio::task::spawn_blocking(move || {
        let mut draft = None;
        let mut notice = None;
        for _ in 0..64 {
            match display.recv_timeout(Duration::from_secs(10)) {
                Ok(Update::Draft { text, attachments }) => draft = Some((text, attachments)),
                Ok(Update::Notice(text)) => notice = Some(text),
                Ok(_) => (),
                Err(error) => panic!("update channel failed: {error}"),
            }
            if draft.is_some() && notice.is_some() {
                break;
            }
        }
        (draft, notice)
    })
    .await
    .unwrap();
    drop(commands);
    serve.await.unwrap().unwrap();

    let (text, attachments) = collected
        .0
        .expect("a rejected submission returns the draft");
    assert_eq!(text, "do the thing");
    assert_eq!(attachments, vec![image()]);
    assert!(
        collected
            .1
            .expect("the rejection is explained")
            .contains("account")
    );
}

/// A session with a live run owned by a sibling terminal is active parallel
/// work: it renders remote, never "needs recovery".
#[tokio::test]
async fn a_run_owned_by_a_sibling_terminal_is_remote_not_recovery() {
    let dir = root();
    let base = dir.path().canonicalize().unwrap();
    let path = base.join("state");
    // Terminal one opens the state root and starts a run on the session.
    let owner = Store::open(&path).unwrap();
    let account = owner
        .add_account(Provider::Claude, "Personal", "Max", 1)
        .unwrap();
    let session = owner
        .create_session(&account.id, choice(), &base.join("work"), 2)
        .unwrap();
    let run = owner.prepare_run(&session.id, session.revision, 3).unwrap();
    assert_eq!(run.phase, "prepared");

    // Terminal two opens the same root and views the same session.
    let viewer = Arc::new(Store::open(&path).unwrap());
    let (updates, display) = sync_channel(256);
    let (commands, input) = sync_channel(32);
    let serve = tokio::spawn(kernel::serve(
        viewer,
        base.join("work"),
        Some(session.id.clone()),
        input,
        updates,
    ));

    let seen = tokio::task::spawn_blocking(move || {
        for _ in 0..64 {
            match display.recv_timeout(Duration::from_secs(10)) {
                Ok(Update::View(view)) => return Some((view.remote_active, view.state)),
                Ok(_) => (),
                Err(error) => panic!("update channel failed: {error}"),
            }
        }
        None
    })
    .await
    .unwrap();
    drop(commands);
    serve.await.unwrap().unwrap();

    let (remote_active, state) = seen.expect("a view is always published");
    assert!(remote_active, "a live foreign-owned run is remote work");
    assert_eq!(state, State::Working, "remote work is not a recovery case");
}
