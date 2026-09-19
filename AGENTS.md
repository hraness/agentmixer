# Contents

- `crates/` owns the native xcb (Excalibur) Rust kernel, local runtime, Ratatui
  frontend, and CLI. Panes are bounded userspace data; executable hooks require
  separate trust. Keep local metering separate from opt-in aiCharts publishing.
- `src/` owns provider-neutral routing, account leases, model selection,
  scoped tool contracts, the unqualified Devin ACP task adapter
  (`devin-acp.ts`, `devin-client.ts`, `devin-adapter.ts`, `devin-mcp.ts`),
  per-account browser-session custody (`browser-session.ts`), and the
  provider-neutral managed-account controller (`managed-account.ts`), and
  the OS-confinement port every provider launcher plans through
  (`os-sandbox.ts`; never add a silent unsandboxed fallback), and the
  host-side unix-socket CONNECT egress bridge (`egress-bridge.ts`) that makes
  `provider-tcp443-dns` plannable on Linux bwrap without unsharing the child's
  network namespace — plus its two consumers: the public `egress-client.ts`
  for cooperative runtimes and `sandbox/loopback-forwarder.cjs`, the shipped
  in-namespace forwarder that gives stock binaries standard `HTTPS_PROXY`
  egress through the socket — plus `judge.ts`, the provider-neutral jev-style
  judgment port (`ask(state, questions)` → typed answers) with the System One
  backend and the cross-platform local key vault. A judge orders
  already-admitted routes and may veto auto-continuation only after every
  deterministic safety gate passes; it never qualifies or activates a provider.
  `src/index.ts` is the package's complete public surface.
- `src/cli/` is the standalone `xcb` terminal surface (`cli.ts` entry,
  chat/run/resume/sessions/doctor/auth/judge/migrate commands) built on the same
  task runtime; `claude-task-adapter.ts` and `cli/sandbox.ts` own the
  seatbelted subscription route it drives. `cli/state.ts` resolves `~/.xcb`
  (env `XCB_STATE`) and owns the explicit `migrate` copy from legacy
  `~/.agentmixer`; SQLite `agentmixer_*` tables rename lazily at open.
- `test/` contains synthetic boundary and concurrency tests.
- `qualification/` holds the host qualification fixtures and native-tooling
  checks; its `contact-workspace.ts` is a vendored synthetic fixture, not a
  Textbutler import. `linux-sandbox.ts` is the bwrap kernel-boundary probe,
  `linux-egress.ts` is the CONNECT-bridge boundary probe, and
  `linux-loopback.ts` is the stock-binary forwarder probe; all are evidence,
  not activation. The `Qualification` workflow runs them on `ubuntu-24.04`
  and uploads the JSON evidence.
- `scripts/` holds the dist build, packed-package smoke check, and the
  dependency-free release writers and admission checks.
- `site/` is the informational xcb product page (Next.js, canonical origin
  xcb.dev); it has no product-runtime connection. The `@hraness/xcb`
  TypeScript package and its verified publication datum remain a separate
  compatibility surface.
- `.github/workflows/` holds the read-only CI matrix and the tag-gated
  immutable release pipeline.
- `README.md`, `MANAGED-CODEX.md`, `CONTRIBUTING.md`, `SECURITY.md`, and
  `LICENSE` are the public contract.
- `docs/publishing.md` records the release and repository-protection contract.

# Guidelines

- Use Bun 1.3.14 for the compatibility package and site, and Rust 1.97.1 for
  native xcb. The owner selected a full Rust migration; Cargo.lock is the
  native dependency lock and bun.lock remains the JavaScript lock. Run
  `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets
  --locked -- -D warnings`, `cargo fmt --all -- --check`, and `bun run check`.
  The site has its own `bun run check` inside `site/`.
- Keep account credentials and provider runtime state outside consumer
  workspaces. Resolve authentication through a trusted host adapter.
- Never equate a prompt, cwd, tool list or expired lease with OS isolation or
  proof that a process stopped.
- Admit a provider only after the host proves the exact runtime, effective tool
  inventory, configuration isolation and read/write confinement. Unqualified
  adapters remain disabled.
- Keep broker inputs closed and bounded; applications own filesystem custody
  and messaging authorization.
- Preserve exclusive account custody after uncertain provider failures.
  Require independent process-exit evidence before recovery.
- Releases use the `v<version>` tag channel and the single-package release
  contract in `docs/publishing.md`. The former scoped `agentmixer-v*` /
  `agentrouter-v*` / `xcb-v*` namespaces and the `hraness/textbutler`
  repository identity are rejected by the release checks on purpose; do not
  reintroduce them.
- Keep the public repository independently buildable. Do not reference
  sibling checkouts, private packages, or monorepo paths.

<!-- oompa-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Retain account two-factor authentication and provider controls, including required authentication for approval of an exact staged artifact; do not add long-lived personal tokens to eliminate an interactive prompt.
- Keep delivery gates proportional to the failure they prevent. Prefer required checks on the current integration candidate, independent agent review, and atomic or conditional integration. Add a merge queue or another approval stage only for a demonstrated coordination or safety need. Replace redundant queues, serial waits, and duplicate checks through reviewed policy changes while retaining evidence for the integrated result.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$oompa-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- oompa-local-efficiency:end -->

# Workspace write coordination

- Native and compatibility workspace writers share a private SQLite lock database
  per canonical UTF-8 workspace path. The default root is
  `~/.local/share/xcb-coordination`; `XCB_COORDINATION_ROOT` is a trusted host
  override that must agree across cooperating processes, independently of their
  application state roots. Tests use explicit isolated coordination roots.
- The lock database name is the workspace path's lowercase SHA-256 plus
  `.sqlite`. Keep DELETE journal mode and hold `BEGIN IMMEDIATE` through revision
  checking, publication, and directory sync. Never remove an active coordination
  database or treat this filesystem lock as account/process-exit evidence.
- Keep the in-process serialization around coordination database setup and use.
  Closing an unrelated descriptor for the same SQLite file can release POSIX
  record locks held by that process. New-file publication must remain
  no-clobber; cooperating replacements preserve ordinary permission bits.
- Native broker integration tests exercise actual Bun and Node lock owners and
  process-exit release. Run them with the repository's Bun and Node toolchains
  available on PATH. These guarantees cover cooperating broker writers, not
  arbitrary editors or processes that bypass the coordination protocol.
- Compatibility lease recovery requires an independently established host stop
  witness bound to the exact lease; an absent argv marker or elapsed TTL is not
  sufficient. Legacy leases without such a witness remain held.
