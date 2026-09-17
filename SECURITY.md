# Security

xcb's boundary is the execution seam: model-facing tool inputs stay
closed and bounded, provider accounts stay under exclusive host custody, and
adapters run only after the host proves the exact runtime and confinement it
claims. If you find a way for model output, a lease, a workspace, or a
credential to cross a boundary it should not — custody takeover, unbounded
input, ambient network or credential access, or process-ownership confusion —
please report it.

## Reporting

Open a private security advisory on the GitHub repository
(`hraness/xcb`, Security → Advisories) or email the maintainers through
the contact listed on the organization profile. Please include a minimal
reproduction or test that demonstrates the issue where possible.

Do not open a public issue for an unpatched vulnerability.
