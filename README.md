<!-- hraness:xcb-landing:start -->
# xcb

xcb (Excalibur) is a local, terminal-first workspace for coding agents. Bring
your accounts, choose your models, and shape the interface around your work.
Small, composable extensions handle usage, continuation, and context management;
the kernel keeps sessions, credentials, and execution under explicit custody.
<!-- hraness:xcb-landing:end -->

[Project site](https://xcb.dev) · [Native interface](#native-xcb) · [Compatibility package](#standalone-package)

## Native xcb

xcb is the new name and direction for AgentMixer. The native Rust kernel and
Ratatui interface are in development. The published
`@hraness/xcb` package below is the retained TypeScript compatibility
release, not a release of the new native interface. Existing AgentMixer
account state, transcripts, imports, and release coordinates are not silently
renamed or overwritten; see [migration](#migrating-from-agentmixer).

The native design is deliberately local. There is no required daemon, cloud
account, synchronization service, or task-shape router. Pick a provider and model,
set your favorites, and keep working in one terminal.

- **Accounts and subscriptions.** Named accounts, compact quota windows, observed
  token velocity, and estimated runway. Missing or stale quota stays unknown;
  token counts are not treated as a provider's billing statement.
- **A quiet session view.** Your latest input and the selected model stay visible.
  Thinking and older responses collapse; tool activity stays out of the way.
  Subagent state, a semantic status badge, and a live usage meter carry the signal.
- **Userspace panes.** `/pane` selects a preset or a local declaration. Edit or
  generate a pane without rebuilding the terminal. Reload validates the whole
  candidate and retains the last working view on error.
- **Optional behavior.** Auto-continue and Gobstopper context management default
  on, with bounded execution and explicit off switches. Hooks extend named
  lifecycle events; a view is never permission to execute a hook.
- **Simple model choice.** Favorites precede the rest of the observed provider
  catalog. Limit failover uses your order and a settled handoff, never a blind
  replay of an uncertain turn.
- **aiCharts integration.** Reuse its local measurement formats. Publishing is
  separate and opt-in at idle boundaries; no session text or credentials belong
  in numeric exports. The upstream usage service is not yet live-qualified.

The implementation references Pi's malleable extensions, Codex's native terminal
foundation, Ghostget's named capability boundaries, and Oompa's usage and recovery
lessons. It does not inherit Oompa's cloud control plane or make promises about
provider features that have not been admitted.

### Install the native binary

The `xcb` CLI builds with Rust 1.97.1 and works on macOS and Linux. A release
tarball for your OS and architecture is attached to every `v<version>` GitHub
Release as `xcb-<version>-<os>-<arch>.tar.gz` plus a `.sha256` checksum.

Install the latest release to `~/.local/bin`:

```sh
XCB_VERSION=0.1.0 ./scripts/install-native.sh
```

Build and install from source instead:

```sh
./scripts/install-native.sh
```

Generate shell completions:

```sh
xcb completions bash > /path/to/completions/xcb.bash
xcb completions zsh  > /path/to/completions/_xcb
xcb completions fish > /path/to/completions/xcb.fish
```

### Devin model modes

Fixed models, Adaptive, and Fusion are different selections. Adaptive delegates
routing to Devin. Fusion pairs a frontier lead with a sidekick; its supported
pairings have provider-issued model identifiers. xcb must select those exact
observed identifiers, not synthesize combinations or assign a single capability
score to every pairing. The selected mode and any provider-reported serving
models remain separate usage dimensions. Promotional prices are not a durable
subscription contract.

The source behavior was checked against Devin CLI 3000.10.31's model catalog
and the public [Adaptive documentation](https://docs.devin.ai/cli/adaptive) and
[Fusion architecture](https://cognition.com/blog/local-fusion). Catalog presence
proves a selection exists; native adapter admission and live behavior remain
separate checks.

## TypeScript compatibility

The retained application package provides:

- A Codex/Claude/Devin adapter interface with explicit runtime qualification.
- Shared SQLite account custody, generation fencing and process-aware recovery.
- A tool broker bound to one workspace and run, with closed file, public-web and
  messaging operations. There is no shell, executable or arbitrary RPC operation.
- Strict classifier output validation and selection from a fresh, host-observed
  model catalog. The cost comparison uses a 2,000-input / 128-output-token request.

`src/index.ts` exports the complete current interface. `createPublicWeb()` provides bounded public HTTPS GETs with address pinning, redirect checks, no ambient authentication, a 15-second deadline, and a 256 KiB maximum text response. Run `bun test` from the repository root.

## Install

Bun 1.3.14 or newer, or Node 22.13 or newer, is required. Add the canonical,
versioned GitHub archive to a Bun project:

```sh
bun add --exact --ignore-scripts https://github.com/hraness/xcb/releases/download/v0.4.0/hraness-xcb-0.4.0.tgz
```

The same release is mirrored to [npm](https://www.npmjs.com/package/@hraness/xcb):

```sh
npm install --save-exact --ignore-scripts @hraness/xcb@0.4.0
```

## Standalone package

`npm pack` produces a self-contained tarball after `bun
scripts/build-dist.ts` emits `dist/`: the `files` allowlist ships
only `dist` (a bundled ESM entry plus TypeScript declarations) and
`MANAGED-CODEX.md`, and the manifest pins every registry dependency to an exact
version. The package has no cross-package source imports, so a consumer
installs it with only its declared dependencies. Runtime facilities sit behind
small ports — `loopback-server.ts` uses `node:http` and `sqlite-port.ts` lazily
opens `bun:sqlite` or `node:sqlite` — so the built entry runs under both Bun
≥1.3.14 and Node ≥22.13 (the first release where `node:sqlite` loads
unflagged). Under Node, the first account-database open may emit Node's
`ExperimentalWarning` for `node:sqlite` on stderr; the API and file semantics
are pinned to match `bun:sqlite`. The managed native Codex launch path still
requires its pinned Bun 1.3.14 runtime and fails closed anywhere else — runtime
pinning is an admission invariant, not a portability gap. The repository gate
`bun run check:package` builds and
packs the tarball, scans its contents, verifies the manifest contract and
dependency completeness, installs it into an isolated consumer, and executes
the public entry — including an account-lease custody round trip — under both
runtimes. Releases are published through the repository's
`v<version>` tag channel: an immutable GitHub Release tarball is the
canonical artifact and `@hraness/xcb` on npm is an exact-byte mirror
published with OIDC provenance. See `docs/publishing.md` for the release
contract.

## Command-line interface

The package ships an `xcb` executable — a standalone terminal interface
that drives the same task runtime the library exposes. Installing the package
puts `xcb` on the PATH:

```sh
npm install -g --ignore-scripts @hraness/xcb
xcb doctor            # inspect provider binaries, admit this runtime
xcb auth claude       # sign in with a Claude subscription
xcb auth status       # show stored sign-in state
xcb auth logout       # remove the stored credential
xcb                   # open the chat in the current directory
xcb run -p "task"     # one headless turn (--cwd picks the workspace)
xcb sessions          # list local sessions
xcb sessions rm <id>  # remove a session and its transcript
xcb sessions prune    # drop sessions idle over 30 days (or N days)
xcb resume [id]       # continue a session (default: most recent)
```

Assistant text streams into the chat as the provider completes each content
block, and provider-declared errors (for example a plan's session limit) print
their own message next to the typed outcome code. Piped output stays clean:
streaming, spinners and ANSI styling only engage on a TTY.

`xcb` is the kernel layer: one local CLI that keeps provider account
custody, process lifecycle, brokered workspace tools, and unified responses on
this machine. Cloud sync and orchestration belong to higher-level products
built on this package; sessions are local-only.

The chat keeps the model's entire tool surface inside the opened directory:
`workspace.list`, `workspace.read`, `workspace.search`, `workspace.write`, and
bounded public `web.fetch`. There is no shell, process, or arbitrary-path
operation. Writes are atomic and require the file's current revision, so a
stale or speculative edit fails instead of clobbering. `/help` lists the
in-session commands; Ctrl-C cancels a running turn and Ctrl-D exits.

State lives under `~/.xcb` (mode `0700`, override with
`XCB_STATE`): a SQLite session registry, bounded JSONL transcripts,
per-provider config directories, the local admission records `doctor` writes,
and the subscription credential `auth` stores.

`xcb auth claude` runs `claude setup-token` to mint a long-lived
(one-year) subscription OAuth token, captured and stored mode-0600 in the
private state root — not the shared login keychain, so it cannot overwrite or
be overwritten by a normal `claude` sign-in. The token reaches the provider
only as `CLAUDE_CODE_OAUTH_TOKEN` inside the run's environment; it is never
written into a workspace or the managed config directory. Claude's config
directory is still redirected so provider hooks, plugins, skills and settings
cannot leak into a task.

On macOS each Claude run executes under a seatbelt profile: the provider
process can exec only its own verified snapshot, write only to the per-run
scratch and the managed config directory, and reach the network only over TCP
443 and the system resolver — with no keychain, Mach credential service, or
other-binary execution access (a provider's attempts to spawn `sh`, `git` or
`security` are denied and observed). On Linux each run plans through an
admitted `bwrap` artifact: private user/mount/pid/net namespaces, read-only
binds for the snapshot and its library closure, and egress through the
session's unix-socket bridge via the shipped in-namespace CONNECT forwarder
(`sandbox/loopback-forwarder.cjs`), which hands the provider standard
`HTTPS_PROXY` semantics on a loopback port — no provider cooperation needed.
When that surface cannot be admitted (no bwrap, or a host that refuses
unprivileged user namespaces — stock Ubuntu 23.10+ requires
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`), the CLI refuses to
run rather than fall back unsandboxed. Other platforms keep bounded-process
custody without an OS-confinement claim. The sandbox is enforcement on top of
the broker boundary, not a substitute for it.

`doctor` inspects the provider binary (explicit `XCB_CLAUDE` /
`XCB_CODEX` pin, then PATH and known install locations), requires an admitted
version — Claude Code `>= 2.1.268` within major 2, Codex's exact native build —
records the binary's SHA-256, and writes a time-boxed local admission record
binding that executable, its exact version, this runtime build, and the
capability profile digest. Any drift — a replaced binary, a new release, an
edited profile — revokes admission until `doctor` runs again. The adapter
re-proves the effective boundary on every run: `doctor`'s record is a gate,
not a sandbox attestation.

Claude is the working provider today. Codex discovery is implemented, but
managed sign-in and task admission stay gated: they require the trusted
protocol manifest and pinned parent runtime described in
[MANAGED-CODEX.md](MANAGED-CODEX.md), which a local install cannot
self-produce. `--provider codex` fails closed until that evidence exists.

## Migrating from AgentMixer

Release 0.4.0 renamed the compatibility package's public identifiers from
AgentMixer to xcb: `@hraness/agentmixer` → `@hraness/xcb`, the `agentmixer`
executable → `xcb`, `~/.agentmixer` → `~/.xcb`, `AGENTMIXER_*` environment
variables → `XCB_*`, `agentmixer.*` schema ids → `xcb.*`, `agentmixer_*`
SQLite tables → `xcb_*`, and the `AgentMixer` runtime class → `Xcb`.

Existing state is never renamed or overwritten silently:

- Run `xcb migrate` once to copy `~/.agentmixer` (or `$AGENTMIXER_STATE`) into
  the canonical root. The target must be empty; the legacy directory is left
  untouched so an older install still works — remove it yourself when ready.
- Alternatively, point `XCB_STATE` at the existing directory; the
  `agentmixer_*` SQLite tables rename to `xcb_*` lazily on first open either
  way.
- `AGENTMIXER_CLAUDE` / `AGENTMIXER_CODEX` binary pins are still honored when
  the `XCB_*` variable is unset; rename them when convenient.
- Update dependents: package imports use `@hraness/xcb`, the runtime class is
  `Xcb`, and shell invocations use `xcb`. The last AgentMixer release line is
  `@hraness/agentmixer@0.3.0` under tag `v0.3.0`.

## Application-owned capability profiles

An application can define its own tools with `createCapabilityProfile()` and
bind them to one host-selected workspace and run with `createCapabilityBroker()`.
The host supplies every descriptor, input parser and handler. Model arguments
cannot replace the bound workspace, credentials or handler implementation. This
separate interface leaves Textbutler's existing contact broker and
`Xcb.run()` path unchanged.

For example, this host stores bounded notes in memory:

```ts
import { createCapabilityProfile, createCapabilityBroker } from "@hraness/xcb";

const notes = new Map<string, unknown>();
const hostState = { active: true };
const profile = createCapabilityProfile({
  id: "notes", version: 1,
  tools: [{
    name: "notes.write", description: "Replace the bound workspace's note.",
    inputSchema: {
      type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["text"], additionalProperties: false,
    },
    parseInput(input) {
      if (typeof input.text !== "string" || !input.text.length
        || Buffer.byteLength(input.text) > 4096) throw new Error("INVALID_NOTE");
      return input;
    },
    execute(input, context) {
      context.assertActive();
      notes.set(context.workspaceId, input);
      return { stored: true };
    },
  }],
});
const broker = createCapabilityBroker({
  profile, workspaceId: "workspace-1", runId: "run-1",
  isActive: () => hostState.active,
});
await broker.invoke("notes.write", { text: "First note." });
await broker.close();
```

Profiles and their descriptors are immutable. Their SHA-256 digest binds the
profile ID, version and ordered tool descriptors, including each input schema.
It does not identify handler code or prove runtime confinement; the host must
establish that provenance and qualify the adapter for the exact profile separately.
The broker checks a closed outer input object; trusted parsers enforce the full
semantic contract. Schema descriptors do not fetch references or execute code.

Calls are serialized, and inputs are copied before queuing. JSON inputs and
outputs are bounded to 256 KiB, with structural limits; schemas are limited to
32 KiB per tool and profiles to 64 tools. Unknown tools are denied. Revocation or
an aborted signal prevents queued work and withholds late results. A trusted
handler must call `context.assertActive()` immediately before every effect,
including after its own awaits, and retain the application's conditional-write
and authorization checks. Revocation cannot undo an effect already performed.
`revoke()` stops admission immediately; `close()` also waits for admitted handlers
to settle. Neither proves that an external provider process has stopped.

Use `Xcb.runTask(request, broker)` with explicitly supplied `taskAdapters`
for application profiles. The request selects the exact route, authentication
kind, account, profile, model, reasoning effort, service tier and run limits.
The adapter needs current qualification for that exact route, runtime and profile.
No live task adapter is bundled, and a selected subscription route is never
replaced with an API route. Registering a capability profile does not enable a
provider or establish account availability.

## Opt-in Claude API route

`createClaudeApiAdapter()` is an additional, explicitly selected **Claude API**
route. It does not run Claude Code, use a coding-agent subscription, discover
accounts, or substitute itself for a selected Codex/Claude Code route. The host
executes its tool loop: API responses can invoke only the supplied broker's six
operations. No shell, subprocess, native configuration, plugin or server-side
tool is exposed. Unknown tool names receive a denied result; unexpected response
capabilities fail the run. Classification sends an empty tool array.

This adapter admits its code-enforced execution profile after checking the pinned
Anthropic SDK 0.125.0 and verifying the compiled runtime's exact bytes. The
24-hour runtime qualification describes that local authority boundary; it does
not attest live account availability or messaging delivery. Recreate an expired
adapter and refresh model availability before continuing. Native fixture receipts
play no part in API admission.

The trusted embedding host supplies `runtimeArtifact: {entrypoint, sha256}` from
its reviewed compiled distribution. The adapter verifies the physical regular
file and exact bytes, then binds the runtime identity to that digest and pinned SDK
version. A colocated self-authored manifest is not proof of authenticity: the host
must establish its distribution signature or reviewed build provenance separately.
This input must never come from contact settings or an untrusted plugin.

The host must explicitly bind a credential and supply observed prices:

```ts
const credentials = createFileClaudeApiKeyResolver({
  directory: privateCredentialDirectory,
  bindings: { "owner-api-account": "anthropic-api-key" },
});
const modelCatalog = await discoverClaudeModels({
  credentials,
  accountId: "owner-api-account",
  priceCatalog: ownerReviewedPrices,
  signal,
});
const adapter = await createClaudeApiAdapter({
  runtimeArtifact: verifiedCompiledRuntime,
  credentials,
  modelCatalog: async () => modelCatalog,
});
```

The credential directory must be physical, owned by the current user and mode
0700. Each selected file must be a single-link regular file with private read/write
permissions; it contains only the API key, optionally followed by one newline.
Files are read through bounded, checked descriptors on each use. The application
owns credential creation/removal and keeps this directory outside contact memory.
The existing explicit environment-variable resolver remains available.

Model discovery calls only the authenticated Models API. It does not send a
prompt or execute an agent. `ClaudePriceCatalog` contains `observedAt` and exact
`id`, `inputUsdPerMillion`, `outputUsdPerMillion`, `classifierEligible` entries;
prices older than 30 days are rejected. The API supplies availability and structured
output capability, not prices. Unknown/unpriced models remain excluded. The
classifier selects the lowest estimated cost from the eligible observed entries.

Requests go only to the fixed Anthropic HTTPS origin, with explicitly reconstructed
headers, no cookies, redirects, retries, custom endpoints or ambient proxy
configuration. Responses are bounded before SDK parsing. Defaults are eight
turns, 4,096 output tokens (512 for classification), a 120-second deadline and
a $0.25 conservative local reservation using supplied prices. That reservation
is not a provider billing cap. Cancellation prevents subsequent tool calls and
releases account custody once all awaited local work has stopped. Errors omit
provider response bodies and credentials.

## Gobstopper preset command shim

`src/gobstopper-editor.ts` is a source-checkout executable that backs
gobstopper's `agentic` compaction strategy through `runAgentTask()`. It reads
the normalized transcript JSON a `preset.command` receives on stdin, presents a
fixed `keep`/`elide`/`summarize`/`defer` capability profile to the cheapest
`selectClassifierModel()`-eligible Claude model through a bounded Messages-API
task adapter, and writes `{"edits": [...], "context_tokens_after": n}` on
stdout — the exact `Edit` wire shape gobstopper parses. Diagnostics go to
stderr; a nonzero exit marks failure. The shim lives in `src/` only: it is a
host integration tool, not part of the packed `dist` contract.

```toml
[presets.xcb]
strategy = "agentic"
command = "bun /path/to/xcb/src/gobstopper-editor.ts"
```

The editor tools only record the model's calls through the capability broker;
there is no filesystem, shell or network tool surface. Recorded calls lower to
`Edit` objects with `calls_to_plan` semantics: elide positions map through
`items[i].line_index` for elidable items only, summarize injects a digest,
keep is advisory, and any defer emits an empty edit list. A protected tail of
the last eight items (`GOBSTOPPER_EDITOR_PROTECT_TAIL`) is never touched.
Account custody uses a per-process SQLite lease store; no cross-process
account coordination is claimed.

Authentication needs a bound Anthropic API key — `ANTHROPIC_API_KEY` by
default, another variable via `GOBSTOPPER_EDITOR_KEY_ENV`, or an owner file via
`GOBSTOPPER_EDITOR_KEY_DIRECTORY`. Model choice comes from a fresh
host-observed catalog: `GOBSTOPPER_EDITOR_MODEL_CATALOG` points at a
ModelCatalog JSON, otherwise live Models discovery runs against the built-in
list prices (overridable via `GOBSTOPPER_EDITOR_PRICES`). `--dry-run`
validates stdin and prints an empty plan without provider work.

## Native coding-agent execution status

Managed Codex account controls are separate from agent execution.
`createManagedCodexAccountController()` provides subscription sign-in, cancellation,
sign-out, account checks and bounded model discovery through a host-supplied
account-only transport. `createCodexAccountStdioTransport()` implements the
supported app-server account protocol over an explicitly supplied process port.
Neither function launches a production process or qualifies a response adapter.
See [managed Codex account integration](MANAGED-CODEX.md) for the host contract.

`createClaudeSdkAdapter()` implements the pinned Claude Agent SDK subprocess
protocol with API-key authentication. Its execution gate requires a trusted host
qualification for the exact native executable and SDK digest. No production
qualification receipt is bundled. The default provider adapters continue to refuse
execution. `createProviderLaunchPlan()` is descriptive configuration, not a sandbox.

The installed versions are Claude Agent SDK **0.3.268**, bundled native Claude Code
**2.1.268**, Anthropic SDK **0.125.0**, MCP SDK **1.30.0**, and Zod **4.6.2**.
`inspectClaudeSdkRuntime()` checks the installed SDK version, the admitted CLI
version the host inspected (`>= 2.1.268` within major 2), native binary owner,
mode, link count and SHA-256, and returns the composite qualification identity
bound to that exact version and digest.
Every run verifies and copies executable bytes from a checked file descriptor into
its private run directory before resolving credentials. The subprocess runs that
snapshot, so replacing the configured source path cannot replace the admitted
credential-bearing executable.

The adapter creates separate private working, home, configuration and temporary
directories outside contact memory. It supplies an explicit environment, removes
all built-in tools, disables inherited settings, hooks, automatic memory, connectors,
plugins, bundled skills, workflow triggers and persistence, and configures only its in-process MCP broker. It checks the
native initialization model, version, tools, MCP servers, skills, plugins and API-key
source before admitting broker calls. A fixed plain-text prompt header prevents task text from entering native slash or bang command dispatch. Classification has no tools. The contact
folder is accessed only by host broker methods; it is never the native process cwd.

Native processes use a detached process group. Raw stdout is bounded to 1 MiB per
frame and 8 MiB total before SDK parsing; stderr is discarded and capped at 256 KiB.
Cancellation terminates the group, escalates to kill if needed, and waits for root
exit and group absence before releasing account custody. A joined failure uses
`AgentStoppedError`; an unproven exit keeps its lease and private state. These
controls do not prove confinement of a malicious native process or a descendant
that escapes its process group. Runtime qualification must cover the trusted
executable, host policy and relevant descendant behavior independently.

The host can bind an account to one explicit environment variable:

```ts
const credentials = createEnvironmentClaudeApiKeyResolver({
  "owner-api-account": "TEXTBUTLER_ANTHROPIC_API_KEY",
});
const adapter = createClaudeSdkAdapter({
  runtime: { executablePath: pinnedNativePath, executableSha256: reviewedBinarySha256 },
  stateRoot: privateProviderStateDirectory,
  credentials,
  qualification: independentlyVerifiedHostQualification,
});
```

Those paths, digest and qualification are host inputs, never contact or plugin
configuration. The resolver reads only the selected variable at invocation time;
it does not discover personal accounts, parse dotenv files, use ambient provider
keys, or borrow subscription tokens. It admits the pinned API-key format and
rejects OAuth tokens. A host Keychain integration can implement the same
`ClaudeApiKeyResolver.withApiKey()` interface without changing the broker. API keys
must remain outside contact folders, settings responses and logs. The adapter's
per-run default budget is $0.25 and deadline is 120 seconds; neither is a claim of
account-wide spend control.

`test/claude-sdk.test.ts` runs the real SDK against synthetic subprocess peers to
verify option isolation, MCP routing, zero-tool classification, output validation,
revocation and process custody. `test/provider-process.test.ts` also proves
termination of a surviving process-group descendant and raw output bounds. On
2026-09-11 the actual macOS ARM64 native CLI completed a separate control
initialization with a fresh synthetic home and no user message: the configuration
was accepted and the MCP inventory was empty. That control response contains no
built-in tool inventory and is insufficient for execution qualification.
`qualification/claude-native.ts` is the explicit adversarial native fixture with a
local synthetic Anthropic endpoint and temporary contact folders. It uses the same
restricted launch-option builder as production; the production adapter does not
accept custom API endpoints. Its receipt describes the exact fixture/runtime
boundary and never automatically enables production. The seven native scenarios
passed on macOS ARM64 on 2026-09-11, including explicit `doctor` / `checkup` Skill
denials, literal command-shaped prompts, 11 forbidden tool calls, six file escape
or stale-write denials, and a successful conditional edit and staged reply.

The [SDK skills reference](https://code.claude.com/docs/en/agent-sdk/skills)
distinguishes the discovered skill catalog from invocation permission. An empty
allowlist alone does not empty that catalog, and direct command dispatch bypasses
the allowlist. The pinned profile explicitly turns `doctor` and `checkup` off,
denies the Skill tool, wraps task text, and retains strict empty-catalog checks as
a configuration-drift guard. Native evidence checks every API request's tool
manifest and actual denied results; catalog absence alone is not a scope proof.

Codex remains unavailable in the app. The experimental `codex-config.ts`,
`codex-process.ts`, `codex-relay.ts` and `codex-session.ts` modules implement a
pinned **0.153.4** app-server driver. They have no credential discovery, live
provider transport or production adapter registration. The launcher copies the
verified executable into a private runtime directory, keeps contact folders
outside native scratch, and records process custody before protocol startup.
The trusted host must also supply an independently admitted SHA-256 for its
actual Bun 1.3.14 executable. The launcher checks that identity before startup
and after joined shutdown. Before spawning, it verifies the private scratch
directory's closed inventory, permissions, link counts and exact configuration
bytes. Version 2 custody records bind the parent runtime and scratch digests;
older records cannot supply those proofs. Runtime drift retains the run's state.
The relay checks the exact ordered tool inventory on every model request, using
the pinned native schema representation. Codex omits string-length and numeric
range hints on the wire; the broker still enforces those limits. Each result
stays bound to its native call, exact broker output and stable history identity.
The relay bounds native client metadata and removes
it before forwarding, including that field's workspace and installation
identifiers. Classification has no tools. Unsupported
response shapes fail closed; the current relay accepts a deliberately small
Responses SSE contract and is not a general provider streaming implementation.
Remote control is explicitly disabled at CLI startup. Its disabled-state
notification and bounded native timestamps carry no authority; active states and
unreviewed notifications fail the session.

The internal `codex-api-response.ts` module admits a narrow, buffered OpenAI
Responses JSON result and translates it into that three-event contract. It binds
one dated model snapshot, exact broker descriptors and an output-token cap,
preserves measured usage, and rejects incomplete responses, reasoning, duplicate
JSON keys and extra effects. It makes no HTTP request and is not an API adapter.
The host still needs credential and account custody, request construction,
billing admission, response-body cleanup and cross-response call-ID checks. No
Codex API account or model route is registered by importing it.

On 2026-09-12 the actual pinned native executable completed a scripted response
through all six broker tools and a separate zero-tool classification through
these modules. Every request carried the expected inventory; contact memory,
staged actions, process exit and listener cleanup matched the fixture. The model,
web responses and contacts were synthetic; nothing was sent or billed. These
checks establish runtime compatibility, not production qualification. Direct
filesystem and process confinement, adversarial runtime custody, and
account/model transport admission remain required. Session receipts always
report `productionQualified: false`.
Nine scripted native rejection cases also passed: foreign paths and file aliases,
stale writes, forbidden shell/skill/input tools, duplicate calls, cancellation,
an upstream deadline and malformed SSE. They verified unchanged protected
fixtures, no staged sends, and joined process, broker and listener cleanup.
An adversarial kernel helper also demonstrated that host-supplied ordinary file
descriptors and preexisting hard links retain access across sandbox startup.
Production admission must prove the launcher's clean descriptor and scratch
setup; the profile alone cannot undo authority supplied by the host.
A separate helper test under pinned Bun 1.3.14 passed on 2026-09-12: the child
had exactly three communication sockets, all four deliberately inheritable
parent descriptors were absent, and process and listener cleanup joined. That
test substituted a descriptor-inspection helper for Codex and does not qualify
the native agent itself.
See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [App Server documentation](https://learn.chatgpt.com/docs/app-server).

The [Claude custom-tools documentation](https://code.claude.com/docs/en/agent-sdk/custom-tools)
documents selecting built-ins with `tools`; `tools: []` removes that surface.
The [permissions documentation](https://code.claude.com/docs/en/agent-sdk/permissions)
explains why `allowedTools` alone only pre-approves calls. A production qualification
must also establish that managed host policy has not introduced configuration,
hooks or other authority that cannot be disabled by application settings.

`createDevinAcpAdapter()` implements the Agent Client Protocol against
`devin acp`, Devin CLI's stdio JSON-RPC server (protocol version 1, observed on
CLI 3000.10.x). Each run spawns one bounded child through the application's
`BoundedProviderProcessFactory`, initializes with `fs` and `terminal` client
capabilities unimplemented, opens one session with the host-selected workspace
cwd, applies the pinned mode and model through `session/set_mode` and
`session/set_config_option`, and completes a single `session/prompt`. The
framing codec bounds every line to 1 MiB and validates JSON-RPC envelopes,
identifiers and control characters before dispatch; prompts are bounded to
256 KiB; pending requests are capped and every write is serialized.

Devin advertises `mcpCapabilities: {http: false, sse: false}` — only stdio MCP
transports exist. Profile tools therefore reach the agent through
`startDevinToolRelay()`, a host-owned loopback endpoint admitted by a random
path and bearer token, plus a spawned inline bridge process
(`DEVIN_MCP_BRIDGE_SOURCE`) that answers `tools/list` and `tools/call` over
stdio. The bridge is a transport adapter only: the broker still enforces the
exact profile manifest, input bounds, workspace scoping and revocation.
Inbound `session/request_permission` calls are answered by the host's
permission callback; without one, the first reject option wins. `session/delete`
is never invoked by this adapter; provider sessions may persist for host
`session/load` recovery.

Custody mirrors the other task adapters: `stopAndJoin()` proves process-group
exit before account release, an unproven join fails close and retains the
lease, and protocol cleanup is never treated as termination evidence. Usage is
reduced from `usage_update` facts and the prompt result into the neutral
`AgentTaskUsage` shape; no billing or quota claim is made. `AgentProvider`
accepts `"devin"` and `createProviderLaunchPlan()` emits the Devin
configuration, but the provider remains unqualified: exact-runtime adversarial
qualification, effective tool inventory, stdio bridge custody, failure custody
and account transport/model admission are all unresolved. `test/devin-acp.test.ts`
and `test/devin-adapter.test.ts` exercise the codec, client, relay and spawned
bridge against synthetic peers only; they establish no live provider evidence.
## Per-account browser sessions

`createBrowserSession()` is the provider-neutral custody substrate for
browser-based sign-in. Each provider account gets one dedicated, persistent
Chromium-family profile under
`<stateRoot>/browser-sessions/<provider>/<accountId>/profile/` — cookies and
site state survive restarts inside that directory only, so adding or rotating
an account never touches another account's session. The profile directory is
the custody boundary: cookie contents are never exported, logged, synced, or
included in receipts.

A session binds to the exact `{provider, accountId, owner, leaseGeneration,
processGeneration}` and holds an exclusive `O_EXCL` lock for the life of the
process. A lock that outlives its process is never taken over silently — the
next launch refuses with `BROWSER_SESSION_RECOVERY_REQUIRED`, and
`recoverBrowserSession()` proceeds only after a caller-supplied
`proveStopped(binding)` returns true. Recovery removes the Chromium
`SingletonLock`/`SingletonSocket`/`SingletonCookie` trio so the profile opens
cleanly; it never deletes cookies, history, or the binding marker.
`purgeBrowserSession()` is the sign-out/revocation boundary: it destroys the
account's whole browser-session directory as a unit, and likewise requires
stop proof while any lock is held.

Launch admits only a caller-pinned executable whose SHA-256 is re-verified
from a checked descriptor before spawn. The argv is fixed: the account's
`--user-data-dir`, `--password-store=basic` (profile-local secrets, no keyring
prompts), `--disable-sync` (no vendor account bleed), and at most one
https-only navigation URL. The environment is an allowlist — locale,
identity, and GUI-attach keys only — with `HOME`/`TMPDIR` overridden to
private per-run scratch. The browser runs in its own detached process group
with bounded stdout/stderr; close escalates SIGTERM (so the profile flushes)
then SIGKILL, and the lock is released only after root exit, group absence,
stream joins, and a durable hash-chained custody journal record. An unproven
cleanup keeps the lock and the journal as recovery evidence.

Every receipt reports `productionQualified: false`: this module proves custody
and launch integrity, not browser provenance, sandbox qualification, or live
provider authentication. Those remain separate host responsibilities.

## Managed account custody

`createManagedAccountController()` is the provider-neutral account-lifecycle
port every managed provider controller shares. It owns the custody discipline
— the shared SQLite account lease, the exact `{provider, accountId, owner,
leaseGeneration, processGeneration}` binding, a serialized
unchecked → signing-in → signed-in state machine, unresolved-login recovery,
and the joined-close barrier that must prove process exit, group absence,
stream joins and settled requests before the lease is released. A transport
that loses a `startLogin` response is `recovery-required`, never a retryable
pending login, and only the proven close retires the possibly-live process.

Providers supply two ports and nothing else: a `ManagedAccountTransport`
(closed `accountRead`/`startLogin`/`cancelLogin`/`logout`/`close` — no raw
RPC, token export or turn method) and `ManagedAccountSemantics`, which
projects the provider's account payload onto the neutral readiness state.
Login methods are the closed union `provider-native` (the provider's own
flow) and `browser-session`, which binds sign-in to the caller's per-account
browser custody session — the session's provider, accountId and owner must
equal the account's, so one account's cookie jar can never authenticate
another. `readUsage()` surfaces a bounded, read-only quota observation
through an optional admitted `ManagedAccountUsageReader`: provider-named
windows with optional utilization, an exact-response SHA-256, and no
credentials or raw payloads. A missing reader returns `null` — it is not a
zero-usage claim. Nothing here is execution or authentication
qualification; provider runtime admission remains separate host evidence.

## OS-confinement port

`src/os-sandbox.ts` is the provider-neutral boundary between a closed launch
specification and the platform sandbox mechanism. A backend turns an
`OsSandboxSpec` — the admitted executable snapshot, the per-run scratch root,
an optional persistent account root, a closed read-only file list, a network
policy label and the durable policy-artifact path — into an `OsSandboxPlan`.
Planning is asynchronous so a backend can re-verify its own wrapper artifact
from a checked descriptor; the plan's `wrap()` is synchronous so it can run
inside provider SDKs that spawn from a synchronous callback. The spec rejects
relative paths, control bytes, undeclared fields, writable roots that contain
or enclose the executable, overlapping writable roots, and a policy artifact
placed inside a writable root.

Two backends ship with the port. `createSeatbeltOsSandbox()` (macOS) accepts a
host-owned reviewed SBPL generator and wraps argv as the fixed literal
`/usr/bin/sandbox-exec -f <policy> <executable> ...` — the managed Codex
launchers now plan through it, byte-identically to their previous inline
behavior. `createBwrapOsSandbox()` (Linux) re-verifies the admitted `bwrap`
binary's SHA-256 at plan time and emits private user/mount/pid/ipc/uts/cgroup/
net namespaces, per-file `--ro-bind` entries, `--bind` for the writable roots,
`--die-with-parent`, `--new-session`, `--clearenv`, and the closed environment
rebuilt in sorted `--setenv` order. Bubblewrap cannot express per-destination
egress, so on Linux `network: "provider-tcp443-dns"` is plannable only with an
admitted `egressSocket`: a host-side unix-socket CONNECT bridge bound into the
namespace as its own read-write mount. The in-sandbox runtime never performs
DNS or TCP itself — it speaks `CONNECT host:443` over the socket and the host
bridge resolves and dials, refusing every port but 443 and any host outside
the admitted exact-host allowlist. The network namespace stays unshared either
way, so the socket is the child's only egress path; without one, provider
networking still refuses to plan.

Two consumption paths exist. A cooperative in-sandbox runtime uses the public
consumer (`src/egress-client.ts`): `connectEgress` /
`connectEgressTls` / `createEgressHttpsAgent` / `fetchViaEgress` speak the
`XCB_EGRESS_SOCKET` contract directly, bound CONNECT size and response
bytes, pin TLS SNI to the target host, and refuse anything but HTTPS on 443.
A stock binary that does not know the contract gets an `egressForward` spec
entry instead: an admitted JS runtime and the shipped forwarder script become
the namespace entry point, the forwarder serves `CONNECT` on a fixed loopback
port, and the child receives `HTTPS_PROXY` — the private netns is created
empty, so the fixed port cannot collide. The bridge itself remains an
internal host seam (`src/egress-bridge.ts`), not a public export. There
is no fallback — a spec whose admitted platform the backend cannot enforce,
an unverified artifact, or an unexpressible policy refuses the plan rather
than launching unsandboxed. The spec's `platform` is admission evidence about
the runtime being launched, not the build host: a backend refuses a spec whose
declared platform it cannot enforce, so synthetic custody tests exercise the
real launch path on any host.

`createSandboxedProviderProcessFactory(plan)` composes a plan onto the
unchanged bounded-provider custody — stdout/stderr bounds, the detached
process group and SIGTERM/SIGKILL join are identical underneath every backend
— and `verifyOsSandboxExecutable()` re-checks an admitted artifact's owner,
file identity, no-follow canonical path and SHA-256. A plan proves policy
construction and artifact admission only, never kernel enforcement; receipts
continue to report `productionQualified: false`. `qualification/linux-sandbox.ts`
is the explicit kernel-boundary fixture for the bwrap backend: a statically
linked synthetic canary asserts scratch writes, foreign-path absence, a
routeless network namespace and PID-namespace isolation on the host that runs
it, and reports blocked evidence instead of guessing when the toolchain or
namespaces are unavailable. `qualification/linux-egress.ts` is the bridge
boundary's companion: the canary asserts the mounted socket answers CONNECT,
bytes tunnel through it, a foreign unix path and a direct TCP connect are
denied inside the same namespace, and the join receipt reports listener,
socket-set and path removal — against a synthetic dialer, with no resolver
or provider endpoint involved. `qualification/linux-loopback.ts` completes
the chain: a stock `curl` under `HTTPS_PROXY` traverses forwarder → bridge →
a local `openssl s_server`, proving the stock-binary path without provider
cooperation. The `Qualification` workflow runs all three on `ubuntu-24.04`
CI and uploads the JSON evidence — including the recorded fact that Ubuntu's
default AppArmor user-namespace restriction blocks bwrap entirely until the
host lifts it (`kernel.apparmor_restrict_unprivileged_userns=0`).

## Ownership boundaries

The account and task consumers accept a structural `ProviderProcessPort` through
`bindCodexAccountProcess()` and `bindCodexTaskProcess()`. Codex sessions serialize
explicit write receipts: only `accepted-full` advances the protocol. Refused,
partial, unknown or timed-out writes fail the operation without replay; cleanup
retains any outstanding write and authority work. Task finalization requires the
matching physical join plus settled transport and delivery. The host's finalizer
still owns its configuration, confinement, scratch and durable custody receipt.
Physical join alone does not prove those product facts or qualify a provider.

A trusted `CodexProcessLauncher` or `CodexManagedProcessLauncher` can return that
task bridge after preparing its exact account, task, profile and launch intent.
The Claude SDK adapter also accepts an optional synchronous `processFactory`
behind its existing runtime, credential and tool checks; omission preserves the
current bounded process owner. Factories must return an owned handle even when
readiness later fails, and may not discard a process after a launch effect. The
factory owns artifact admission, native event persistence and complete stop/join
semantics. These are source integration seams: no shared native artifact, native
managed launcher or new production qualification is bundled or implicitly enabled.

The application owns its daemon, contact enrollment, message classification policy,
conversation history, memory format, prefix formatting and Ghostget/Linq access.
Xcb owns the execution seam. The model cannot choose a workspace or contact
in broker input. `WorkspaceFiles` and `PublicWeb` are trusted host ports. Textbutler supplies its confined file implementation and uses `createPublicWeb()` by default. Custom replacements must preserve file confinement and public-network policy across DNS and every redirect. URL syntax validation alone is insufficient. The supplied web client admits public unicast addresses, rejects mixed public/private DNS answers, pins the selected address while preserving TLS hostname verification, and validates each redirect anew. It fetches bounded UTF-8 text only; it does not carry account cookies or authorization headers.

Messaging ports only stage proposed actions and return an intent ID. They must never
submit a message during composition. The application must recheck current enrollment, exact recipient/message ownership,
capability support, idempotency and authorization at its final dispatch boundary.
It must add the configured butler envelope itself. Arbitrary rich payloads,
stickers and mini apps are not admitted until a transport contract proves support.

The web client refuses ambient proxy environment variables because Bun can route
HTTPS through them despite a disabled connection pool. Its 16 KiB header limit
applies to accepted headers; Bun buffers headers before that check. The local TLS
fixture proves address pinning and certificate/hostname enforcement under Bun
1.3.14. A bounded live GET to `https://example.com/` also passed on 2026-09-11
(559 bytes with the expected page title). Tests generate their own temporary
certificate with OpenSSL and remove it afterward.

Accounts are opaque host bindings. Keep provider authentication and native runtime
state out of contact folders. Do not copy credentials into a second app or let a
contact edit provider configuration. One shared lease database can coordinate
applications only when all of them use its custody contract; this package does
not alter an existing application's running sessions or account authority.

Lease expiry indicates a missed heartbeat and never authorizes takeover. A failed
or ambiguous adapter call retains its lease. Recovery needs independent proof that
the old process/controller stopped, followed by an exact generation-conditional
release. `AbortSignal` alone does not prove process exit. A successful adapter result
must assert `processStopped: true` only after obtaining that evidence.

The current AI Charts CLI collects usage and does not execute agents, so its likely
future shared interface is sanitized usage/account metadata, not this execution
port. Account sign-in and product-provider terms need separate qualification;
[Anthropic's SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) directs
third-party product integrations to supported API authentication unless approved.

`createCodexTaskAdapter()` is the relay-backed task adapter for application
capability profiles. It requires a host `CodexResponsesUpstream`; selecting a
subscription route does not provide subscription authentication. It maps the
exact `CapabilityBroker` inventory into one Codex session, passes only host-supplied instructions and task settings, and
retains the process receipt until `Xcb.runTask()` has joined the adapter
stop and broker close. Constructing the adapter does not discover credentials,
select an account, or qualify the installed native runtime; those remain explicit
host and qualification inputs.

Each admitted execution owns its stop receipt. A busy adapter returns a failed
completion for the new request without stopping the active account. Stop requests
must match the original execution; the same or a shorter cleanup deadline is accepted.
Failures before session startup carry explicit no-session evidence. Once startup
begins, an uncertain launch or missing process-stop receipt retains account custody.

The task runtime acquires one account lease and includes its immutable
`accountLease` snapshot in the execution request. Completion and stop evidence
must match its provider, account, owner, generation and expiry. Managed adapters
and sessions also require runtime provenance through `assertAgentTaskAccountLease()`:
copying a request must preserve the original lease object and `signal`, with all
other request values unchanged. Only stop may narrow the cleanup deadline.
Reconstructing the lease from its values does not grant admission. The runtime
retires this authority when the run settles, even if uncertain cleanup retains
the account lease. A managed launcher receives that same lease and must preserve
the separate native account-lock and process-generation checks.

Task run and cleanup allowances share the task runtime's one-hour ceiling;
the legacy contact session keeps its 120-second run and 10-second cleanup limits.
IO, request-count and byte limits remain bounded separately. Unsupported task
budgets fail before session startup. Cleanup is still joined even when late;
`runTask()` reports a missed cleanup deadline instead of claiming timely closure.

Non-null reasoning effort and service tier are sent as explicit turn overrides.
The relay requires those exact selections in the model request, including when
reasoning is absent. Null settings leave the native defaults in place. Generic
task effort names follow the pinned protocol's bounded string contract, including
`ultra`; the older six-tool driver keeps its existing effort inventory.

`createCodexManagedTaskAdapter()` adds an experimental task transport for the
official Codex app-server's managed ChatGPT authentication. The host must supply
a `CodexManagedProcessLauncher` that owns the native process and keeps its
authentication state outside application workspaces. Codex owns sign-in, token
refresh and provider traffic. This adapter has no API upstream or token input.
The launcher receives the original
runtime request, including its original signal and account lease, plus a separate
`cancellationSignal`. It must revalidate request authority before preparation and
native launch; the mirrored IDs and lease grant no separate authority.

`createCodexManagedProcessLauncher()` in `src/codex-managed-process.ts` supplies
internal process candidates. Its trusted admission maps the adapter runtime
identity to native executable, schema and parent-runtime hashes. The existing
`managed-task-offline-candidate-v1` profile remains byte-for-byte unchanged and
cannot perform provider turns. Missing profile selection is refused.

The separate `managed-task-provider-tcp443-dns-candidate-v1` selection appends
only outbound access to the system resolver socket and TCP port 443, plus
metadata access to `/var` for resolver path traversal. It grants general TCP
443 access, including local or private destinations; it enforces neither TLS
nor a hostname allowlist. Native Codex remains responsible for authenticating
its provider connection. Model-requested public web access still uses the
separate bounded host broker. No additional file contents, Mach services,
listeners, forks or model tools are admitted by this profile.

Profile selection is copied before asynchronous work, and custody receipts
retain its exact tag and generated policy digest. The provider candidate records
`general-tcp443-system-resolver-var-metadata-candidate`; both candidates retain
`productionQualified: false`. Account device-code admission does not authorize
task networking. These candidates remain absent from the public barrel and
default host, and neither matching pins nor successful sign-in creates task
qualification. Native provider transport is still unproven, including the
unresolved account login request-send failure. Activation requires separate
evidence for authenticated turns, effective tool inventory, filesystem isolation
and cleanup using the exact selected task profile.

The host must first close and join account controls, then let `runAgentTask`
acquire its account lease. The process owner uses that exact lease and the
existing account marker, fixed configuration and `active.json` lock under the
same private account state root. It neither creates an account nor acquires a
second lease. Each run gets a verified immutable executable snapshot, empty
scratch HOME and cwd, closed environment and durable custody journal. Persistent
Codex state survives cleanup; contact files remain available only through the
host broker. Missing or changed configuration is preserved and refused.

Cancellation and the original execution deadline initiate joined cleanup.
An uncertain launch, process group or descriptor close retains custody. Cleanup
never signals a numeric process group after its root has been observed exiting.
The first cleanup deadline is retained across retries; later observed closure
may complete cleanup without granting another native wait budget. Filesystem
sync and removal can outlast that deadline, so the retained cleanup promise
must still join before any lease release. Receipt hash fields remain empty
until the corresponding snapshots are completed. These synthetic
custody checks do not prove native tool inventory or auth-home confinement.

The managed and account process owners admit a parent runtime of
`darwin|linux` × `arm64|x64` and select the sandbox backend from the inspected
parent platform. Darwin plans through the seatbelt backend exactly as before.
A Linux parent requires the runtime admission to carry a `sandbox` artifact —
the pinned `bwrap` executable SHA-256 plus the host-admitted read-only library
closure the copied runtime needs inside the namespace — and plans through the
bwrap backend with `network: "denied"`. A Linux parent without that artifact,
or a Darwin parent carrying one, is refused as a sandbox-admission mismatch.
A Linux provider-egress profile additionally requires a `sandbox.egress`
admission and a trusted-host `startEgressBridge` seam: the owner starts the
unix-socket CONNECT bridge inside the run directory, binds the socket into
the bwrap plan, hands the child its path as `XCB_EGRESS_SOCKET`, and
joins the bridge — listener closed, sockets joined, socket removed — before
the account lock may release. A missing admission, a missing seam, a failed
start, or an unproven join refuses or holds custody exactly like any other
launch boundary failure. Neither mechanism is qualified for production:
receipts continue to report `productionQualified: false`. The
`codex-process.ts` loopback relay stays Darwin-only
because a network-namespace cut would sever the relay socket it exists to
serve.

`runCodexManagedOfflineDiagnostic()` in the same internal module exercises the
shared process owner without fabricating task qualification. Its separate
`managed-offline-lifecycle-diagnostic-v1` admission binds declared native, schema
and parent-runtime hashes. Each call creates a fresh synthetic account in a
private child directory and acquires real SQLite leases. The offline account
helper initializes that empty home, sends no RPC, and joins before releasing its
lease. A second lease then owns the same managed process core used by tasks.
The diagnostic sends only `initialize`, `initialized` and `config/read`, checks
the fixed baseline projection and disabled remote-control notice, and closes.
It accepts no account, model, prompt, configuration map or RPC selection and
returns no process, stream, credential or task-admission authority.

One captured 60-second deadline bounds admission and native waits across both
processes; the last 15 seconds are reserved for cleanup. Filesystem cleanup may
outlast that deadline, with its raw promise still owned. Timeouts never prove closure.
Unjoined cleanup retains the actual process owners, open lease database and
journal in memory, with durable custody evidence in the returned private root.
The diagnostic does not automatically retry, release expired custody or remove
that state. Both native processes, their streams and protocol writes must join
before lease release. Journal and database closure precede a successful returned
or on-disk receipt. Its separate receipt always reports
`productionQualified: false` and `network: "denied"`; it supplies lifecycle and
configuration observations, not task execution, model-tool or auth-home isolation
qualification. It is absent from default wiring and the public barrel.

Account helpers and managed tasks share one fixed persistent configuration from
`codex-managed-baseline.ts`. Its version-one bytes remain unchanged across tasks;
the native owner must refuse a different existing file instead of overwriting it.
The task session sends its selected model, service tier and instructions through
dedicated `thread/start` fields. A closed, host-generated `config` overlay keeps
all task capability denials and supplies a non-null reasoning effort. It accepts
no caller configuration map. Non-null effort and tier also use explicit turn
overrides; null values leave native defaults in place.

The adapter defaults to unqualified. `Xcb.runTask()` refuses it before
account acquisition or process launch unless the trusted host supplies current
qualification for the exact route, runtime and capability profile. Direct
adapter calls also require qualification and a runtime-admitted request. Synthetic fixtures are not
qualification evidence and do not enable the route in Textbutler or another app.

The managed session checks ChatGPT account type, the public baseline configuration
projection and native thread settings before sending the task. `config/read`
precedes the thread overlay and does not prove the requested task selections.
Those selections must match `ThreadStartResponse` before `turn/start`; a mismatch
stops the session. The requested capability flags still require separate effective
tool-inventory evidence. Its bounded callback ledger binds tool starts, broker calls,
results and completions to one thread and turn, rejects duplicates and unsupported
native operations, and records native token usage with unknown monetary cost.
A turn-start settings notification is accepted only while that start request is
pending and must match the admitted thread controls. Repeated notifications must
be identical and remain bounded; resolved defaults are recorded only after the
matching reply, without changing the requested settings.
Cancellation revokes the broker and joins the process and admitted handlers;
uncertain stop evidence retains account custody.

An observed ChatGPT account does not distinguish native-managed storage from
externally supplied tokens. The trusted launcher must establish the authentication
mode and configuration isolation independently. Likewise, dynamic tools add a
broker surface; they do not prove that built-in tools are absent. Callback
filtering cannot prevent an unobserved built-in operation. Session receipts
therefore report `productionQualified: false` and
`exactToolInventoryObserved: false`. Live activation still requires evidence of
the effective tool inventory and host read/write confinement. The existing
relay-only process launcher's network policy is unchanged.

On 2026-09-13, Codex **0.154.0-alpha.6.2** accepted the initial managed configuration
and an empty ephemeral thread in separate native diagnostics with fresh private
state and network access denied. Configuration and thread-setting readback
passed, and root exit, process-group absence and stdio closure were verified.
The diagnostics made no account, login or turn requests. They establish
configuration and thread-response compatibility for that binary, not
authenticated execution or tool confinement.
Those diagnostics predate the shared-baseline task overlay. The combined path
still requires native validation against the exact admitted runtime.

`codexManagedStaticCatalog({ model, catalog })` prepares a single-model static
catalog for a trusted native host. Supply public `ModelsResponse` metadata for
the exact runtime and select an exact model slug. The helper refuses duplicate
slugs, missing models and non-JSON values, then returns a deeply immutable
snapshot, canonical JSON and its SHA-256. It preserves the selected model's
protocol and capability metadata while selecting direct tools and disabling
shell, patch, experimental tools, search, experimental context, subagents and
Node REPL. It performs no discovery, authentication or file I/O.

The host owns the catalog file outside model-writable workspaces and binds its
digest to the selected executable, configuration and exact model. The catalog
alone does not establish the effective tool inventory: native extensions can
register additional handlers. Managed configuration separately disables context,
token-budget/history, time, deferred-execution and permission-request tools, and
both subagent switches. These declarative controls remain subject to exact-build
native validation and do not activate the managed subscription route.

With a fixed `gpt-6-astra` catalog, local scripted-provider diagnostics on the
same binary verified empty and one-tool manifests in every request's Responses
Lite `additional_tools` input prefix. One permitted callback returned its exact
text result; nine forged built-in function calls each returned the exact
unsupported-call response. Native process, stdio and listener joins passed, and
an independent audit matched the retained binary, catalog, configuration and
wire evidence. These no-authentication diagnostics leave managed sign-in,
provider egress and production profile qualification outstanding.
