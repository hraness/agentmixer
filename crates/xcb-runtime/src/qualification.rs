use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LINUX_QUALIFICATION_NAME: &str = "qualification/linux.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wrapper {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Namespaces {
    pub unprivileged_userns_clone: String,
    pub max_user_namespaces: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub exit_code: i32,
    pub passed: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinuxQualification {
    pub schema: String,
    pub wrapper: Wrapper,
    pub namespaces: Namespaces,
    pub probes: std::collections::BTreeMap<String, Probe>,
    pub observed_at_ms: u64,
}

impl LinuxQualification {
    pub fn load(root: &Path) -> Result<Self> {
        let bytes = std::fs::read(root.join(LINUX_QUALIFICATION_NAME))?;
        if bytes.len() > 64 * 1024 {
            return Err(Error::Unavailable("qualification receipt too large"));
        }
        let receipt: Self = serde_json::from_slice(&bytes)
            .map_err(|_| Error::Protocol("qualification receipt invalid"))?;
        if receipt.schema != "xcb.qualification.linux.v1" {
            return Err(Error::Protocol("qualification receipt schema"));
        }
        Ok(receipt)
    }

    pub fn qualified(&self, bwrap: &Path, expected_sha256: &str) -> bool {
        if self.wrapper.path != bwrap || self.wrapper.sha256 != expected_sha256 {
            return false;
        }
        let userns_ok = self
            .namespaces
            .unprivileged_userns_clone
            .trim()
            .parse::<i64>()
            .is_ok_and(|v| v != 0);
        let max_ok = self
            .namespaces
            .max_user_namespaces
            .trim()
            .parse::<i64>()
            .is_ok_and(|v| v > 0);
        let probes_ok = ["linux-sandbox", "linux-egress", "linux-loopback"]
            .iter()
            .all(|name| {
                self.probes
                    .get(*name)
                    .is_some_and(|p| p.passed == Some(true) && p.exit_code == 0)
            });
        userns_ok && max_ok && probes_ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn receipt() -> LinuxQualification {
        LinuxQualification {
            schema: "xcb.qualification.linux.v1".into(),
            wrapper: Wrapper {
                path: "/usr/bin/bwrap".into(),
                sha256: "0".repeat(64),
            },
            namespaces: Namespaces {
                unprivileged_userns_clone: "1".into(),
                max_user_namespaces: "10000".into(),
            },
            probes: [
                (
                    "linux-sandbox",
                    Probe {
                        exit_code: 0,
                        passed: Some(true),
                    },
                ),
                (
                    "linux-egress",
                    Probe {
                        exit_code: 0,
                        passed: Some(true),
                    },
                ),
                (
                    "linux-loopback",
                    Probe {
                        exit_code: 0,
                        passed: Some(true),
                    },
                ),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
            observed_at_ms: 1,
        }
    }

    #[test]
    fn qualified_matches_wrapper_and_probes() {
        let dir = tempfile::tempdir().unwrap();
        let r = receipt();
        fs::create_dir(dir.path().join("qualification")).unwrap();
        fs::write(
            dir.path().join(LINUX_QUALIFICATION_NAME),
            serde_json::to_vec(&r).unwrap(),
        )
        .unwrap();
        let loaded = LinuxQualification::load(dir.path()).unwrap();
        assert!(loaded.qualified(Path::new("/usr/bin/bwrap"), &"0".repeat(64)));
        assert!(!loaded.qualified(Path::new("/usr/bin/bwrap"), &"1".repeat(64)));
        assert!(!loaded.qualified(Path::new("/bin/bwrap"), &"0".repeat(64)));
    }

    #[test]
    fn missing_receipt_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(LinuxQualification::load(dir.path()).is_err());
    }
}
