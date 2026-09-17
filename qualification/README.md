# Native Claude fixture

An additional experimental kernel probe compiles a disposable C helper and
checks a default-deny macOS Seatbelt profile using only synthetic files and a
local endpoint:

```sh
oompa-host-run --mode=shared --lane=mac-native --label=agentmixer-kernel-boundary-probe -- bun qualification/macos-sandbox.ts
oompa-host-run --mode=shared --lane=mac-native --label=agentmixer-native-claude-os-scope -- bun qualification/claude-native.ts --os-sandbox
```

The second command applies that same experimental profile to the actual native
Claude fixture below. Neither command enables a production adapter or issues a
production qualification. The profile allows only the pinned executable,
specified system libraries and loader paths, private scratch directories, standard
I/O descriptors, and one local TCP port. The helper checks foreign file, directory
and FIFO reads, foreign writes, process creation, other executables and other
network ports. Re-execution of the same pinned binary is permitted by the profile;
fork and other executable paths remain denied. This is an explicit diagnostic
for the current Mac, not a portable sandbox guarantee. Production use also needs
a reviewed provider relay and exact distribution/account admission.

Current result on the tested Darwin ARM64 host (re-verified 2026-09-17): the
converged kernel helper passes its nine checks, the bounded
`macos-native-bootstrap.ts` diagnostic runs the pinned executable's `--version`
and completes the SDK `--initialize` control handshake under the experimental
profile, and the full `claude-native.ts` fixture passes all seven scenarios under
`--os-sandbox` — see `2026-09-17-darwin-arm64.json`. The experimental profile
learned three grants the real binary needs that the earlier revision lacked:
`file-read-metadata` on the `/tmp`/`/private/tmp` literals (Claude's mkdirp
stat-walk for its per-user `claude-<uid>` dir — Seatbelt evaluates metadata ops
on the unresolved path while data ops report canonicalized paths), ancestor
metadata for each scratch root, and the reviewed resolver surface
(`/etc`/`timezone`/`usr/share` reads, opendirectoryd + DNSConfiguration lookups,
mDNSResponder/syslog sockets) behind a `runtimeSurface` flag. Egress stays
pinned to the synthetic loopback port; `git`/`sh` exec and real-home reads
remain denied and are part of what the fixture proves. All evidence stays
synthetic — zero paid model requests, no real credentials — and remains no
native production qualification.

Run the explicit fixture on macOS ARM64 through the installed host scheduler:

```sh
oompa-host-run --mode=shared --lane=mac-native --label=agentmixer-native-claude-scope -- bun qualification/claude-native.ts
```

It runs the actual pinned native Claude Code binary through the real Agent SDK,
using a fresh synthetic home, fake API key, local synthetic Anthropic Messages
endpoint and disposable synthetic contact folders. It does not load a real account
or make paid model calls. It shares the production restricted option builder;
custom endpoints are confined to this fixture.

The scenarios verify zero-tool classification; denied built-in command, file,
agent, skill, network and tool-discovery calls; allowed broker conditional edits
and staged replies; and rejected absolute/traversal/symlink/hardlink reads and
stale or escaping writes. Explicit Skill `doctor` / `checkup` calls must return
errors, and wrapped `/doctor`, `/checkup` and bang commands must reach the synthetic
API as the exact literal task text. Every request must advertise the exact broker
manifest. Poisoned settings, hook, MCP and instruction fixtures
exercise inheritance. A sibling canary and command marker detect effects, and
actual native tool results establish denial independently of absent effects.

A successful JSON receipt records the binary/SDK identity, platform and exact
scenarios. It is **not** a production qualification receipt. Its scope is the
model-visible tool boundary in this synthetic environment. It does not prove an
OS sandbox against a compromised provider executable, exclusion of every managed
system policy, prohibition of process-group escape by trusted helpers, or live
provider/model/account behavior. Do not convert it into `RuntimeQualification`
without reviewing the deployment's remaining requirements and evidence.

The fixture uses the vendored `contact-workspace.ts` synthetic contact
workspace, a copy of the consumer's confined file boundary, because consumers
supply the filesystem enforcement. Agentmixer itself continues
to depend only on its generic file broker port.

The pinned native runtime retains `doctor` in its discovery catalog with only an
empty skills allowlist. The shared production builder also sets the documented
`skillOverrides` for `doctor` and `checkup` to `off`; the native fixture proves those
restrictive settings and keeps the empty catalog assertion intact. The
[SDK skills documentation](https://code.claude.com/docs/en/agent-sdk/skills) explains
why discovery metadata and execution authority are different.

## Live Claude subscription smoke

`2026-09-17-live-claude-subscription.json` records one user-operated CLI turn
against the real Claude subscription service. The exact admitted 2.1.268 runtime
returned the required text from `claude-sonnet-4-5`; the completed transcript was
persisted only after the bounded provider process joined, and the per-run runtime
snapshot and Seatbelt policy were then removed. The receipt binds the public main
tree, runtime, profile and local admission digests. It records no token, account
identity, authorization URL, local path or session identifier.

This closes evidence for one authenticated live-provider turn on the tested
Darwin host. It does not measure subscription usage, qualify other models or
hosts, activate a production deployment, or turn the local seven-day CLI
admission into a general production qualification. The synthetic confined fixture
above remains the independent evidence for effective tool inventory and escape
denials; the live smoke does not replace it.
