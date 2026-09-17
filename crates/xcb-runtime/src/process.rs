use crate::{Error, Result, digest, private};
use rustix::process::{Pid, Signal, kill_process_group, test_kill_process_group};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::{self, File, OpenOptions}, io::{Read, Write}, os::unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, process::CommandExt}, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}, task::JoinHandle};
use xcb_core::{MAX_JSON_BYTES, Provider};

pub fn environment(home: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("PATH".into(), "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("NO_COLOR".into(), "1".into()),
        ("XDG_CONFIG_HOME".into(), home.join(".config").to_string_lossy().into_owned()),
        ("XDG_DATA_HOME".into(), home.join(".local/share").to_string_lossy().into_owned()),
        ("XDG_CACHE_HOME".into(), home.join(".cache").to_string_lossy().into_owned()),
        ("TMPDIR".into(), home.join("tmp").to_string_lossy().into_owned()),
    ])
}

fn executable_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32).open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || ![0, rustix::process::getuid().as_raw()].contains(&meta.uid()) || meta.mode() & 0o022 != 0 || meta.mode() & 0o111 == 0 || meta.len() == 0 || meta.len() > 512 * 1024 * 1024 { return Err(Error::Unavailable("executable ownership, permissions, or size is invalid")); }
    Ok(file)
}

pub fn executable_digest(path: &Path) -> Result<String> {
    let mut file = executable_file(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        size += count as u64;
        if size > 512 * 1024 * 1024 { return Err(Error::Unavailable("executable size changed")); }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

pub fn discover(provider: Provider, explicit: Option<&Path>) -> Result<PathBuf> {
    let override_name = format!("XCB_{}", provider.as_str().to_uppercase());
    if let Some(path) = explicit.map(Path::to_owned).or_else(|| std::env::var_os(override_name).map(PathBuf::from)) {
        if !path.is_absolute() { return Err(Error::Unavailable("provider path must be absolute")); }
        let path = path.canonicalize()?;
        executable_file(&path)?;
        return Ok(path);
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).take(128) {
        let candidate = directory.join(provider.as_str());
        if let Ok(path) = candidate.canonicalize() {
            if executable_file(&path).is_ok() { return Ok(path); }
        }
    }
    Err(Error::Unavailable("provider binary not found; specify its XCB provider path"))
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
        if self.executable.canonicalize()? != self.executable || executable_digest(&self.executable)? != self.sha256 || executable_digest(&std::env::current_exe()?.canonicalize()?)? != self.host_sha256 { return Err(Error::Unavailable("runtime changed; run xcb doctor again")); }
        Ok(())
    }
    pub fn load(root: &Path, provider: Provider) -> Result<Self> {
        let pin: Self = serde_json::from_slice(&private::read(&root.join("providers").join(format!("{provider}.json")), 16 * 1024)?)?;
        if pin.provider != provider { return Err(Error::Unavailable("provider pin mismatch")); }
        pin.verify()?;
        Ok(pin)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        let directory = private::directory(&root.join("providers"))?;
        let path = directory.join(format!("{}.json", self.provider));
        let bytes = serde_json::to_vec_pretty(self)?;
        match private::read(&path, 16 * 1024) {
            Ok(old) => private::replace(&path, &bytes, &digest(old)),
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => private::create(&path, &bytes),
            Err(error) => Err(error),
        }
    }
    pub fn snapshot(&self, directory: &Path) -> Result<PathBuf> {
        self.verify()?;
        let path = directory.join("provider");
        let source = executable_file(&self.executable)?;
        let mut target = OpenOptions::new().write(true).create_new(true).mode(0o500).open(&path)?;
        std::io::copy(&mut source.take(512 * 1024 * 1024 + 1), &mut target)?;
        target.flush()?;
        target.sync_all()?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o500))?;
        if executable_digest(&path)? != self.sha256 { return Err(Error::Unavailable("executable snapshot changed")); }
        Ok(path)
    }
}

pub async fn inspect(provider: Provider, explicit: Option<&Path>, home: &Path) -> Result<Pin> {
    let executable = discover(provider, explicit)?;
    let sha256 = executable_digest(&executable)?;
    let mut command = Command::new(&executable);
    command.arg("--version").env_clear().envs(environment(home)).current_dir(home);
    let bytes = capture(command, 1024, Duration::from_secs(10)).await?;
    let output = std::str::from_utf8(&bytes).map_err(|_| Error::Protocol("version encoding"))?.trim();
    let version = match provider {
        Provider::Claude => output.strip_suffix(" (Claude Code)").unwrap_or(output),
        Provider::Devin => output.strip_prefix("devin ").and_then(|text| text.split_once(" (").map(|pair| pair.0)).ok_or(Error::Protocol("Devin version"))?,
        Provider::Codex => output.strip_prefix("codex-cli ").ok_or(Error::Protocol("Codex version"))?,
    };
    if version.len() > 64 || version.split('.').count() != 3 || !version.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.') { return Err(Error::Protocol("version shape")); }
    if executable_digest(&executable)? != sha256 { return Err(Error::Unavailable("runtime changed during inspection")); }
    Ok(Pin { provider, executable, sha256, version: version.to_owned(), host_sha256: executable_digest(&std::env::current_exe()?.canonicalize()?)?, observed_at_ms: crate::now_ms() })
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
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn()?;
        let pid = child.id().filter(|pid| *pid > 1).and_then(|pid| i32::try_from(pid).ok()).and_then(Pid::from_raw).ok_or(Error::Protocol("child process identity"))?;
        let stdin = child.stdin.take().ok_or(Error::Protocol("child stdin"))?;
        let stdout = BufReader::new(child.stdout.take().ok_or(Error::Protocol("child stdout"))?);
        let stderr = child.stderr.take().ok_or(Error::Protocol("child stderr"))?;
        let stderr = tokio::spawn(async move { drain(stderr, 1024 * 1024).await.is_ok() });
        Ok(Self { stdin, stdout, child, group: Some(pid), stderr })
    }
    pub fn pid(&self) -> u32 { self.group.expect("owned process group").as_raw_nonzero().get() as u32 }
    pub async fn send(&mut self, value: &serde_json::Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() > 16 * 1024 * 1024 { return Err(Error::Protocol("input frame limit")); }
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }
    pub async fn frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut bytes = Vec::new();
        loop {
            let available = self.stdout.fill_buf().await?;
            if available.is_empty() { return if bytes.is_empty() { Ok(None) } else { Err(Error::Protocol("incomplete final frame")) }; }
            let end = available.iter().position(|byte| *byte == b'\n');
            let count = end.map_or(available.len(), |end| end + 1);
            if bytes.len() + count > MAX_JSON_BYTES { return Err(Error::Protocol("output frame limit")); }
            bytes.extend_from_slice(&available[..count]);
            self.stdout.consume(count);
            if end.is_some() { return Ok(Some(bytes)); }
        }
    }
    fn signal(&self) {
        if let Some(group) = self.group { let _ = kill_process_group(group, Signal::KILL); }
    }
    pub async fn join(&mut self) -> bool {
        self.signal();
        let Some(group) = self.group.take() else { return false; };
        let joined = tokio::time::timeout(Duration::from_secs(5), async {
            let _ = self.stdin.shutdown().await;
            let (exit, stdout, stderr) = tokio::join!(self.child.wait(), drain(&mut self.stdout, 16 * 1024 * 1024), &mut self.stderr);
            exit.is_ok() && stdout.is_ok() && matches!(stderr, Ok(true))
        }).await.unwrap_or(false);
        joined && test_kill_process_group(group) == Err(rustix::io::Errno::SRCH)
    }
}
impl Drop for StreamProcess {
    fn drop(&mut self) { self.signal(); self.stderr.abort(); }
}

async fn drain(mut source: impl AsyncRead + Unpin, max: usize) -> Result<()> {
    let mut buffer = [0u8; 8192];
    let mut count = 0;
    loop { let read = source.read(&mut buffer).await?; if read == 0 { return Ok(()); } count += read; if count > max { return Err(Error::Protocol("stream output limit")); } }
}

pub async fn capture(mut command: Command, max: usize, deadline: Duration) -> Result<Vec<u8>> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn()?;
    let group = child.id().filter(|pid| *pid > 1).and_then(|pid| i32::try_from(pid).ok()).and_then(Pid::from_raw).ok_or(Error::Protocol("child process identity"))?;
    let mut stdout = child.stdout.take().ok_or(Error::Protocol("stdout"))?;
    let stderr = child.stderr.take().ok_or(Error::Protocol("stderr"))?;
    let result = tokio::time::timeout(deadline, async {
        let output = async { let mut bytes = Vec::new(); (&mut stdout).take(max as u64 + 1).read_to_end(&mut bytes).await?; if bytes.len() > max { return Err(Error::Protocol("command output limit")); } Ok(bytes) };
        let (bytes, _) = tokio::try_join!(output, drain(stderr, 1024 * 1024))?;
        Ok::<_, Error>(bytes)
    }).await;
    let _ = kill_process_group(group, Signal::KILL);
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await.map_err(|_| Error::Unavailable("child did not join"))??;
    if test_kill_process_group(group) != Err(rustix::io::Errno::SRCH) { return Err(Error::Unavailable("process group did not join")); }
    if !status.success() { return Err(Error::Unavailable("provider command failed")); }
    result.map_err(|_| Error::Unavailable("provider command timed out"))?
}
