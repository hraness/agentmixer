# Publishing

xcb publishes one package, `@hraness/xcb`, from one tag channel.
An immutable annotated `v<version>` tag at a reviewed commit in current `main`
history is a release request. The tag version must equal `package.json`'s
`version`; no other tag shape is admitted.

## Release contract

`.github/workflows/release.yml` runs the whole pipeline. Its jobs:

1. **Verify release source.** Confirms the push is one exact `v*` tag, resolves
   the tag to its commit, proves the commit is an ancestor of exact advertised
   `main`, and proves the tag is the newest advertised stable tag. Stages the
   dependency-free release writers from the tagged source and preserves them as
   workflow artifacts so later jobs execute reviewed bytes, not a fresh
   checkout. Runs the complete `bun run check` gate, then builds `dist/` and
   packs the one release tarball with `npm pack --ignore-scripts`. Writes
   `SHA256SUMS` over the tarball and preserves both as artifacts.
2. **Exact tarball install.** On Ubuntu and macOS, downloads the release bytes
   by numeric artifact ID, verifies the checksum, and runs the packed-package
   smoke check: the tarball installs into an isolated consumer and the public
   entry executes — including an account-lease custody round trip — under both
   Bun and Node.
3. **Native binary build.** On Ubuntu and macOS, checks out the verified tag
   commit, builds `xcb` with the pinned Rust toolchain through
   `scripts/build-native.sh`, and preserves
   `xcb-<version>-<os>-<arch>.tar.gz` plus its adjacent `.sha256` checksum as
   run-bound workflow artifacts.
4. **Publish immutable GitHub Release.** The only job holding
   `contents: write`. Creates the immutable Latest GitHub Release carrying the
   exact tarball, `SHA256SUMS`, and every native archive/checksum pair, then
   proves it back.
5. **Pre-npm admission.** Proves the immutable GitHub Release bytes match the
   packed artifact and admits the npm retry state: absent, or an exact same-run
   retry only.
6. **Publish npm.** The only job holding `id-token: write`. Downloads the exact
   bytes and the reviewed dependency-free npm writer, rechecks the checksum,
   and publishes through npm OIDC trusted publishing with provenance. No npm
   token exists anywhere in the pipeline.
7. **Admission.** Verifies the exact registry version, repository, tag,
   ancestry, bytes, and Sigstore provenance — the provenance certificate must
   bind this repository, this workflow, this tag, and this run.

A failed or interrupted run leaves quarantine, not retry authority: the
pre-npm job only admits a retry that is an exact continuation of the same run.

## Repository protections

- `main` delivery is protected by the organization "Protect main delivery"
  ruleset: changes arrive through reviewed pull requests with required checks.
- `v*` tags are protected by the organization "Immutable version tags"
  ruleset: a tag names one commit forever.
- Release-critical paths (workflows, release scripts, `package.json`,
  `bun.lock`, this document) are owned in `.github/CODEOWNERS`.
- The former scoped tag namespaces (`agentmixer-v*`, `agentrouter-v*`,
  `xcb-v*`) and the former `hraness/textbutler` repository identity are
  rejected by the release checks on purpose.

## Site deployment

`site/` deploys to Vercel as `xcb.dev` through the standard Git
integration on `main`. The site is informational only; it carries no product
runtime and no release authority.

## Native binary release

The `native_artifact` job inside `.github/workflows/release.yml` builds `xcb`
for Ubuntu and macOS from the verified tag commit through
`scripts/build-native.sh`. The publish job attaches
`xcb-<version>-<os>-<arch>.tar.gz` and its adjacent `.sha256` checksum to the
release draft alongside the package tarball and `SHA256SUMS`; all assets become
immutable together when the release is published. This folding is required, not
cosmetic: a published GitHub Release is immutable, so assets cannot be added
afterward — the former `release-native.yml` `workflow_run` follower could
neither see the tag ref nor extend the finalized release, and has been removed.
Native artifacts are not published to npm; they are a separate release surface
alongside the `@hraness/xcb` compatibility package.

## Site publication datum

`site/published-release.json` starts with `version` and `verificationRun` both
null. The homepage then shows the first-release preparation state and offers
no archive download. After the canonical GitHub release has passed public
verification, set both fields to the exact stable release version and its
successful `https://github.com/hraness/xcb/actions/runs/<run-id>` URL.
Keep both fields null if publication or verification is incomplete. Regenerate
the README projection with `cd site && bun run sync:readme` and validate the
site with `bun run check` before deploying the update.
