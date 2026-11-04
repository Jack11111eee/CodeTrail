# Provenance of the upstream tree

Codetrail is a fork of [`langchain-ai/openwiki`](https://github.com/langchain-ai/openwiki).
This document records exactly which upstream revision the fork is based on, how
that revision was obtained, and how the claim is verified on every run.

## Pinned revision

| Field | Value |
| --- | --- |
| Repository | `https://github.com/langchain-ai/openwiki` |
| Commit | `7bb583d664f2d1c2484fa44b9d591f6103ca8166` |
| Upstream version | `0.7.2` |
| License | MIT (see [`LICENSE`](../LICENSE)) |
| Tracked files | 586 |
| Upstream test files | 205 `*.test.ts` / `*.test.tsx` under `test/` |

The commit is the upstream `main` HEAD at the time the fork was cut. It is the
only upstream revision this repository contains: no later upstream commit is
merged silently, and an upstream bump is a deliberate change that regenerates
`UPSTREAM_BASE.json` and this document together.

## How the tree was obtained

The tree was imported byte-identically from the pinned commit — no reformatting,
no line-ending conversion, no `.git` directory and no `node_modules/`:

```sh
git clone --no-checkout https://github.com/langchain-ai/openwiki /tmp/openwiki-src
git -C /tmp/openwiki-src checkout 7bb583d664f2d1c2484fa44b9d591f6103ca8166
git -C /tmp/openwiki-src archive 7bb583d664f2d1c2484fa44b9d591f6103ca8166 | tar -x
```

`git archive` emits the exact blob bytes of the commit, so the imported files are
identical to what `git cat-file blob` returns for each path upstream. The import
was confirmed by recomputing each file's Git blob hash (`sha1("blob <size>\0" +
bytes)`) and comparing it with `git ls-tree -r` of the pinned commit: 585 of 586
files match byte-for-byte; the one exception is `.gitignore`, which is a recorded
fork modification (see below) rather than an import artefact.

## How it is verified

`UPSTREAM_BASE.json` is the record. It carries the four pin fields above plus
`files: { relPath: "sha256:<hex>" }` for **all 586** upstream files and the closed
list of paths this fork is allowed to modify. The manifest is generated from the
imported bytes, never hand-written:

```sh
node -e 'const {createHash}=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const root=process.argv[1];
const paths=require("node:child_process").execFileSync("git",["ls-tree","-r","--name-only","HEAD"],{cwd:root,encoding:"utf8"}).split("\n").filter(Boolean).sort();
const files={};for(const rel of paths){files[rel]=`sha256:${createHash("sha256").update(fs.readFileSync(path.join(root,rel))).digest("hex")}`;}
console.log(JSON.stringify(files,null,2));' /tmp/openwiki-src
```

`scripts/check-provenance.mjs` (wrapped as `pnpm run provenance:check` once the
toolchain lands) is the verdict:

| Command | What it proves |
| --- | --- |
| `node scripts/check-provenance.mjs` | every recorded file still exists and hashes to its recorded digest, except for allowlisted paths |
| `node scripts/check-provenance.mjs --report` | the same, plus a JSON summary of the counts and the modification allowlist |
| `node scripts/check-provenance.mjs --self-test` | the check can actually fail: a temp copy with `src/retrieval/wiki.ts` rewritten is rejected with `unexpected_modification`, while the untouched copy passes |
| `node scripts/check-provenance.mjs --license` | `LICENSE` still holds the MIT text and the upstream copyright line, and this document still names the pinned commit and repository |

Failures are reported on stderr with a machine-readable code —
`unexpected_modification`, `manifest_incomplete`, `license_missing` or
`provenance_doc_missing` — and the process exits non-zero. Deleting a recorded
file always fails. Files this fork adds (everything under `src/learning/`,
`test/learning/`, `docs/`, `scripts/` beyond the imported three) are not in
`files` and are therefore not flagged; only upstream bytes are pinned.

`--root <dir>` re-roots the whole check, which is how the tests and the
self-test exercise a copy instead of the working tree.

## Allowed modifications

The fork may touch at most 12 upstream paths; it currently records 10, each with a
reason in `UPSTREAM_BASE.json.allowedModifications`:

| Path | Why |
| --- | --- |
| `src/ingestion/code-mode.ts` | adds `writeRepoFiles?: boolean` (default `true`) so the learning module can suppress repository-file writes |
| `src/generation/repository-run.ts` | forwards `writeRepoFiles` to `ensureCodeModeRepoSetup` at the call site inside `beginRepositoryRun` |
| `src/agent/repository-runner.ts` | forwards `writeRepoFiles` from `NativeRepositoryGenerationOptions` |
| `package.json` | fork script table, `files` excludes `dist/learning/testing`, description notes the fork |
| `tsconfig.json` | server project includes `src/learning/**/*.ts` and excludes the DOM client entry, so DOM code never type-checks against the server libs |
| `tsconfig.client.json` | compiles `src/learning/ui/client.ts` against the DOM libs |
| `README.md` | replaced by the Codetrail README |
| `src/visualize/page.ts` | adds the learning entry link to the page header |
| `src/visualize/styles.css` | styles the learning entry link |
| `.gitignore` | union of upstream and Codetrail ignore patterns |

Anything else that changes an upstream file — a reformat, a dependency bump that
rewrites the lockfile, an accidental edit — makes the check fail.

## Runtime pin

`.node-version` pins the runtime to `24.13.0`, which satisfies the upstream
`engines.node` range of `>=22.22.0`. The pin is advisory to tooling; the
launcher in `scripts/with-node.mjs` reads the same file and never mutates the
machine's default interpreter.

## License

The upstream MIT license and its copyright line are preserved verbatim in
`LICENSE`. `node scripts/check-provenance.mjs --license` fails if the MIT text,
the copyright line, the commit SHA in this document or the upstream repository
URL ever goes missing.
