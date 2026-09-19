use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use xcb_core::Provider;
use xcb_runtime::store::Store;
use xcb_runtime::{Error, digest, private};

fn state() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap().join("state");
    private::directory(&base).unwrap();
    (directory, base)
}

/// Staging files the shared crate writes mid-publish; none may survive a
/// finished operation, successful or aborted.
fn staged_residue(directory: &Path) -> Vec<String> {
    fs::read_dir(directory)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            name.starts_with(".publish-").then_some(name)
        })
        .collect()
}

#[test]
fn sqlite_sidecars_stay_valid_by_descriptor_while_the_store_is_live() {
    let (_temp, state) = state();
    let store = Store::open(&state).unwrap();
    store
        .add_account(Provider::Claude, "Personal", "Max", 1)
        .unwrap();
    // The WAL and SHM siblings belong to the live connection and mutate
    // constantly; custody is judged on the open descriptor, never a racing
    // path re-check. The rollback journal only exists inside a commit and is
    // tolerated either way.
    for suffix in ["xcb.sqlite", "xcb.sqlite-wal", "xcb.sqlite-shm"] {
        let file = private::open_file_maybe_vanished(&state.join(suffix), 1024 * 1024 * 1024)
            .unwrap_or_else(|error| panic!("{suffix}: {error}"))
            .unwrap_or_else(|| panic!("{suffix} should exist under a live store"));
        private::check_file(&file, 1024 * 1024 * 1024).unwrap();
    }
    private::open_file_maybe_vanished(&state.join("xcb.sqlite-journal"), 1024).unwrap();
}

#[test]
fn create_commits_exactly_once_under_a_no_clobber_race() {
    let (_temp, state) = state();
    let path = state.join("contended.json");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let writers: Vec<_> = (0..16)
        .map(|index| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                private::create(&path, format!("writer-{index}").as_bytes())
            })
        })
        .collect();
    let outcomes: Vec<_> = writers
        .into_iter()
        .map(|writer| writer.join().unwrap())
        .collect();
    assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    for outcome in &outcomes {
        if let Err(error) = outcome {
            assert!(
                matches!(error, Error::Io(io) if io.kind() == ErrorKind::AlreadyExists),
                "a losing create must surface AlreadyExists, got {error:?}"
            );
        }
    }
    assert!(
        String::from_utf8(private::read(&path, 1024).unwrap())
            .unwrap()
            .starts_with("writer-")
    );
    assert!(staged_residue(&state).is_empty());
}

#[test]
fn replace_with_a_stale_revision_conflicts_and_leaves_the_target() {
    let (_temp, state) = state();
    let path = state.join("cas.json");
    private::create(&path, b"current").unwrap();
    let error = private::replace(&path, b"incoming", &digest(b"stale")).unwrap_err();
    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert_eq!(private::read(&path, 1024).unwrap(), b"current");
    assert!(staged_residue(&state).is_empty());
}

#[test]
fn a_losing_concurrent_replace_conflicts_without_residue() {
    let (_temp, state) = state();
    for round in 0..8 {
        let path = state.join(format!("cas-race-{round}.json"));
        private::create(&path, b"base").unwrap();
        let expected = digest(b"base");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let writers: Vec<_> = (0..2)
            .map(|index| {
                let path = path.clone();
                let expected = expected.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    private::replace(&path, format!("writer-{index}").as_bytes(), &expected)
                })
            })
            .collect();
        let outcomes: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_ok()).count(),
            1,
            "round {round}"
        );
        let loser = outcomes.iter().find(|outcome| outcome.is_err()).unwrap();
        assert!(
            matches!(loser, Err(Error::Conflict(_))),
            "a losing replace must conflict, got {loser:?}"
        );
        let landed = private::read(&path, 1024).unwrap();
        assert!(
            landed == b"writer-0" || landed == b"writer-1",
            "the winner's bytes must land intact"
        );
        assert!(staged_residue(&state).is_empty());
    }
}

#[test]
fn a_mid_commit_identity_change_aborts_the_publish() {
    // While a replace is staged, a non-cooperative swap of the named inode
    // must abort the commit: the published bytes are then exactly one side's
    // content and no staging file survives.
    let (_temp, state) = state();
    for round in 0..8 {
        let path = state.join(format!("abort-{round}.json"));
        private::create(&path, b"base").unwrap();
        let swap = state.join(format!("swap-{round}"));
        fs::write(&swap, b"swapped").unwrap();
        fs::set_permissions(&swap, fs::Permissions::from_mode(0o600)).unwrap();
        let expected = digest(b"base");
        let writer_path = path.clone();
        let writer =
            std::thread::spawn(move || private::replace(&writer_path, &[b'A'; 4096], &expected));
        // The staged `.publish-*` temporary appears before the commit guard
        // runs; swapping the name while it is staged drives the guard into
        // the drift path. The deadline keeps a missed window from hanging.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let staged = fs::read_dir(&state).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".publish-")
            });
            if staged || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::yield_now();
        }
        fs::rename(&swap, &path).unwrap();
        let outcome = writer.join().unwrap();
        let landed = private::read(&path, 8192).unwrap();
        match outcome {
            Ok(()) => assert!(
                landed == b"swapped" || landed == vec![b'A'; 4096],
                "a committed target holds exactly one side's bytes"
            ),
            Err(error) => assert_eq!(
                landed, b"swapped",
                "an aborted publish never commits: {error:?}"
            ),
        }
        assert!(staged_residue(&state).is_empty());
    }
}

#[test]
fn custody_violations_map_to_private_state() {
    let (_temp, state) = state();
    // Group/other access on a file.
    let permissive = state.join("permissive.json");
    fs::write(&permissive, b"{}").unwrap();
    fs::set_permissions(&permissive, fs::Permissions::from_mode(0o644)).unwrap();
    let error = private::open_file(&permissive, 1024).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
    // A second name on the same inode.
    fs::set_permissions(&permissive, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&permissive, state.join("alias.json")).unwrap();
    let error = private::open_file(&permissive, 1024).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
    fs::remove_file(state.join("alias.json")).unwrap();
    // A regular file where a directory is required.
    let error = private::check_directory(&permissive).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
    // A group/other-accessible directory.
    let directory = state.join("open-dir");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    let error = private::check_directory(&directory).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
    // A symlink where the directory itself must be.
    let link = state.join("link-dir");
    symlink(&state, &link).unwrap();
    let error = private::check_directory(&link).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
    // A path routed through a symlinked parent.
    let routed = link.join("permissive.json");
    let error = private::check_directory(&routed).unwrap_err();
    assert!(matches!(error, Error::PrivateState), "{error:?}");
}
