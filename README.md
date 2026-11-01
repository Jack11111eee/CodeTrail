# Codetrail

Codetrail is a local learning system built on a pinned fork of
[`langchain-ai/openwiki`](https://github.com/langchain-ai/openwiki). The fork is
recorded in `UPSTREAM_BASE.json` (upstream commit
`7bb583d664f2d1c2484fa44b9d591f6103ca8166`, MIT); `docs/provenance.md` explains
the reuse boundary and the closed list of allowed upstream modifications, and
`pnpm run provenance:check` verifies both.

## Requirements

- Node.js 22.22.0 or newer
- pnpm 11.25.0 (pinned in `package.json` as `packageManager`)

## Pinned Node runtime

`package.json` declares `engines.node = ">=22.22.0"` and `.node-version` pins the
development interpreter to `24.13.0`. Every JavaScript entry point in the
`package.json` script table runs through `scripts/with-node.mjs`, which resolves
an interpreter that satisfies the requirement — `CODETRAIL_NODE_BIN` first, then
the `.node-version` installs found in the usual version-manager locations, then
`node` on `PATH` — and only augments the child process `PATH`. It never installs
or switches a runtime and never writes global Node configuration, so a machine
whose ambient interpreter is too old still runs the toolchain.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run env:check` | reports the resolved Node, pnpm and SQLite FTS5 status as JSON; `--pins` also validates `engines.node`, `packageManager`, `.node-version` and the TypeScript project split, `--audit-global` checks that nothing mutates a global Node install |
| `pnpm run provenance:check` | verifies every recorded upstream file against `UPSTREAM_BASE.json` |
| `pnpm run typecheck` | type-checks the server project and the DOM project |
| `pnpm run test:upstream` | runs the vendored upstream test suite (excludes `test/learning/**`) |
| `pnpm run build` | compiles both TypeScript projects and copies the browser assets into `dist/` |

The learning module adds `fixtures`, `test:learning`, `start:learning`, `smoke`,
`accept`, `phase:check`, `backup`, `restore`, `gc` and `licenses`; each of them is
already routed through the same launcher.

## License

MIT. The vendored upstream tree keeps its own MIT license and copyright line; see
`LICENSE` and `docs/provenance.md`.
