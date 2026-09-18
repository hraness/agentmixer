use crate::{Error, Result};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

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
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.mode() & 0o077 != 0
        || path.canonicalize()? != path
    {
        return Err(Error::PrivateState);
    }
    Ok(path.to_owned())
}

pub fn check_file(file: &File, max: u64) -> Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > max
    {
        return Err(Error::PrivateState);
    }
    Ok(())
}

pub fn open_file(path: &Path, max: u64) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        )
        .open(path)?;
    check_file(&file, max)?;
    Ok(file)
}

pub fn read(path: &Path, max: usize) -> Result<Vec<u8>> {
    let file = open_file(path, max as u64)?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(xcb_core::Error::Limit("private file").into());
    }
    Ok(bytes)
}

pub fn create(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = check_directory(path.parent().ok_or(Error::PrivateState)?)?;
    let mut temp = tempfile::NamedTempFile::new_in(&parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(path)
        .map_err(|error| Error::Io(error.error))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn replace(path: &Path, bytes: &[u8], expected: &str) -> Result<()> {
    let parent = check_directory(path.parent().ok_or(Error::PrivateState)?)?;
    let current = read(path, 1024 * 1024)?;
    if crate::digest(&current) != expected {
        return Err(Error::Conflict("file revision changed"));
    }
    let mut temp = tempfile::NamedTempFile::new_in(&parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    if crate::digest(read(path, 1024 * 1024)?) != expected {
        return Err(Error::Conflict("file revision changed"));
    }
    temp.persist(path).map_err(|error| Error::Io(error.error))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
