# Contributing

AgentMixer is early and the contract is deliberately narrow. Contributions are
welcome; the bar is that the custody, qualification, and tool-surface
invariants stay checkable.

## Setup

Requires Bun ≥ 1.3.14 (`bun install`). The site under `site/` has its own
`bun install` and check suite.

## Checks

```sh
bun run check
```

Runs the typechecker, the test suite, the dist build, and the packed-package
smoke check. Site changes run `bun run check` inside `site/` — that covers the
paper-theme snapshot verification, README sync, tests, lint, typecheck, and
the production build.

## Rules of the house

- Parse every foreign value from `unknown`; reject unknown keys.
- Keep broker inputs closed and bounded. No shell, executable, or arbitrary
  RPC operation enters the tool surface.
- Never treat a prompt, a working directory, a tool list, or an expired lease
  as proof of OS isolation or process termination.
- Preserve exclusive account custody after uncertain provider failures.
- Qualification admits an exact runtime; it is not a portability promise.
- Open a pull request; do not force-push.

## Bugs and security

Use GitHub issues for bugs. For security reports, see `SECURITY.md`.
