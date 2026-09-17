use crate::{Error, Result, digest};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};
use xcb_core::MAX_TEXT_BYTES;

#[derive(Debug, Serialize)]
pub struct ReadResult {
    pub text: String,
    pub revision: String,
}
#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub kind: String,
}

pub struct Workspace {
    root: PathBuf,
    directory: File,
}

fn io(error: rustix::io::Errno) -> Error {
    std::io::Error::from(error).into()
}
fn components(path: &str) -> Result<Vec<&std::ffi::OsStr>> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return Err(xcb_core::Error::Invalid("workspace path").into());
    }
    Path::new(path)
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name),
            _ => Err(xcb_core::Error::Invalid("relative workspace path").into()),
        })
        .collect()
}
fn regular(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_TEXT_BYTES as u64 {
        return Err(xcb_core::Error::Invalid("workspace file").into());
    }
    Ok(())
}
fn read_at(parent: &File, name: &std::ffi::OsStr) -> Result<ReadResult> {
    let file = File::from(
        rustix::fs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io)?,
    );
    regular(&file)?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(xcb_core::Error::Limit("workspace file").into());
    }
    let revision = digest(&bytes);
    let text =
        String::from_utf8(bytes).map_err(|_| xcb_core::Error::Invalid("UTF-8 workspace file"))?;
    Ok(ReadResult { text, revision })
}

impl Workspace {
    pub fn open(root: &Path) -> Result<Self> {
        if !root.is_absolute() || root.canonicalize()? != root {
            return Err(Error::PrivateState);
        }
        let fd = rustix::fs::open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io)?;
        Ok(Self {
            root: root.to_owned(),
            directory: File::from(fd),
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn directory_at(&self, parts: &[&std::ffi::OsStr]) -> Result<File> {
        let mut fd = self.directory.try_clone()?;
        for part in parts {
            fd = File::from(
                rustix::fs::openat(
                    &fd,
                    *part,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(io)?,
            );
        }
        Ok(fd)
    }
    fn parent<'a>(&self, path: &'a str) -> Result<(File, &'a std::ffi::OsStr)> {
        let parts = components(path)?;
        let name = *parts.last().ok_or(xcb_core::Error::Invalid("file path"))?;
        Ok((self.directory_at(&parts[..parts.len() - 1])?, name))
    }
    pub fn read(&self, path: &str) -> Result<ReadResult> {
        let (parent, name) = self.parent(path)?;
        read_at(&parent, name)
    }
    pub fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<String> {
        if text.len() > MAX_TEXT_BYTES {
            return Err(xcb_core::Error::Limit("workspace write").into());
        }
        let (parent, name) = self.parent(path)?;
        let check = || -> Result<()> {
            match read_at(&parent, name) {
                Ok(current) if expected == Some(current.revision.as_str()) => Ok(()),
                Err(Error::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound && expected.is_none() =>
                {
                    Ok(())
                }
                Ok(_) => Err(Error::Conflict(
                    "workspace revision changed; read the current file first",
                )),
                Err(error) => Err(error),
            }
        };
        check()?;
        let temp = format!(".xcb-{}", uuid::Uuid::new_v4().simple());
        let mut file = File::from(
            rustix::fs::openat(
                &parent,
                temp.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(io)?,
        );
        let result = (|| {
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            check()?;
            rustix::fs::renameat(&parent, temp.as_str(), &parent, name).map_err(io)?;
            parent.sync_all()?;
            Ok(digest(text))
        })();
        if result.is_err() {
            let _ = rustix::fs::unlinkat(&parent, temp.as_str(), AtFlags::empty());
        }
        result
    }
    pub fn list(&self, path: &str) -> Result<Vec<Entry>> {
        let fd = if path == "." || path.is_empty() {
            self.directory.try_clone()?
        } else {
            self.directory_at(&components(path)?)?
        };
        let mut entries = Vec::new();
        for item in Dir::read_from(&fd).map_err(io)? {
            let item = item.map_err(io)?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name == "."
                || name == ".."
                || name.chars().any(char::is_control)
                || item.file_type() == FileType::Symlink
            {
                continue;
            }
            if entries.len() >= 512 {
                return Err(xcb_core::Error::Limit("directory entries").into());
            }
            entries.push(Entry {
                name,
                kind: if item.file_type() == FileType::Directory {
                    "directory"
                } else {
                    "file"
                }
                .to_owned(),
            });
        }
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }
    pub fn search(&self, path: &str, query: &str) -> Result<Value> {
        xcb_core::label(query, 256)?;
        let mut pending = vec![path.to_owned()];
        let mut matches = Vec::new();
        let mut visited = 0;
        let mut scanned = 0;
        let mut truncated = false;
        while let Some(directory) = pending.pop() {
            if visited >= 128 {
                truncated = true;
                break;
            }
            visited += 1;
            for entry in self.list(&directory)? {
                let relative = if directory == "." || directory.is_empty() {
                    entry.name.clone()
                } else {
                    format!("{directory}/{}", entry.name)
                };
                if entry.kind == "directory" {
                    if !matches!(entry.name.as_str(), ".git" | "node_modules" | "target")
                        && pending.len() < 128
                    {
                        pending.push(relative);
                    }
                } else {
                    scanned += 1;
                    if scanned > 512 {
                        truncated = true;
                        break;
                    }
                    let Ok(content) = self.read(&relative) else {
                        continue;
                    };
                    for (index, line) in content.text.lines().enumerate() {
                        if line.contains(query) {
                            matches.push(json!({"path":relative,"line":index + 1,"text":xcb_core::display_text(line, 512)}));
                            if matches.len() >= 64 {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }
                if truncated {
                    break;
                }
            }
            if truncated {
                break;
            }
        }
        Ok(json!({"matches":matches,"truncated":truncated}))
    }
    pub fn call(&self, name: &str, input: &Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PathArgs {
            path: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WriteArgs {
            path: String,
            text: String,
            expected_revision: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SearchArgs {
            path: String,
            query: String,
        }
        match name {
            "workspace_read" => {
                let args: PathArgs = serde_json::from_value(input.clone())?;
                Ok(serde_json::to_value(self.read(&args.path)?)?)
            }
            "workspace_list" => {
                let args: PathArgs = serde_json::from_value(input.clone())?;
                Ok(json!({"entries":self.list(&args.path)?}))
            }
            "workspace_write" => {
                let args: WriteArgs = serde_json::from_value(input.clone())?;
                Ok(
                    json!({"revision":self.write(&args.path, &args.text, args.expected_revision.as_deref())?}),
                )
            }
            "workspace_search" => {
                let args: SearchArgs = serde_json::from_value(input.clone())?;
                self.search(&args.path, &args.query)
            }
            _ => Err(Error::Unavailable("unknown workspace tool")),
        }
    }
}

pub fn descriptors() -> Vec<Value> {
    let path = json!({"type":"string","minLength":1,"maxLength":4096});
    [
        ("workspace_list", "List the bound workspace directory. Use . for its root.", json!({"path":path}), vec!["path"]),
        ("workspace_read", "Read one UTF-8 file and its revision inside the workspace.", json!({"path":path}), vec!["path"]),
        ("workspace_search", "Bounded literal text search inside the workspace.", json!({"path":path,"query":{"type":"string","minLength":1,"maxLength":256}}), vec!["path","query"]),
        ("workspace_write", "Atomically write a file with its current expectedRevision; null creates a new file.", json!({"path":path,"text":{"type":"string","maxLength":MAX_TEXT_BYTES},"expectedRevision":{"anyOf":[{"type":"string","maxLength":64},{"type":"null"}]}}), vec!["path","text","expectedRevision"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
