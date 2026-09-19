# Security

xcb is in development. Native Claude execution remains subject to exact-binary
admission and per-run boundary verification. Native Codex and Devin execution
are unavailable; compatibility Devin remains disabled pending qualification.
A model catalog, successful metadata probe, or synthetic fixture is not a
production security attestation.

The execution boundary keeps model-facing tools closed and bounded, credentials
outside workspaces, and provider accounts under exclusive host custody. Report
custody takeover, unbounded input, ambient network or credential access,
confinement escapes, unsafe replay, and process-ownership confusion.

## Reporting

Open a private security advisory on
[hraness/xcb](https://github.com/hraness/xcb/security/advisories/new), or use the
maintainer contact listed on the organization profile. Include a minimal
reproduction when possible. Remove account keys, private paths, provider state,
and transcript contents from diagnostic attachments.

Do not open a public issue for an unpatched vulnerability.
