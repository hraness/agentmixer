<!-- hraness:xcb-landing:start -->
# xcb

xcb (Excalibur) is a local, terminal-first workspace for coding agents, built
with Rust and Ratatui. Named accounts, local sessions, and composable extensions
share one interface. It is in development: Claude is the only native execution
candidate; Codex and Devin execution remain unavailable.
<!-- hraness:xcb-landing:end -->

[Project site](https://xcb.dev) · [Source](https://github.com/hraness/xcb) ·
[Compatibility reference](docs/compatibility.md) · [Contributing](CONTRIBUTING.md)

## Readiness

**xcb is not yet a daily-driver replacement for Codex, Claude Code, and Devin.**
The native broker can list, read, search, and write workspace files. It cannot
run shell commands, tests, builds, Git, or arbitrary provider tools. Run those
operations yourself in a separate terminal and check changes before using them.

| Provider | Native Rust CLI | TypeScript compatibility CLI |
| --- | --- | --- |
| Claude | Execution candidate on macOS/Linux, after sign-in, an admitted binary, and per-run confinement checks | Execution candidate, subject to its own admission and confinement checks |
| Codex | Binary metadata discovery only; execution and catalog adapter unavailable | Discovery only; managed task execution gated on host qualification |
| Devin | Binary metadata and read-only model catalog discovery; execution unavailable | ACP implementation exists; task execution disabled pending exact-runtime qualification |

A successful `doctor` or a visible model does not prove a working coding session.
Native `doctor` reports `metadata pin only` for unqualified providers. Automated
fixtures check boundaries; they do not establish live provider readiness.

## Native xcb

The source build is the current installation path. As of September 19, 2026,
GitHub's latest published release is **AgentMixer v0.3.0**, with an AgentMixer
package archive. No native xcb release or `@hraness/xcb` npm package is published.
Source version 0.4.0 is not a published release. Check the
[release assets](https://github.com/hraness/xcb/releases) before downloading.

### Install from source

Requires Git, the pinned Rust **1.97.1** toolchain, and platform build tools.
The supported execution boundary is macOS Seatbelt or Linux with a working,
admitted `bwrap` configuration; unsupported confinement fails closed.

```sh
git clone https://github.com/hraness/xcb.git
cd xcb
rustup toolchain install 1.97.1 --profile minimal
./scripts/install-native.sh
export PATH="$HOME/.local/bin:$PATH"
xcb --version
xcb --help
```

The installer builds with the lockfile and installs `~/.local/bin/xcb`.
`XCB_INSTALL_PREFIX` changes the prefix. Both the old TypeScript CLI and the
native CLI use the name `xcb`; use `command -v xcb` to check which one is active.

### First Claude session

Install an admitted Claude Code binary (major 2, version 2.1.268 or newer).
xcb performs its own account sign-in below; it does
not silently import your existing provider login.

```sh
xcb accounts add claude personal --plan Max
xcb doctor --provider claude
xcb accounts login personal
xcb accounts refresh personal
xcb models
xcb --cwd /absolute/path/to/your/project
```

`--plan` is a display label; it does not verify your subscription. Complete the
browser sign-in when prompted. `accounts refresh` probes supported model and
usage metadata. Unknown or stale quota remains unknown. To select a model, copy
its full observed key from `xcb models` and run `xcb models default <key>`.

If discovery finds the wrong binary, use
`xcb doctor --provider claude --executable /absolute/path/to/claude`.
The pin binds executable bytes and version; rerun `doctor` after an upgrade.
An account, metadata pin, or model listing cannot activate an unqualified adapter.

### Everyday commands

```sh
xcb --cwd /absolute/path/to/your/project run --account personal -p "Explain this repository"
xcb sessions
xcb resume                 # latest native session
xcb resume <session-id>
xcb accounts
xcb config
xcb plugins
xcb panes
xcb doctor
xcb completions zsh > /path/to/completions/_xcb
```

Resume opens the saved session and its workspace. `/help` lists terminal
commands. Sessions and credentials live in the private native state root
`~/.local/share/xcb`; `--state /absolute/path` or `XCB_STATE` overrides it.
The compatibility CLI uses `~/.xcb` instead. Do not point both implementations
at the same state directory.

Cancellation joins the owned process before releasing custody. If `doctor`
reports an unsettled run, inspect `xcb recover` and the process state; an expired
lease or a quiet terminal is not proof that the provider stopped. Recovery is
an explicit operation, not a reason to delete state or lock files.

### Optional behavior

Auto-continue and Gobstopper context management default on with bounded
continuation and settled-boundary checks. Disable either with
`xcb plugins disable auto-continue` or `xcb plugins disable gobstopper`.
Local usage measurement stays local. aiCharts upload is unavailable; local
exports, external judgment, and executable hooks require separate opt-in.
Panes are presentation data and cannot grant execution authority.

The optional judge uses TypeSafe System One (`jev-latest`) to advise routing,
continuation, and context retention. It sends bounded task/response context to
that service; old tool-result bodies are excluded from compaction advice.
A judge cannot qualify a provider or bypass deterministic safety gates.
Store a key through stdin on macOS or Linux, then explicitly enable it:

```sh
xcb judge token < /secure/path/to/judge-key
xcb judge status
xcb judge enable
xcb judge test
# Later:
xcb judge disable
xcb judge logout
```

The input file is an existing private credential file, not a command-line key.
Keys are vaulted mode-0600 outside the workspace. `XCB_JEV_API_KEY` or
`TYPESAFE_API_KEY` may supply a key via the environment. Custom endpoints require
an explicit environment key; the vaulted key remains bound to System One.

### Devin model discovery

For an already authenticated Devin CLI, the following explicitly uses its
existing home for read-only catalog discovery:

```sh
xcb doctor --provider devin
xcb models refresh devin --from-native
xcb models
```

Fixed models, Adaptive, and Fusion pairings retain provider-issued identifiers.
A catalog choice does not enable Devin execution inside xcb. Continue using the
provider's own CLI for Devin and Codex tasks until their adapters are qualified.

## Migrating from AgentMixer

The native command imports **one Claude credential**, preserving the source:

```sh
xcb accounts import-agentmixer --source /absolute/path/to/.agentmixer --label imported
```

It does not migrate transcripts or sessions. The compatibility source has its
own `migrate` command and identifier changes; see the
[compatibility migration reference](docs/compatibility.md#migrating-from-agentmixer).
Do not run compatibility migration commands against the native state root.

## Standalone package

The retained TypeScript source provides host-owned routing, account custody,
bounded tools, and provider adapters. It is separate from the native Rust app.
For building it locally, library examples, qualification requirements, and its
CLI commands, see the [compatibility reference](docs/compatibility.md) and
[managed Codex contract](MANAGED-CODEX.md). The
[publishing contract](docs/publishing.md) describes future verified artifacts;
it is not evidence of a published package.

## Development

See [Contributing](CONTRIBUTING.md) for setup and the native, compatibility, and
site checks. Report vulnerabilities through [Security](SECURITY.md).
Licensed under [MIT](LICENSE).
