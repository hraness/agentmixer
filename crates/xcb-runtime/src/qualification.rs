use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LINUX_QUALIFICATION_NAME: &str = "qualification/linux.json";
pub const LINUX_QUALIFICATION_SCHEMA: &str = "xcb.qualification.linux.v1";

/// Receipts older than this are stale evidence: the admitted wrapper binary,
/// AppArmor restrictions and namespace sysctls the receipt binds can all drift
/// after collection, so qualification must be re-attested rather than carried
/// forward indefinitely. 30 days bounds that drift while leaving room for
/// evidence produced by a CI run and installed by hand.
pub const MAX_RECEIPT_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

/// Small future-timestamp allowance for clock skew between the runner that
/// stamps `observed_at_ms` and the host admitting the receipt.
pub const RECEIPT_FUTURE_SKEW_MS: u64 = 5 * 60 * 1_000;

/// Probes the receipt must attest. Same set qualification/build-receipt.ts
/// emits; a missing or renamed probe is a failed admission, not a skipped one.
const EXPECTED_PROBES: &[&str] = &["linux-sandbox", "linux-egress", "linux-loopback"];

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
        if receipt.schema != LINUX_QUALIFICATION_SCHEMA {
            return Err(Error::Protocol("qualification receipt schema"));
        }
        Ok(receipt)
    }

    /// Admission is bound to the host that produced the evidence: `namespaces`
    /// carries the *current* reads of the same sysctl facts the receipt
    /// recorded (with the emitter's normalization — an unreadable knob is
    /// "absent"/"0"), and `now_ms` bounds freshness. Any drift — a different
    /// wrapper, changed sysctls, a stale or future timestamp, a missing or
    /// failed probe — means the evidence no longer describes this host.
    pub fn qualified(
        &self,
        bwrap: &Path,
        expected_sha256: &str,
        namespaces: &Namespaces,
        now_ms: u64,
    ) -> bool {
        if self.schema != LINUX_QUALIFICATION_SCHEMA
            || self.wrapper.path != bwrap
            || self.wrapper.sha256 != expected_sha256
            || self.namespaces.unprivileged_userns_clone != namespaces.unprivileged_userns_clone
            || self.namespaces.max_user_namespaces != namespaces.max_user_namespaces
        {
            return false;
        }
        if self.observed_at_ms > now_ms.saturating_add(RECEIPT_FUTURE_SKEW_MS)
            || now_ms.saturating_sub(self.observed_at_ms) > MAX_RECEIPT_AGE_MS
        {
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
        let probes_ok = EXPECTED_PROBES.iter().all(|name| {
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

    /// Emitted verbatim by `bun qualification/build-receipt.ts` against
    /// synthetic passing evidence — the cross-language contract fixture.
    /// Regenerate with the workflow's evidence layout, never by hand.
    const FIXTURE: &str = include_str!("../tests/fixtures/linux-qualification.json");

    const NOW: u64 = 1_800_000_000_000;
    const SHA: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn receipt() -> LinuxQualification {
        LinuxQualification {
            schema: LINUX_QUALIFICATION_SCHEMA.into(),
            wrapper: Wrapper {
                path: "/usr/bin/bwrap".into(),
                sha256: SHA.into(),
            },
            namespaces: host(),
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
            observed_at_ms: NOW,
        }
    }

    fn host() -> Namespaces {
        Namespaces {
            unprivileged_userns_clone: "1".into(),
            max_user_namespaces: "10000".into(),
        }
    }

    fn qualified(receipt: &LinuxQualification) -> bool {
        receipt.qualified(Path::new("/usr/bin/bwrap"), SHA, &host(), NOW)
    }

    #[test]
    fn emitted_fixture_deserializes_verbatim() {
        // Contract test for the TS emitter: build-receipt.ts must produce
        // exactly the fields this struct deserializes — probe names,
        // exit_code and passed — or admission can never see a real pass.
        let fixture: LinuxQualification = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture.schema, LINUX_QUALIFICATION_SCHEMA);
        assert_eq!(fixture.wrapper.path, PathBuf::from("/usr/bin/bwrap"));
        assert_eq!(fixture.wrapper.sha256.len(), 64);
        assert_eq!(fixture.probes.len(), EXPECTED_PROBES.len());
        for name in EXPECTED_PROBES {
            let probe = fixture.probes.get(*name).expect("expected probe");
            assert_eq!(probe.exit_code, 0, "{name} exit_code");
            assert_eq!(probe.passed, Some(true), "{name} passed");
        }
        assert!(fixture.observed_at_ms > 0);
    }

    #[test]
    fn qualified_accepts_matching_fresh_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let r = receipt();
        fs::create_dir(dir.path().join("qualification")).unwrap();
        fs::write(
            dir.path().join(LINUX_QUALIFICATION_NAME),
            serde_json::to_vec(&r).unwrap(),
        )
        .unwrap();
        let loaded = LinuxQualification::load(dir.path()).unwrap();
        assert!(loaded.qualified(Path::new("/usr/bin/bwrap"), SHA, &host(), NOW));
    }

    #[test]
    fn rejects_schema_mismatch() {
        let mut r = receipt();
        r.schema = "xcb.qualification.linux.v0".into();
        assert!(!qualified(&r));
    }

    #[test]
    fn rejects_wrapper_mismatch() {
        let r = receipt();
        assert!(!r.qualified(Path::new("/bin/bwrap"), SHA, &host(), NOW));
        assert!(!r.qualified(Path::new("/usr/bin/bwrap"), &"1".repeat(64), &host(), NOW));
    }

    #[test]
    fn rejects_stale_and_future_receipts() {
        let mut r = receipt();
        r.observed_at_ms = NOW - MAX_RECEIPT_AGE_MS - 1;
        assert!(!qualified(&r));
        let mut r = receipt();
        r.observed_at_ms = NOW - MAX_RECEIPT_AGE_MS;
        assert!(qualified(&r));
        let mut r = receipt();
        r.observed_at_ms = NOW + RECEIPT_FUTURE_SKEW_MS + 1;
        assert!(!qualified(&r));
        let mut r = receipt();
        r.observed_at_ms = NOW + RECEIPT_FUTURE_SKEW_MS;
        assert!(qualified(&r));
    }

    #[test]
    fn rejects_namespace_drift() {
        let r = receipt();
        let mut drifted = host();
        drifted.unprivileged_userns_clone = "0".into();
        assert!(!r.qualified(Path::new("/usr/bin/bwrap"), SHA, &drifted, NOW));
        let mut drifted = host();
        drifted.max_user_namespaces = "20000".into();
        assert!(!r.qualified(Path::new("/usr/bin/bwrap"), SHA, &drifted, NOW));
        // A host whose sysctl knob vanished entirely is not the attested host.
        let mut drifted = host();
        drifted.unprivileged_userns_clone = "absent".into();
        assert!(!r.qualified(Path::new("/usr/bin/bwrap"), SHA, &drifted, NOW));
    }

    #[test]
    fn rejects_missing_and_failed_probes() {
        let mut r = receipt();
        r.probes.remove("linux-loopback");
        assert!(!qualified(&r));
        let mut r = receipt();
        r.probes.get_mut("linux-egress").unwrap().passed = Some(false);
        assert!(!qualified(&r));
        let mut r = receipt();
        r.probes.get_mut("linux-sandbox").unwrap().exit_code = 1;
        assert!(!qualified(&r));
        let mut r = receipt();
        r.probes.get_mut("linux-sandbox").unwrap().passed = None;
        assert!(!qualified(&r));
    }

    #[test]
    fn rejects_unusable_namespace_facts() {
        let mut r = receipt();
        r.namespaces.unprivileged_userns_clone = "0".into();
        assert!(!qualified(&r));
        let mut r = receipt();
        r.namespaces.max_user_namespaces = "0".into();
        assert!(!qualified(&r));
    }

    #[test]
    fn missing_receipt_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(LinuxQualification::load(dir.path()).is_err());
    }
}
