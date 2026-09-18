use crate::{Error, Result, digest, private};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, TryLockError},
    time::{Duration, Instant},
};

static LOCAL_WRITER: Mutex<()> = Mutex::new(());
const WAIT: Duration = Duration::from_secs(5);

pub(crate) struct WriteLock {
    _connection: Connection,
    _local: MutexGuard<'static, ()>,
}

pub(crate) fn default_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("XCB_COORDINATION_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let home = std::env::var_os("HOME").ok_or(Error::PrivateState)?;
    Ok(PathBuf::from(home).join(".local/share/xcb-coordination"))
}

impl WriteLock {
    pub(crate) fn acquire(workspace: &Path, directory: &Path) -> Result<Self> {
        if !directory.is_absolute()
            || directory.starts_with(workspace)
            || workspace.starts_with(directory)
        {
            return Err(Error::Conflict(
                "write coordination must be outside the workspace",
            ));
        }
        let started = Instant::now();
        let local = loop {
            match LOCAL_WRITER.try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::WouldBlock) if started.elapsed() < WAIT => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(Error::Conflict("workspace writer is busy; retry"));
                }
                Err(TryLockError::Poisoned(_)) => {
                    return Err(Error::Conflict("workspace writer lock poisoned"));
                }
            }
        };
        let directory = private::directory(directory)?;
        let workspace = workspace.to_str().ok_or(Error::PrivateState)?;
        let path = directory.join(format!("{}.sqlite", digest(workspace.as_bytes())));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC).bits() as i32,
            )
            .open(&path)
        {
            Ok(file) => file.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        let before = private::open_file(&path, 64 * 1024)?.metadata()?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(WAIT.saturating_sub(started.elapsed()))?;
        let journal: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal.eq_ignore_ascii_case("delete") {
            return Err(Error::Conflict("workspace coordination format changed"));
        }
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let after = fs::symlink_metadata(&path)?;
        if !after.is_file()
            || before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.uid() != after.uid()
            || after.mode() & 0o077 != 0
            || after.nlink() != 1
        {
            return Err(Error::PrivateState);
        }
        Ok(Self {
            _connection: connection,
            _local: local,
        })
    }
}
