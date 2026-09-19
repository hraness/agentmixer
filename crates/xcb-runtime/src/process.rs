use crate::{Error, Result, digest, private};
use rustix::process::{Pid, Signal, kill_process_group, test_kill_process_group};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};
use xcb_core::{MAX_JSON_BYTES, Provider};

pub fn environment(home: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        (
            "PATH".into(),
            "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into(),
        ),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("NO_COLOR".into(), "1".into()),
        (
            "XDG_CONFIG_HOME".into(),
            home.join(".config").to_string_lossy().into_owned(),
        ),
        (
            "XDG_DATA_HOME".into(),
            home.join(".local/share").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CACHE_HOME".into(),
            home.join(".cache").to_string_lossy().into_owned(),
        ),
        (
            "TMPDIR".into(),
            home.join("tmp").to_string_lossy().into_owned(),
        ),
    ])
}

fn executable_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        )
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || ![0, rustix::process::getuid().as_raw()].contains(&meta.uid())
        || meta.mode() & 0o7000 != 0
        || meta.mode() & 0o022 != 0
        || meta.mode() & 0o111 == 0
        || meta.len() == 0
        || meta.len() > 512 * 1024 * 1024
    {
        return Err(Error::Unavailable(
            "executable ownership, permissions, or size is invalid",
        ));
    }
    Ok(file)
}

fn repair_executable_mode(path: &Path) -> Result<bool> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        )
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != rustix::process::getuid().as_raw()
        || meta.nlink() != 1
        || meta.mode() & 0o7000 != 0
        || meta.mode() & 0o111 == 0
        || meta.mode() & 0o022 == 0
        || meta.len() == 0
        || meta.len() > 512 * 1024 * 1024
    {
        return Ok(false);
    }
    // Tighten writable bits without exposing a private executable to more users.
    file.set_permissions(fs::Permissions::from_mode(meta.mode() & 0o777 & !0o022))?;
    Ok(true)
}

fn wrapper_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC)
                .bits() as i32,
        )
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || ![0, rustix::process::getuid().as_raw()].contains(&meta.uid())
        || meta.mode() & 0o022 != 0
        || meta.mode() & 0o111 == 0
        || (meta.mode() & 0o7000 != 0 && meta.uid() != 0)
        || meta.len() == 0
        || meta.len() > 8 * 1024 * 1024
    {
        return Err(Error::Unavailable(
            "sandbox wrapper ownership, permissions, or size is invalid",
        ));
    }
    Ok(file)
}

fn digest_file(mut file: File, limit: u64) -> Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > limit {
            return Err(Error::Unavailable("executable size changed"));
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

pub fn executable_digest(path: &Path) -> Result<String> {
    digest_file(executable_file(path)?, 512 * 1024 * 1024)
}

pub fn wrapper_digest(path: &Path) -> Result<String> {
    digest_file(wrapper_file(path)?, 8 * 1024 * 1024)
}

pub fn discover(provider: Provider, explicit: Option<&Path>) -> Result<PathBuf> {
    let override_name = format!("XCB_{}", provider.as_str().to_uppercase());
    if let Some(path) = explicit
        .map(Path::to_owned)
        .or_else(|| std::env::var_os(override_name).map(PathBuf::from))
    {
        if !path.is_absolute() {
            return Err(Error::Unavailable("provider path must be absolute"));
        }
        let path = path.canonicalize()?;
        if executable_file(&path).is_err() && !repair_executable_mode(&path)? {
            return Err(Error::Unavailable(
                "executable ownership, permissions, or size is invalid",
            ));
        }
        executable_file(&path)?;
        return Ok(path);
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).take(128)
    {
        let candidate = directory.join(provider.as_str());
        if let Ok(path) = candidate.canonicalize()
            && (executable_file(&path).is_ok()
                || (repair_executable_mode(&path).unwrap_or(false)
                    && executable_file(&path).is_ok()))
        {
            return Ok(path);
        }
    }
    Err(Error::Unavailable(
        "provider binary not found; specify its XCB provider path",
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pin {
    pub provider: Provider,
    pub executable: PathBuf,
    pub sha256: String,
    pub version: String,
    pub host_sha256: String,
    pub observed_at_ms: u64,
}
impl Pin {
    pub fn verify(&self) -> Result<()> {
        if self.executable.canonicalize()? != self.executable
            || executable_digest(&self.executable)? != self.sha256
            || executable_digest(&std::env::current_exe()?.canonicalize()?)? != self.host_sha256
        {
            return Err(Error::Unavailable("runtime changed; run xcb doctor again"));
        }
        Ok(())
    }
    pub fn load(root: &Path, provider: Provider) -> Result<Self> {
        let pin: Self = serde_json::from_slice(&private::read(
            &root.join("providers").join(format!("{provider}.json")),
            16 * 1024,
        )?)?;
        if pin.provider != provider {
            return Err(Error::Unavailable("provider pin mismatch"));
        }
        pin.verify()?;
        Ok(pin)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        let directory = private::directory(&root.join("providers"))?;
        let path = directory.join(format!("{}.json", self.provider));
        let bytes = serde_json::to_vec_pretty(self)?;
        match private::read(&path, 16 * 1024) {
            Ok(old) => private::replace(&path, &bytes, &digest(old)),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                private::create(&path, &bytes)
            }
            Err(error) => Err(error),
        }
    }
    pub fn snapshot(&self, directory: &Path) -> Result<PathBuf> {
        self.verify()?;
        let path = directory.join("provider");
        let source = executable_file(&self.executable)?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o500)
            .custom_flags((rustix::fs::OFlags::CLOEXEC).bits() as i32)
            .open(&path)?;
        std::io::copy(&mut source.take(512 * 1024 * 1024 + 1), &mut target)?;
        target.flush()?;
        target.sync_all()?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o500))?;
        if executable_digest(&path)? != self.sha256 {
            return Err(Error::Unavailable("executable snapshot changed"));
        }
        Ok(path)
    }
}

fn parse_version(provider: Provider, output: &str) -> Result<&str> {
    let version = match provider {
        Provider::Claude => output.strip_suffix(" (Claude Code)").unwrap_or(output),
        Provider::Devin => output
            .strip_prefix("devin ")
            .and_then(|text| text.split_once(" (").map(|pair| pair.0))
            .ok_or(Error::Protocol("Devin version"))?,
        Provider::Codex => output
            .strip_prefix("codex-cli ")
            .ok_or(Error::Protocol("Codex version"))?,
    };
    // Metadata discovery accepts official prerelease Codex builds. This does
    // not admit task execution: exact provider qualification remains separate.
    let stable = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$";
    let codex = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$";
    let pattern = if provider == Provider::Codex {
        codex
    } else {
        stable
    };
    if version.len() > 64
        || !regex::Regex::new(pattern)
            .expect("static version grammar")
            .is_match(version)
    {
        return Err(Error::Protocol("version shape"));
    }
    Ok(version)
}

pub async fn inspect(provider: Provider, explicit: Option<&Path>, home: &Path) -> Result<Pin> {
    let executable = discover(provider, explicit)?;
    let sha256 = executable_digest(&executable)?;
    let mut command = Command::new(&executable);
    command
        .arg("--version")
        .env_clear()
        .envs(environment(home))
        .current_dir(home);
    let bytes = capture(command, 1024, Duration::from_secs(10)).await?;
    let output = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Protocol("version encoding"))?
        .trim();
    let version = parse_version(provider, output)?;
    if executable_digest(&executable)? != sha256 {
        return Err(Error::Unavailable("runtime changed during inspection"));
    }
    Ok(Pin {
        provider,
        executable,
        sha256,
        version: version.to_owned(),
        host_sha256: executable_digest(&std::env::current_exe()?.canonicalize()?)?,
        observed_at_ms: crate::now_ms(),
    })
}

pub struct StreamProcess {
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: BufReader<ChildStdout>,
    child: Child,
    group: Option<Pid>,
    stderr: JoinHandle<bool>,
}
impl StreamProcess {
    pub fn spawn(mut command: Command) -> Result<Self> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().map_err(Error::LaunchNotStarted)?;
        let pid = child
            .id()
            .filter(|pid| *pid > 1)
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(Pid::from_raw)
            .ok_or(Error::Protocol("child process identity"))?;
        let stdin = child.stdin.take().ok_or(Error::Protocol("child stdin"))?;
        let stdout = BufReader::new(child.stdout.take().ok_or(Error::Protocol("child stdout"))?);
        let stderr = child.stderr.take().ok_or(Error::Protocol("child stderr"))?;
        let stderr = tokio::spawn(async move { drain(stderr, 1024 * 1024).await.is_ok() });
        Ok(Self {
            stdin,
            stdout,
            child,
            group: Some(pid),
            stderr,
        })
    }
    pub fn pid(&self) -> u32 {
        self.group
            .expect("owned process group")
            .as_raw_nonzero()
            .get() as u32
    }
    pub async fn send(&mut self, value: &serde_json::Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(Error::Protocol("input frame limit"));
        }
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }
    pub async fn frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut bytes = Vec::new();
        loop {
            let available = self.stdout.fill_buf().await?;
            if available.is_empty() {
                return if bytes.is_empty() {
                    Ok(None)
                } else {
                    Err(Error::Protocol("incomplete final frame"))
                };
            }
            let end = available.iter().position(|byte| *byte == b'\n');
            let count = end.map_or(available.len(), |end| end + 1);
            if bytes.len() + count > MAX_JSON_BYTES {
                return Err(Error::Protocol("output frame limit"));
            }
            bytes.extend_from_slice(&available[..count]);
            self.stdout.consume(count);
            if end.is_some() {
                return Ok(Some(bytes));
            }
        }
    }
    fn signal(&self) {
        if let Some(group) = self.group {
            let _ = kill_process_group(group, Signal::KILL);
        }
    }
    pub async fn join(&mut self) -> bool {
        self.signal();
        let Some(group) = self.group.take() else {
            return false;
        };
        let joined = tokio::time::timeout(Duration::from_secs(5), async {
            let _ = self.stdin.shutdown().await;
            let (exit, stdout, stderr) = tokio::join!(
                self.child.wait(),
                drain(&mut self.stdout, 16 * 1024 * 1024),
                &mut self.stderr
            );
            exit.is_ok() && stdout.is_ok() && matches!(stderr, Ok(true))
        })
        .await
        .unwrap_or(false);
        joined && group_absent(group).await
    }
}
impl Drop for StreamProcess {
    fn drop(&mut self) {
        self.signal();
        self.stderr.abort();
    }
}

async fn group_absent(group: Pid) -> bool {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if test_kill_process_group(group) == Err(rustix::io::Errno::SRCH) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or(false)
}

pub fn prove_process_group_absent(pid: u32) -> Result<()> {
    let group = i32::try_from(pid)
        .ok()
        .and_then(Pid::from_raw)
        .ok_or(Error::Unavailable("process group id is invalid"))?;
    match test_kill_process_group(group) {
        Ok(()) => Err(Error::Conflict("process group is still present")),
        Err(rustix::io::Errno::SRCH) => Ok(()),
        Err(_) => Err(Error::Unavailable("process group probe failed")),
    }
}

async fn drain(mut source: impl AsyncRead + Unpin, max: usize) -> Result<()> {
    let mut buffer = [0u8; 8192];
    let mut count = 0;
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        count += read;
        if count > max {
            return Err(Error::Protocol("stream output limit"));
        }
    }
}

pub async fn capture_with_input(
    mut command: Command,
    input: &[u8],
    max: usize,
    deadline: Duration,
) -> Result<Vec<u8>> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn()?;
    let group = child
        .id()
        .filter(|pid| *pid > 1)
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(Pid::from_raw)
        .ok_or(Error::Protocol("child process identity"))?;
    let mut stdin = child.stdin.take().ok_or(Error::Protocol("child stdin"))?;
    let mut stdout = child.stdout.take().ok_or(Error::Protocol("child stdout"))?;
    let stderr = child.stderr.take().ok_or(Error::Protocol("child stderr"))?;
    let result = tokio::time::timeout(deadline, async {
        stdin.write_all(input).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let output = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(max as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > max {
                return Err(Error::Protocol("command output limit"));
            }
            Ok(bytes)
        };
        let (bytes, _) = tokio::try_join!(output, drain(stderr, 1024 * 1024))?;
        Ok::<_, Error>(bytes)
    })
    .await;
    let timed_out = result.is_err();
    if timed_out {
        let _ = kill_process_group(group, Signal::KILL);
    }
    let status = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            let _ = kill_process_group(group, Signal::KILL);
            let _ = child.wait().await;
            return Err(Error::Unavailable("child did not join"));
        }
    };
    if !group_absent(group).await {
        return Err(Error::Unavailable("process group did not join"));
    }
    if timed_out {
        return Err(Error::Unavailable("command timed out"));
    }
    if !status.success() {
        return Err(Error::Unavailable("command failed"));
    }
    result.expect("timeout handled")
}

pub async fn capture(mut command: Command, max: usize, deadline: Duration) -> Result<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn()?;
    let group = child
        .id()
        .filter(|pid| *pid > 1)
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(Pid::from_raw)
        .ok_or(Error::Protocol("child process identity"))?;
    let mut stdout = child.stdout.take().ok_or(Error::Protocol("stdout"))?;
    let stderr = child.stderr.take().ok_or(Error::Protocol("stderr"))?;
    let result = tokio::time::timeout(deadline, async {
        let output = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(max as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > max {
                return Err(Error::Protocol("command output limit"));
            }
            Ok(bytes)
        };
        let (bytes, _) = tokio::try_join!(output, drain(stderr, 1024 * 1024))?;
        Ok::<_, Error>(bytes)
    })
    .await;
    let _ = kill_process_group(group, Signal::KILL);
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| Error::Unavailable("child did not join"))??;
    if !group_absent(group).await {
        return Err(Error::Unavailable("process group did not join"));
    }
    if !status.success() {
        return Err(Error::Unavailable("provider command failed"));
    }
    result.map_err(|_| Error::Unavailable("provider command timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustix::io::{FdFlags, fcntl_getfd};
    use std::{io::Write, os::unix::fs::PermissionsExt};

    fn write_executable(directory: &std::path::Path, mode: u32) -> PathBuf {
        let path = directory.join("provider");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"#!/bin/sh\necho ok\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn provider_version_metadata_accepts_official_codex_prereleases() {
        assert_eq!(
            parse_version(Provider::Codex, "codex-cli 0.155.0-alpha.2.6").unwrap(),
            "0.155.0-alpha.2.6"
        );
        assert_eq!(
            parse_version(Provider::Claude, "2.1.274 (Claude Code)").unwrap(),
            "2.1.274"
        );
        assert_eq!(
            parse_version(Provider::Devin, "devin 3000.10.31 (b98cc431)").unwrap(),
            "3000.10.31"
        );
        for text in [
            "codex-cli 1..3",
            "codex-cli 1.2.3-",
            "codex-cli 1.2.3\ninjected",
            "codex-cli 01.2.3",
        ] {
            assert!(parse_version(Provider::Codex, text).is_err());
        }
        assert!(parse_version(Provider::Claude, "2.1.274-beta").is_err());
    }

    #[test]
    fn discovery_repairs_only_owned_single_link_ordinary_executables() {
        let directory = tempfile::tempdir().unwrap();
        let path = write_executable(directory.path(), 0o777);
        let canonical = path.canonicalize().unwrap();
        assert_eq!(
            discover(Provider::Claude, Some(&canonical)).unwrap(),
            canonical
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o755);
        for (mode, tightened) in [(0o702, 0o700), (0o720, 0o700), (0o775, 0o755)] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert!(repair_executable_mode(&path).unwrap());
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, tightened);
        }
        for mode in [0o666, 0o4777, 0o2777, 0o1777] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert!(!repair_executable_mode(&path).unwrap());
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, mode);
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
        fs::hard_link(&path, directory.path().join("other")).unwrap();
        assert!(!repair_executable_mode(&path).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o777);
    }

    #[test]
    fn failed_os_spawn_proves_that_no_child_started() {
        let directory = tempfile::tempdir().unwrap();
        let command = Command::new(directory.path().join("absent-provider"));
        assert!(matches!(
            StreamProcess::spawn(command),
            Err(Error::LaunchNotStarted(_))
        ));
    }

    #[test]
    fn admitted_executable_descriptor_has_cloexec() {
        let directory = tempfile::tempdir().unwrap();
        let path = write_executable(directory.path(), 0o500);
        let file = executable_file(&path).unwrap();
        let flags = fcntl_getfd(&file).unwrap();
        assert!(flags.contains(FdFlags::CLOEXEC));
    }

    #[test]
    fn setuid_setgid_and_sticky_executables_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        for mode in [0o4755, 0o2755, 0o6755, 0o1755] {
            let path = write_executable(directory.path(), mode);
            assert!(
                executable_file(&path).is_err(),
                "mode 0o{mode:o} should be rejected",
            );
        }
    }

    #[tokio::test]
    async fn absent_process_group_is_proven_by_esrch() {
        let mut command = Command::new("/bin/echo");
        command.arg("done").env_clear();
        command.as_std_mut().process_group(0);
        let child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        child.wait_with_output().await.unwrap();
        assert!(prove_process_group_absent(pid).is_ok());
    }

    #[tokio::test]
    async fn present_process_group_is_not_proven_absent() {
        let mut command = Command::new("/bin/sleep");
        command.arg("60").env_clear();
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let proof = prove_process_group_absent(pid);
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        assert!(proof.is_err());
    }

    #[test]
    fn zero_process_group_id_is_rejected_as_absence_proof() {
        assert!(prove_process_group_absent(0).is_err());
    }
}
