use crate::{Error, Result};
use std::path::Path;

fn quoted(path: &Path) -> Result<String> {
    let text = path.to_str().ok_or(Error::PrivateState)?;
    if !path.is_absolute()
        || text.len() > 4096
        || text.chars().any(char::is_control)
        || path.canonicalize()? != path
    {
        return Err(Error::PrivateState);
    }
    Ok(serde_json::to_string(text)?)
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

pub fn available() -> bool {
    cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").is_file()
}
