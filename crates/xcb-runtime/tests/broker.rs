use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use xcb_runtime::broker::Workspace;

#[test]
fn workspace_tools_are_descriptor_rooted_and_revision_checked() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("work");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("hello.txt"), "old").unwrap();
    let workspace = Workspace::open_with_coordination(&root, &base.join("coordination")).unwrap();
    let read = workspace.read("hello.txt").unwrap();
    assert_eq!(read.text, "old");
    workspace
        .write("hello.txt", "new", Some(&read.revision))
        .unwrap();
    assert!(
        workspace
            .write("hello.txt", "clobber", Some(&read.revision))
            .is_err()
    );
    assert!(workspace.write("hello.txt", "clobber", None).is_err());
    workspace.write("new.txt", "created", None).unwrap();
    assert_eq!(fs::read_to_string(root.join("hello.txt")).unwrap(), "new");
}

#[test]
fn workspace_symlinks_hardlinks_and_parent_paths_do_not_escape() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    fs::create_dir(base.join("work")).unwrap();
    fs::write(base.join("private.txt"), "private").unwrap();
    symlink(base.join("private.txt"), base.join("work/link")).unwrap();
    fs::hard_link(base.join("private.txt"), base.join("work/hard")).unwrap();
    let workspace =
        Workspace::open_with_coordination(&base.join("work"), &base.join("coordination")).unwrap();
    for path in ["../private.txt", "/private.txt", "link", "hard"] {
        assert!(workspace.read(path).is_err(), "{path}");
    }
    assert!(workspace.write("../private.txt", "bad", None).is_err());
    assert_eq!(
        fs::read_to_string(base.join("private.txt")).unwrap(),
        "private"
    );
}

#[test]
fn concurrent_workspace_writers_have_one_winner_and_preserve_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let root = base.join("work");
    fs::create_dir(&root).unwrap();
    for existing in [false, true] {
        let name = if existing { "existing" } else { "new" };
        if existing {
            fs::write(root.join(name), "original").unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(20));
        let workers: Vec<_> = (0..20)
            .map(|index| {
                let workspace =
                    Workspace::open_with_coordination(&root, &base.join("coordination")).unwrap();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let expected = existing.then(|| xcb_runtime::digest(b"original"));
                    barrier.wait();
                    workspace
                        .write(name, &format!("writer-{index}"), expected.as_deref())
                        .is_ok()
                })
            })
            .collect();
        let winners = workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>();
        assert_eq!(winners, 1);
        assert_eq!(
            fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o777,
            if existing { 0o755 } else { 0o600 }
        );
    }
}

#[test]
fn native_writes_wait_for_bun_and_node_locks_and_survive_owner_exit() {
    for runtime in ["bun", "node"] {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let root = base.join("work");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("shared"), "original").unwrap();
        let coordination = base.join("coordination");
        let ready = base.join("ready");
        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/cli/write-coordination.ts")
            .canonicalize()
            .unwrap();
        let script = r#"
            import { pathToFileURL } from 'node:url';
            import { writeFile } from 'node:fs/promises';
            const { withWorkspaceWriteLock } = await import(pathToFileURL(process.env.XCB_TEST_MODULE).href);
            await withWorkspaceWriteLock(process.env.XCB_TEST_WORKSPACE, process.env.XCB_TEST_COORDINATION, async () => {
                await writeFile(process.env.XCB_TEST_READY, 'ready');
                await new Promise(resolve => setTimeout(resolve, 30000));
            });
        "#;
        let mut command = std::process::Command::new(runtime);
        if runtime == "node" {
            command.args(["--experimental-strip-types", "--input-type=module"]);
        }
        let mut child = command
            .args(["-e", script])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &base)
            .env("XCB_TEST_MODULE", module)
            .env("XCB_TEST_WORKSPACE", &root)
            .env("XCB_TEST_COORDINATION", &coordination)
            .env("XCB_TEST_READY", &ready)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "{runtime} lock fixture failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let workspace = Workspace::open_with_coordination(&root, &coordination).unwrap();
        let expected = workspace.read("shared").unwrap().revision;
        let (sent, received) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let result = workspace.write("shared", "native", Some(&expected));
            sent.send(result).unwrap();
        });
        let pending = received.recv_timeout(std::time::Duration::from_millis(150));
        child.kill().unwrap();
        child.wait().unwrap();
        let completed = if pending.is_ok() {
            None
        } else {
            Some(
                received
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap(),
            )
        };
        writer.join().unwrap();
        assert!(
            matches!(pending, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
            "native bypassed the {runtime} writer"
        );
        completed.unwrap().unwrap();
        assert_eq!(fs::read_to_string(root.join("shared")).unwrap(), "native");
    }
}

#[test]
fn workspace_coordination_cannot_overlap_the_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    assert!(Workspace::open_with_coordination(&root, &root.join("locks")).is_err());
    assert!(Workspace::open_with_coordination(&root, root.parent().unwrap()).is_err());
}

#[test]
fn native_mcp_tool_calls_refuse_unknown_keys_and_tools() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().canonicalize().unwrap()).unwrap();
    assert!(
        workspace
            .call("shell", &serde_json::json!({"command":"true"}))
            .is_err()
    );
    assert!(
        workspace
            .call(
                "workspace_read",
                &serde_json::json!({"path":"a","extra":true})
            )
            .is_err()
    );
}

#[test]
fn observed_workspace_effects_distinguish_rejection_from_publication() {
    use serde_json::json;
    use xcb_core::policy::EffectState;
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let root = base.join("work");
    fs::create_dir(&root).unwrap();
    let workspace = Workspace::open_with_coordination(&root, &base.join("coordination")).unwrap();
    let (created, effects) = workspace.call_observed(
        "workspace_write",
        &json!({"path":"file","text":"created","expectedRevision":null}),
    );
    assert!(created.is_ok());
    assert_eq!(effects, EffectState::Settled);
    for arguments in [
        json!({"path":"file","text":"clobber","expectedRevision":null}),
        json!({"path":"file","text":"clobber","expectedRevision":"stale"}),
        json!({"path":"../escape","text":"bad","expectedRevision":null}),
        json!({"path":"file","text":false,"expectedRevision":null}),
    ] {
        let (rejected, effects) = workspace.call_observed("workspace_write", &arguments);
        assert!(rejected.is_err());
        assert_eq!(effects, EffectState::None);
    }
    assert_eq!(fs::read_to_string(root.join("file")).unwrap(), "created");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}
