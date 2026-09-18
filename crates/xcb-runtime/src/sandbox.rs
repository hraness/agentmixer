use crate::{Error, Result, digest, process};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

fn canonical(path: &Path) -> Result<String> {
    let text = path.to_str().ok_or(Error::PrivateState)?;
    if !path.is_absolute()
        || text.len() > 4096
        || text.chars().any(char::is_control)
        || path.canonicalize()? != path
    {
        return Err(Error::PrivateState);
    }
    Ok(text.to_owned())
}

fn canonical_child(path: &Path) -> Result<String> {
    let name = path.file_name().ok_or(Error::PrivateState)?;
    let parent = path.parent().ok_or(Error::PrivateState)?.canonicalize()?;
    if parent.join(name) != path {
        return Err(Error::PrivateState);
    }
    canonical_len(path)
}

fn canonical_len(path: &Path) -> Result<String> {
    let text = path.to_str().ok_or(Error::PrivateState)?;
    if !path.is_absolute() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err(Error::PrivateState);
    }
    Ok(text.to_owned())
}

fn quoted(path: &Path) -> Result<String> {
    Ok(serde_json::to_string(&canonical(path)?)?)
}

pub fn seatbelt(executable: &Path, scratch: &Path) -> Result<String> {
    if executable.starts_with(scratch) {
        return Err(Error::PrivateState);
    }
    let exe = quoted(executable)?;
    let work = quoted(scratch)?;
    let temp = format!("/private/tmp/claude-{}", rustix::process::getuid().as_raw());
    Ok(format!(
        r#"(version 1)
(deny default)
(allow process-exec (literal {exe}))
(allow process-fork)
(allow process-info* (target self))
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow file-ioctl (literal "/dev/null") (subpath "/dev/fd"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/dtracehelper") (subpath "/dev/fd"))
(allow file-read* (literal "/") (literal "/tmp") (literal "/etc") (literal "/var") (literal "/Library") (literal "/private/etc") (literal "/private/tmp") (literal "/private/var")
  (literal {exe}) (subpath "/System") (subpath "/usr") (subpath "/Library/Preferences") (subpath "/Library/Apple") (subpath "/etc") (subpath "/private/etc") (subpath "/var/db/timezone") (subpath "/private/var/db/timezone"))
(allow file-map-executable (literal {exe}) (subpath "/System") (subpath "/usr"))
(allow file-read* file-write* (subpath {work}) (subpath "{temp}"))
(allow file-read-metadata (path-ancestors {exe}) (path-ancestors {work}) (path-ancestors "{temp}"))
(allow network-outbound (literal "/private/var/run/mDNSResponder") (literal "/private/var/run/syslog") (remote tcp "*:443"))
"#
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    Denied,
    Tcp443Dns,
}

#[derive(Debug, Clone)]
pub struct Forwarder {
    pub runtime: PathBuf,
    pub lo_up: Option<PathBuf>,
    /// Private env file inside a writable bind that the forwarder reads,
    /// deletes, and injects into the child environment. This is the only
    /// channel for secrets: `--setenv` values are visible in bwrap's own
    /// command line, so `bwrap_launch`'s `env` map must hold only
    /// non-sensitive variables.
    pub env_file: Option<PathBuf>,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct BwrapSpec {
    pub executable: PathBuf,
    pub scratch: PathBuf,
    pub account_home: Option<PathBuf>,
    pub read_only: Vec<PathBuf>,
    pub egress: Egress,
    pub socket: Option<PathBuf>,
    pub forwarder: Option<Forwarder>,
    pub policy_path: PathBuf,
}

pub struct BwrapLaunch {
    pub policy: String,
    pub policy_sha256: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

pub struct BwrapPin {
    pub executable: PathBuf,
    pub sha256: String,
}
impl BwrapPin {
    pub fn admit(path: &Path) -> Result<Self> {
        if path.canonicalize()? != path {
            return Err(Error::Unavailable("sandbox wrapper is not canonical"));
        }
        let sha256 = process::wrapper_digest(path)?;
        Ok(Self {
            executable: path.to_owned(),
            sha256,
        })
    }
    pub fn verify(&self) -> Result<()> {
        if self.executable.canonicalize()? != self.executable
            || process::wrapper_digest(&self.executable)? != self.sha256
        {
            return Err(Error::Unavailable("sandbox wrapper changed"));
        }
        Ok(())
    }
}

pub const BWRAP_CANDIDATES: &[&str] = &["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];

pub fn bwrap_candidate() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    BWRAP_CANDIDATES
        .iter()
        .map(Path::new)
        .filter(|path| {
            path.metadata()
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
        .find_map(|path| path.canonicalize().ok())
}

pub struct LinuxSandbox {
    pub candidate: Option<PathBuf>,
    pub admitted: bool,
    pub unprivileged_userns_clone: Option<bool>,
    pub max_user_namespaces: Option<u64>,
}

pub fn linux_sandbox() -> LinuxSandbox {
    let sysctl = |path: &str| {
        std::fs::read_to_string(path)
            .ok()
            .map(|text| text.trim().to_owned())
    };
    let candidate = bwrap_candidate();
    LinuxSandbox {
        admitted: candidate
            .as_deref()
            .and_then(|path| BwrapPin::admit(path).ok())
            .is_some(),
        candidate,
        unprivileged_userns_clone: sysctl("/proc/sys/kernel/unprivileged_userns_clone")
            .map(|value| value == "1"),
        max_user_namespaces: sysctl("/proc/sys/user/max_user_namespaces")
            .and_then(|value| value.parse().ok()),
    }
}

fn inside(inner: &str, outer: &str) -> bool {
    inner == outer
        || inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn arg(value: &str) -> Result<&str> {
    if value.len() > 4096
        || value
            .chars()
            .any(|char| char.is_control() || char == '\u{7f}')
    {
        return Err(Error::Unavailable("sandbox argv invalid"));
    }
    Ok(value)
}

pub fn bwrap_launch(
    pin: &BwrapPin,
    spec: &BwrapSpec,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<BwrapLaunch> {
    pin.verify()?;
    let executable = canonical(&spec.executable)?;
    let scratch = canonical(&spec.scratch)?;
    let account_home = spec.account_home.as_deref().map(canonical).transpose()?;
    let policy_path = canonical_child(&spec.policy_path)?;
    if spec.read_only.len() > 256 {
        return Err(Error::Unavailable("sandbox read-only bind limit"));
    }
    let read_only = spec
        .read_only
        .iter()
        .map(|path| canonical(path))
        .collect::<Result<Vec<_>>>()?;
    let socket = spec.socket.as_deref().map(canonical).transpose()?;
    let forwarder = spec
        .forwarder
        .as_ref()
        .map(|forwarder| {
            if forwarder.port == 0 {
                return Err(Error::Unavailable("sandbox forwarder port invalid"));
            }
            Ok((
                canonical(&forwarder.runtime)?,
                forwarder.lo_up.as_deref().map(canonical).transpose()?,
                forwarder
                    .env_file
                    .as_deref()
                    .map(canonical_child)
                    .transpose()?,
                forwarder.port,
            ))
        })
        .transpose()?;
    let invalid = || Error::Unavailable("sandbox layout invalid");
    if inside(&executable, &scratch)
        || account_home
            .as_ref()
            .is_some_and(|home| inside(&executable, home))
        || account_home
            .as_ref()
            .is_some_and(|home| inside(&scratch, home) || inside(home, &scratch))
        || inside(&policy_path, &scratch)
        || account_home
            .as_ref()
            .is_some_and(|home| inside(&policy_path, home))
    {
        return Err(invalid());
    }
    match (spec.egress, &socket) {
        (Egress::Denied, None) | (Egress::Tcp443Dns, Some(_)) => {}
        _ => return Err(Error::Unavailable("sandbox egress inconsistent")),
    }
    if forwarder.is_some() && socket.is_none() {
        return Err(Error::Unavailable(
            "sandbox forwarder requires egress socket",
        ));
    }
    if let Some(socket) = &socket
        && (inside(socket, &scratch)
            || account_home
                .as_ref()
                .is_some_and(|home| inside(socket, home)))
    {
        return Err(invalid());
    }
    if let Some((runtime, lo_up, env_file, _)) = &forwarder {
        let artifacts = [Some(runtime.as_str()), lo_up.as_deref()];
        if artifacts.into_iter().flatten().any(|artifact| {
            inside(artifact, &scratch)
                || account_home
                    .as_ref()
                    .is_some_and(|home| inside(artifact, home))
        }) {
            return Err(invalid());
        }
        if let Some(env_file) = env_file
            && !(inside(env_file, &scratch)
                || account_home
                    .as_ref()
                    .is_some_and(|home| inside(env_file, home)))
        {
            return Err(Error::Unavailable("sandbox env file outside writable root"));
        }
    }
    let mut binds: Vec<(bool, &str)> = Vec::new();
    binds.push((true, &executable));
    for target in &read_only {
        if inside(target, &scratch)
            || account_home
                .as_ref()
                .is_some_and(|home| inside(target, home))
        {
            return Err(invalid());
        }
        binds.push((true, target));
    }
    binds.push((false, &scratch));
    if let Some(home) = &account_home {
        binds.push((false, home));
    }
    if let Some(socket) = &socket {
        binds.push((false, socket));
    }
    if let Some((runtime, lo_up, _, _)) = &forwarder {
        binds.push((true, runtime));
        if let Some(lo_up) = lo_up {
            binds.push((true, lo_up));
        }
    }
    let mut targets = BTreeSet::new();
    for (_, target) in &binds {
        if !targets.insert(*target) {
            return Err(Error::Unavailable("sandbox bind target duplicated"));
        }
    }
    let cwd = canonical(cwd)?;
    if !(inside(&cwd, &scratch) || account_home.as_ref().is_some_and(|home| inside(&cwd, home))) {
        return Err(Error::Unavailable("sandbox working directory unbound"));
    }
    if args.len() > 256 {
        return Err(Error::Unavailable("sandbox argv limit"));
    }
    for value in args {
        arg(value)?;
    }
    for (key, value) in env {
        if !key
            .chars()
            .next()
            .is_some_and(|char| char.is_ascii_alphabetic() || char == '_')
            || !key
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || char == '_')
            || value.len() > 64 * 1024
            || value.contains('\0')
        {
            return Err(Error::Unavailable("sandbox environment invalid"));
        }
    }
    let policy = json!({
        "schema": "xcb.os-sandbox-bwrap.v1",
        "backend": "bwrap",
        "namespaces": ["user", "mount", "pid", "ipc", "uts", "cgroup", "net"],
        "newSession": true,
        "dieWithParent": true,
        "executable": executable,
        "binds": binds
            .iter()
            .map(|(ro, target)| json!({"mode": if *ro { "ro" } else { "rw" }, "target": target}))
            .collect::<Vec<_>>(),
        "egress": socket.as_ref().map(|socket| json!({
            "socket": socket,
            "protocol": "connect-tcp443",
            "forwarder": forwarder.as_ref().map(|(runtime, lo_up, env_file, port)| json!({
                "runtime": runtime,
                "subcommand": "egress-forward",
                "loUp": lo_up,
                "envFile": env_file,
                "port": port,
                "protocol": "http-connect-loopback",
            })),
        })),
    });
    let mut policy = serde_json::to_string(&policy)?;
    policy.push('\n');
    let mut argv: Vec<String> = [
        "--unshare-user",
        "--unshare-mount",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--unshare-net",
        "--new-session",
        "--die-with-parent",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]
    .iter()
    .map(|flag| (*flag).to_owned())
    .collect();
    for (ro, target) in &binds {
        argv.push(if *ro { "--ro-bind" } else { "--bind" }.to_owned());
        argv.push((*target).to_owned());
        argv.push((*target).to_owned());
    }
    argv.push("--clearenv".to_owned());
    for (key, value) in env {
        argv.push("--setenv".to_owned());
        argv.push(key.clone());
        argv.push(value.clone());
    }
    argv.push("--chdir".to_owned());
    argv.push(cwd);
    argv.push("--".to_owned());
    match &forwarder {
        None => argv.push(executable),
        Some((runtime, lo_up, env_file, port)) => {
            argv.push(runtime.clone());
            argv.push("egress-forward".to_owned());
            argv.push(socket.clone().expect("forwarder implies socket"));
            argv.push(port.to_string());
            argv.push(lo_up.clone().unwrap_or_else(|| "-".to_owned()));
            argv.push(env_file.clone().unwrap_or_else(|| "-".to_owned()));
            argv.push("--".to_owned());
            argv.push(executable);
        }
    }
    argv.extend(args.iter().cloned());
    Ok(BwrapLaunch {
        policy_sha256: digest(&policy),
        policy,
        executable: pin.executable.clone(),
        args: argv,
        env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
    })
}

pub fn available() -> bool {
    cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write, os::unix::fs::PermissionsExt};

    fn file(path: &Path, mode: u32) {
        let mut created = fs::File::create(path).unwrap();
        created.write_all(b"artifact").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    struct Layout {
        _root: tempfile::TempDir,
        base: PathBuf,
        spec: BwrapSpec,
        pin: BwrapPin,
    }

    fn make_layout(egress: Egress, socket: bool, forwarder: bool) -> Layout {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let executable = base.join("provider");
        file(&executable, 0o500);
        let scratch = base.join("scratch");
        fs::create_dir(&scratch).unwrap();
        let account_home = base.join("account");
        fs::create_dir(&account_home).unwrap();
        let socket_path = socket.then(|| {
            let path = base.join("egress.sock");
            file(&path, 0o600);
            path
        });
        let forwarder = forwarder.then(|| {
            let runtime = base.join("runtime");
            file(&runtime, 0o500);
            Forwarder {
                runtime,
                lo_up: None,
                env_file: None,
                port: 48123,
            }
        });
        let wrapper = base.join("bwrap");
        file(&wrapper, 0o755);
        Layout {
            _root: root,
            spec: BwrapSpec {
                executable,
                scratch,
                account_home: Some(account_home),
                read_only: vec![],
                egress,
                socket: socket_path,
                forwarder,
                policy_path: base.join("sandbox.json"),
            },
            pin: BwrapPin::admit(&wrapper).unwrap(),
            base,
        }
    }

    fn env() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("ZED".into(), "last".into()),
            ("HOME".into(), "/h".into()),
            ("ALPHA".into(), "first".into()),
        ])
    }

    fn cwd(layout: &Layout) -> PathBuf {
        let work = layout.spec.scratch.join("work");
        fs::create_dir_all(&work).unwrap();
        work
    }

    #[test]
    fn denied_launch_has_exact_argv_and_no_foreign_paths() {
        let layout = make_layout(Egress::Denied, false, false);
        let launch = bwrap_launch(
            &layout.pin,
            &layout.spec,
            &["--print".into(), "task".into()],
            &env(),
            &cwd(&layout),
        )
        .unwrap();
        let exe = layout.spec.executable.to_str().unwrap();
        let scratch = layout.spec.scratch.to_str().unwrap();
        let home = layout
            .spec
            .account_home
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let work = scratch.to_owned() + "/work";
        assert_eq!(
            launch.args,
            [
                "--unshare-user",
                "--unshare-mount",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-cgroup",
                "--unshare-net",
                "--new-session",
                "--die-with-parent",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--ro-bind",
                exe,
                exe,
                "--bind",
                scratch,
                scratch,
                "--bind",
                home.as_str(),
                home.as_str(),
                "--clearenv",
                "--setenv",
                "ALPHA",
                "first",
                "--setenv",
                "HOME",
                "/h",
                "--setenv",
                "ZED",
                "last",
                "--chdir",
                work.as_str(),
                "--",
                exe,
                "--print",
                "task",
            ]
        );
        assert_eq!(launch.env.len(), 1);
        let policy: serde_json::Value = serde_json::from_str(&launch.policy).unwrap();
        assert_eq!(policy["schema"], "xcb.os-sandbox-bwrap.v1");
        assert_eq!(policy["binds"].as_array().unwrap().len(), 3);
        assert!(policy.get("egress").is_none_or(|v| v.is_null()) || policy["egress"].is_null());
        assert_eq!(launch.policy_sha256, digest(&launch.policy));
    }

    #[test]
    fn forwarder_launch_supervises_provider_through_socket() {
        let layout = make_layout(Egress::Tcp443Dns, true, true);
        let launch = bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).unwrap();
        let tail = &launch.args[launch.args.iter().position(|a| a == "--").unwrap() + 1..];
        let forwarder = layout.spec.forwarder.unwrap();
        assert_eq!(
            tail,
            [
                forwarder.runtime.to_str().unwrap(),
                "egress-forward",
                layout.spec.socket.unwrap().to_str().unwrap(),
                "48123",
                "-",
                "-",
                "--",
                layout.spec.executable.to_str().unwrap(),
            ]
        );
        let policy: serde_json::Value = serde_json::from_str(&launch.policy).unwrap();
        assert_eq!(policy["egress"]["protocol"], "connect-tcp443");
        assert_eq!(policy["egress"]["forwarder"]["port"], 48123);
    }

    #[test]
    fn policy_is_deterministic() {
        let layout = make_layout(Egress::Denied, false, false);
        let one = bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).unwrap();
        let two = bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).unwrap();
        assert_eq!(one.policy, two.policy);
        assert_eq!(one.policy_sha256, two.policy_sha256);
        assert!(one.policy.ends_with('\n'));
    }

    #[test]
    fn rejects_paths_inside_writable_roots() {
        let mut layout = make_layout(Egress::Denied, false, false);
        layout.spec.executable = layout.spec.scratch.join("provider");
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn rejects_nested_writable_roots_and_policy_inside_scratch() {
        let layout = make_layout(Egress::Denied, false, false);
        let mut spec = layout.spec.clone();
        spec.account_home = Some(spec.scratch.join("home"));
        assert!(bwrap_launch(&layout.pin, &spec, &[], &env(), &cwd(&layout)).is_err());
        let mut spec = layout.spec.clone();
        spec.account_home = Some(spec.scratch.parent().unwrap().to_owned());
        assert!(bwrap_launch(&layout.pin, &spec, &[], &env(), &cwd(&layout)).is_err());
        let mut spec = layout.spec.clone();
        spec.policy_path = spec.scratch.join("sandbox.json");
        assert!(bwrap_launch(&layout.pin, &spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn rejects_noncanonical_and_relative_paths() {
        let layout = make_layout(Egress::Denied, false, false);
        let mut spec = layout.spec.clone();
        spec.executable = PathBuf::from("relative/provider");
        assert!(bwrap_launch(&layout.pin, &spec, &[], &env(), &cwd(&layout)).is_err());
        let link = layout.base.join("linked");
        std::os::unix::fs::symlink(&layout.spec.executable, &link).unwrap();
        let mut spec = layout.spec.clone();
        spec.executable = link;
        assert!(bwrap_launch(&layout.pin, &spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn rejects_egress_inconsistencies() {
        let layout = make_layout(Egress::Denied, true, false);
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
        let layout2 = make_layout(Egress::Tcp443Dns, false, false);
        assert!(bwrap_launch(&layout2.pin, &layout2.spec, &[], &env(), &cwd(&layout2)).is_err());
        let mut layout = make_layout(Egress::Tcp443Dns, true, true);
        layout.spec.socket = None;
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn env_file_path_reaches_forwarder_inside_writable_root() {
        let mut layout = make_layout(Egress::Tcp443Dns, true, true);
        let env_file = layout.spec.scratch.join("forwarder.env");
        file(&env_file, 0o600);
        layout.spec.forwarder.as_mut().unwrap().env_file = Some(env_file.clone());
        let launch = bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).unwrap();
        assert!(
            launch.args.contains(&env_file.to_str().unwrap().to_owned()),
            "env file path must reach the forwarder argv",
        );
        let policy: serde_json::Value = serde_json::from_str(&launch.policy).unwrap();
        assert_eq!(
            policy["egress"]["forwarder"]["envFile"],
            env_file.to_str().unwrap()
        );
    }

    #[test]
    fn rejects_env_file_outside_writable_roots() {
        let mut layout = make_layout(Egress::Tcp443Dns, true, true);
        let env_file = layout.base.join("forwarder.env");
        file(&env_file, 0o600);
        layout.spec.forwarder.as_mut().unwrap().env_file = Some(env_file);
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn rejects_socket_and_forwarder_inside_scratch() {
        let mut layout = make_layout(Egress::Tcp443Dns, true, false);
        layout.spec.socket = Some(layout.spec.scratch.join("egress.sock"));
        fs::File::create(layout.spec.socket.as_ref().unwrap()).unwrap();
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
        let mut layout = make_layout(Egress::Tcp443Dns, true, true);
        let lo_up = layout.spec.scratch.join("ip");
        file(&lo_up, 0o500);
        layout.spec.forwarder.as_mut().unwrap().lo_up = Some(lo_up);
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
    }

    #[test]
    fn rejects_duplicate_and_nested_readonly_binds() {
        let mut layout = make_layout(Egress::Denied, false, false);
        layout.spec.read_only = vec![layout.spec.executable.clone()];
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd(&layout)).is_err());
        let mut layout2 = make_layout(Egress::Denied, false, false);
        let nested = layout2.spec.scratch.join("lib.so");
        file(&nested, 0o400);
        layout2.spec.read_only = vec![nested];
        assert!(bwrap_launch(&layout2.pin, &layout2.spec, &[], &env(), &cwd(&layout2)).is_err());
    }

    #[test]
    fn rejects_invalid_environment() {
        let layout = make_layout(Egress::Denied, false, false);
        for (key, value) in [
            ("9BAD", "v"),
            ("BAD-KEY", "v"),
            ("OK", &"x".repeat(64 * 1024 + 1)),
            ("OK", "has\0nul"),
        ] {
            let env = BTreeMap::from([(key.to_owned(), value.to_owned())]);
            assert!(
                bwrap_launch(&layout.pin, &layout.spec, &[], &env, &cwd(&layout)).is_err(),
                "{key}={value:?} should fail",
            );
        }
    }

    #[test]
    fn rejects_invalid_argv_and_unbound_cwd() {
        let layout = make_layout(Egress::Denied, false, false);
        assert!(
            bwrap_launch(
                &layout.pin,
                &layout.spec,
                &["bad\narg".into()],
                &env(),
                &cwd(&layout)
            )
            .is_err()
        );
        let many = vec!["a".to_owned(); 257];
        assert!(bwrap_launch(&layout.pin, &layout.spec, &many, &env(), &cwd(&layout)).is_err());
        let outside = tempfile::tempdir().unwrap();
        let cwd = outside.path().canonicalize().unwrap();
        assert!(bwrap_launch(&layout.pin, &layout.spec, &[], &env(), &cwd).is_err());
    }

    #[test]
    fn pin_verification_detects_wrapper_changes() {
        let layout = make_layout(Egress::Denied, false, false);
        layout.pin.verify().unwrap();
        fs::write(&layout.pin.executable, b"tampered").unwrap();
        assert!(layout.pin.verify().is_err());
        assert!(BwrapPin::admit(&layout.base.join("missing")).is_err());
        let setuid = layout.base.join("setuid-wrap");
        file(&setuid, 0o4755);
        assert!(BwrapPin::admit(&setuid).is_err());
    }
}
