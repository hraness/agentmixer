# Contributing

xcb is in development. Preserve checkable custody, qualification, and bounded
tool contracts. Native xcb lives in `crates/`; the retained TypeScript library
and compatibility CLI live in `src/`. The informational Next.js site is `site/`.

## Setup

Install Rust 1.97.1 (see `rust-toolchain.toml`), Bun 1.3.14, and Node 22.13 or
newer for compatibility checks; the site targets Node 24. Run
`bun install --frozen-lockfile` in the root and separately in `site/`.
Native tests that verify cross-runtime workspace locks need Bun and Node on PATH.

## Checks

From the repository root:

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
bun run check
```

The compatibility check includes typechecking, tests, the dist build, and the
packed-package install smoke check. For site changes, run `bun run check`
inside `site/`; it verifies theme snapshots, synchronizes README documentation,
runs tests, lint and typechecking, and builds and serves the production site.
Follow the host scheduler rules in `AGENTS.md` where applicable. Synthetic
checks do not qualify live providers; keep unqualified adapters disabled.

## Rules of the house

- Parse foreign values from `unknown`; reject unknown keys.
- Keep broker inputs closed and bounded. No shell, executable, or arbitrary RPC
  enters the model-facing tool surface.
- Never treat a prompt, cwd, tool list, or expired lease as OS isolation or
  proof of process termination. Retain account custody after uncertain failures.
- Qualify the exact runtime, effective tool inventory, and confinement before
  activation. Keep published release claims distinct from source version numbers.
- Keep credentials, provider state, and qualification receipts out of workspaces
  and commits. Do not include transcript text or secrets in bug reports.
- Open a pull request; do not force-push.

Use GitHub issues for bugs and [SECURITY.md](SECURITY.md) for vulnerabilities.
