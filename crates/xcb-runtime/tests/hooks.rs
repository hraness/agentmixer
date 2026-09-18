use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use xcb_core::{
    Provider,
    models::{Mode, ModelChoice},
    session::{Session, State},
};
use xcb_runtime::{
    hooks::{self, Event, HookInput},
    private,
    store::Store,
};

fn script(root: &Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = root.join(name);
    fs::write(&path, body).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn input(workspace: &Path, event: Event) -> HookInput {
    let session = Session {
        id: "s_test".parse().unwrap(),
        account: "a_test".parse().unwrap(),
        model: ModelChoice {
            provider: Provider::Claude,
            id: "default".parse().unwrap(),
            label: "Default".into(),
            mode: Mode::Fixed,
            resolved: None,
            effort: None,
            observed_at_ms: 1,
        },
        workspace: workspace.to_string_lossy().into_owned(),
        title: "Test".into(),
        pane: "focus".parse().unwrap(),
        state: State::Idle,
        revision: 0,
        created_at_ms: 1,
        last_active_at_ms: 1,
    };
    HookInput::new(event, &session, State::Idle)
}

#[tokio::test]
async fn hooks_are_disabled_until_enabled_and_receive_no_inherited_secret() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let state = private::directory(&root.join("state")).unwrap();
    Store::open(&state).unwrap();
    let executable = script(
        &root,
        "env.sh",
        "#!/bin/sh\ncat >/dev/null\nprintf '%s' \"$CLAUDE_CODE_OAUTH_TOKEN:$HOME\"\n",
    );
    let hook = hooks::add(&state, Event::TurnStart, &executable, 2_000).unwrap();
    assert!(!hook.enabled);
    assert!(
        hooks::fire(&state, Event::TurnStart, &input(&root, Event::TurnStart))
            .await
            .unwrap()
            .is_empty()
    );
    hooks::set_enabled(&state, &hook.id, true).unwrap();
    let notices = hooks::fire(&state, Event::TurnStart, &input(&root, Event::TurnStart))
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    assert!(!notices[0].contains("secret"));
    assert!(notices[0].contains("hooks/home"), "{notices:?}");
}

#[tokio::test]
async fn changed_and_stalled_hooks_fail_closed_without_escaping_the_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let state = private::directory(&root.join("state")).unwrap();
    Store::open(&state).unwrap();
    let executable = script(&root, "hook.sh", "#!/bin/sh\nsleep 10\n");
    let hook = hooks::add(&state, Event::TurnEnd, &executable, 100).unwrap();
    hooks::set_enabled(&state, &hook.id, true).unwrap();
    let started = std::time::Instant::now();
    let notices = hooks::fire(&state, Event::TurnEnd, &input(&root, Event::TurnEnd))
        .await
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(notices[0].contains("timed out"), "{notices:?}");
    fs::write(&executable, "#!/bin/sh\necho changed\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let notices = hooks::fire(&state, Event::TurnEnd, &input(&root, Event::TurnEnd))
        .await
        .unwrap();
    assert!(notices[0].contains("changed"));
}
