//! Custody primitives for xcb's private state tree.
//!
//! Ownership, kind, mode, link-count, and atomic-publication checks are
//! delegated to the shared `local-custody` crate. What stays local is xcb's
//! own contract: the path grammar (absolute, no `.`/`..` components),
//! recursive `0700` directory creation, advisory locking, file-identity
//! pinning, byte bounds, and the `Error` taxonomy callers match on.

use crate::{Error, Result};
use local_custody::{
    CustodyError, ObjectKind, OwnedPathOptions, assert_owned_fd, atomic_publish,
    atomic_publish_guarded, ensure_private_directory,
};
use std::cell::RefCell;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};

/// Translate a custody-contract failure into xcb's error taxonomy. Violations
/// of the owned/private contract (symlinks, wrong kind, foreign owner,
/// permissive mode, extra links, size bounds, noncanonical paths) are the
/// same class `check_directory`/`check_file` always reported: `PrivateState`.
/// Genuine filesystem failures keep `Io`; a missing object keeps the
/// `NotFound` kind that load-dedup callers match; the publish-name grammar is
/// caller input and maps to `Invalid`; content drift is a `Conflict`.
fn map_custody_error(error: CustodyError) -> Error {
    match error.code.as_str() {
        "not-found" => Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            error.message,
        )),
        // The `replace` commit guard reports its rejection under this code;
        // the precise error is recovered from the slot beside the guard.
        "conflict" => Error::Conflict("file revision changed"),
        // Content drift observed across a guarded read.
        "changed" | "shrunk" => Error::Conflict("file changed during read"),
        // Publication names are caller input, not a custody property.
        "empty" | "too-long" | "whitespace" | "separator" | "initial" | "character" | "path" => {
            xcb_core::Error::Invalid("file name").into()
        }
        "symlink"
        | "noncanonical"
        | "noncanonical-parent"
        | "relative"
        | "root"
        | "not-directory"
        | "not-file"
        | "kind"
        | "kind-mismatch"
        | "mode"
        | "mode-mismatch"
        | "owner"
        | "owner-only"
        | "links"
        | "capacity"
        | "minimum"
        | "unsupported"
        | "invalid"
        | "tty"
        | "utf8"
        | "limit" => Error::PrivateState,
        // Everything else is an underlying filesystem operation failure
        // (open/stat/read/write/stage/fsync/link/rename/create/chmod/dup/…).
        _ => Error::Io(std::io::Error::other(error.message)),
    }
}

/// The file-custody contract every private file must satisfy: an owned
/// regular file with a single name, owner-only permissions, within `max`
/// bytes. `assert_owned_fd` fstats the descriptor, so a hot sibling (WAL,
/// SHM) is judged by the object actually opened, never a re-resolved path.
fn owned_file(max: u64) -> OwnedPathOptions {
    OwnedPathOptions {
        kind: Some(ObjectKind::File),
        owner_only: true,
        maximum_bytes: Some(max),
        links: Some(1),
        ..Default::default()
    }
}

/// Resolve a publish target the way `create`/`replace` always did: the
/// parent must already be a checked private directory, and the leaf name —
/// now also bound by the crate's `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$`
/// publication grammar — is handed to the atomic publish call.
fn publish_target(path: &Path) -> Result<(PathBuf, &str)> {
    let parent = check_directory(path.parent().ok_or(Error::PrivateState)?)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::from(xcb_core::Error::Invalid("file name")))?;
    Ok((parent, name))
}

pub fn default_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("XCB_STATE") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME").ok_or(Error::PrivateState)?;
    Ok(PathBuf::from(home).join(".local/share/xcb"))
}

pub fn directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(Error::PrivateState);
    }
    match fs::symlink_metadata(path) {
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Creation stays local: every intermediate component gets mode
            // 0700, not just the leaf.
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)?;
        }
        Err(error) => return Err(error.into()),
    }
    check_directory(path)
}

pub fn check_directory(path: &Path) -> Result<PathBuf> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(Error::PrivateState);
    }
    // The crate's private-directory contract: canonical parent, the path
    // equal to its own realpath, a real directory owned by this uid, and
    // `mode & 0o077 == 0`. A path that vanishes between the lstat above and
    // this call may be recreated here — the outcome is still a checked
    // private directory.
    ensure_private_directory(path).map_err(map_custody_error)?;
    Ok(path.to_owned())
}

pub fn check_file(file: &File, max: u64) -> Result<()> {
    assert_owned_fd(file.as_raw_fd(), &owned_file(max)).map_err(map_custody_error)?;
    Ok(())
}

pub fn open_file(path: &Path, max: u64) -> Result<File> {
    // A racing private::replace can unlink the name between open and fstat:
    // the descriptor then names an inode with no surviving link. Re-resolve
    // the path — it now names the replacement, or no longer exists. A bounded
    // retry keeps a pathological rename storm an honest failure.
    for _ in 0..4 {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK
                    | rustix::fs::OFlags::CLOEXEC)
                    .bits() as i32,
            )
            .open(path)?;
        if file.metadata()?.nlink() == 0 {
            continue;
        }
        check_file(&file, max)?;
        return Ok(file);
    }
    Err(Error::PrivateState)
}

/// Open a private file whose name a cooperating peer may retire concurrently —
/// SQLite deletes its journal sidecars when the last connection closes, which
/// can race a sibling's startup scan outside the initialization lock. A
/// descriptor whose link count reached zero no longer has any name to check:
/// it is treated exactly like an absent file. A surviving name still gets the
/// full private-file check, including the single-name requirement.
pub fn open_file_maybe_vanished(path: &Path, max: u64) -> Result<Option<File>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        )
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.nlink() == 0 {
        return Ok(None);
    }
    check_file(&file, max)?;
    Ok(Some(file))
}

/// Read through the custody-checked open descriptor. This deliberately does
/// not use the crate's `stable_read`: callers match `io::ErrorKind::NotFound`
/// on the open error (which a `CustodyError` cannot express), and xcb
/// tolerates a concurrent `replace` mid-read — the descriptor's inode stays
/// coherent — where `stable_read`'s post-read identity check fails closed.
pub fn read(path: &Path, max: usize) -> Result<Vec<u8>> {
    let file = open_file(path, max as u64)?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(xcb_core::Error::Limit("private file").into());
    }
    Ok(bytes)
}

pub(crate) fn lock(file: &File) -> Result<()> {
    let started = std::time::Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock)
                if started.elapsed() < std::time::Duration::from_secs(5) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(Error::Conflict(
                    "private state is busy; retry the operation",
                ));
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

pub(crate) fn same_file(path: &Path, file: &File) -> Result<()> {
    let opened = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !named.is_file() || opened.dev() != named.dev() || opened.ino() != named.ino() {
        return Err(Error::Conflict("file identity changed"));
    }
    Ok(())
}

pub fn create(path: &Path, bytes: &[u8]) -> Result<()> {
    let (parent, name) = publish_target(path)?;
    // create_once commits with link(2): an existing name fails the commit
    // atomically instead of a check-then-rename window, and the crate fsyncs
    // the directory after the commit exactly like the code this replaces.
    let outcome = atomic_publish(&parent, name, bytes, true).map_err(map_custody_error)?;
    if !outcome.created {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        )));
    }
    Ok(())
}

pub fn replace(path: &Path, bytes: &[u8], expected: &str) -> Result<()> {
    let (parent, name) = publish_target(path)?;
    let current_file = open_file(path, 1024 * 1024)?;
    lock(&current_file)?;
    same_file(path, &current_file)?;
    let current = read(path, 1024 * 1024)?;
    if crate::digest(&current) != expected {
        return Err(Error::Conflict("file revision changed"));
    }
    // The flock on the current inode stays held across the guarded publish:
    // a sibling replace on the same inode serializes here or fails busy,
    // while the commit guard re-verifies digest and identity immediately
    // before the rename — the same commit-time race detection as before.
    // The guard reports through a slot so the exact xcb error survives the
    // crate's `CustodyError` channel.
    let failure: RefCell<Option<Error>> = RefCell::new(None);
    let published = {
        let guard = |_: &Path| -> std::result::Result<(), CustodyError> {
            let verdict = (|| -> Result<()> {
                if crate::digest(read(path, 1024 * 1024)?) != expected {
                    return Err(Error::Conflict("file revision changed"));
                }
                same_file(path, &current_file)
            })();
            verdict.map_err(|error| {
                *failure.borrow_mut() = Some(error);
                CustodyError {
                    code: "conflict".to_owned(),
                    message: "commit guard rejected".to_owned(),
                }
            })
        };
        atomic_publish_guarded(&parent, name, bytes, &guard)
    };
    published.map_err(|error| {
        failure
            .into_inner()
            .unwrap_or_else(|| map_custody_error(error))
    })?;
    Ok(())
}
