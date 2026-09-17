# Contents

- `src/` owns provider-neutral routing, account leases, model selection,
  scoped tool contracts, the unqualified Devin ACP task adapter
  (`devin-acp.ts`, `devin-client.ts`, `devin-adapter.ts`, `devin-mcp.ts`),
  per-account browser-session custody (`browser-session.ts`), and the
  provider-neutral managed-account controller (`managed-account.ts`), and
  the OS-confinement port every provider launcher plans through
  (`os-sandbox.ts`; never add a silent unsandboxed fallback), and the
  host-side unix-socket CONNECT egress bridge (`egress-bridge.ts`) that makes
  `provider-tcp443-dns` plannable on Linux bwrap without unsharing the child's
  network namespace.
  `src/index.ts` is the package's complete public surface.
- `test/` contains synthetic boundary and concurrency tests.
- `qualification/` holds the host qualification fixtures and native-tooling
  checks; its `contact-workspace.ts` is a vendored synthetic fixture, not a
  Textbutler import. `linux-sandbox.ts` is the bwrap kernel-boundary probe and
  is evidence, not activation.
- `scripts/` holds the dist build, packed-package smoke check, and the
  dependency-free release writers and admission checks.
- `site/` is the informational public project page (Next.js, deployed to
  agentmixer.dev on Vercel); it has no product-runtime connection.
- `.github/workflows/` holds the read-only CI matrix and the tag-gated
  immutable release pipeline.
- `README.md`, `MANAGED-CODEX.md`, `CONTRIBUTING.md`, `SECURITY.md`, and
  `LICENSE` are the public contract.
- `docs/publishing.md` records the release and repository-protection contract.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change. The site
  has its own `bun run check` inside `site/`. Do not add another package
  manager or lockfile.
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
  `agentrouter-v*` namespaces and the `hraness/textbutler` repository identity
  are rejected by the release checks on purpose; do not reintroduce them.
- Keep the public repository independently buildable. Do not reference
  sibling checkouts, private packages, or monorepo paths.
