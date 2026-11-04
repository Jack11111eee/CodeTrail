import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Accessors for the deterministic fixtures built by `scripts/make-fixtures.mjs`
 * (PRD §15.3, architecture §17.4).
 *
 * Deliberately self-contained: it imports nothing from `src/learning/**`, so a
 * test can read a fixture even before the learning implementation exists.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Where `pnpm run fixtures` writes when no override is set. */
export const DEFAULT_FIXTURES_DIR = path.join(REPO_ROOT, ".tmp/fixtures");

/** Names emitted by the fixture script, in build order. */
export const FIXTURE_NAMES = [
  "last-mile-mini",
  "numbering-schema",
  "evolution",
  "planned-vs-implemented",
  "injection-repo",
  "scope-hygiene",
  "library-noui",
  "polyglot",
  "local-unpushed",
  "watch-remote.git",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

/**
 * Root holding every fixture repository.
 *
 * `CODETRAIL_FIXTURES_DIR` is the script's `--out` directory, so the fixtures
 * themselves live one level down in `fixtures/`.
 */
export function fixturesDir(): string {
  const override = process.env.CODETRAIL_FIXTURES_DIR;
  if (override && override.trim() !== "") {
    return path.join(path.resolve(override), "fixtures");
  }
  return DEFAULT_FIXTURES_DIR;
}

/** Absolute path to one fixture repository. */
export function fixturePath(name: string): string {
  return path.join(fixturesDir(), name);
}

/** `file://` URL usable as a clone/fetch source (PRD §15.2 item 5). */
export function fixtureRemote(name: string): string {
  return pathToFileURL(fixturePath(name)).href;
}

function isBare(name: string): boolean {
  return name.endsWith(".git");
}

/** Fixed identity used by `scripts/make-fixtures.mjs` for every fixture commit. */
const FIXTURE_AUTHOR = {
  name: "Codetrail Fixtures",
  email: "fixtures@codetrail.invalid",
};

/**
 * Environment for read-only Git commands run against a fixture.
 *
 * Fixtures are built with a fixed identity and `core.autocrlf=false` under
 * `GIT_CONFIG_NOSYSTEM=1`/`GIT_CONFIG_GLOBAL=/dev/null` (see
 * `scripts/make-fixtures.mjs`). These assertions must not depend on the
 * developer's `~/.gitconfig`, so `diff.renames` (which changes `diff
 * --name-status` output) and `log.showSignature` cannot leak in. Repository
 * location variables are dropped for the same reason the script drops them:
 * they can be inherited from a running hook.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ]) {
    delete env[name];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...env,
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    GIT_TERMINAL_PROMPT: "0",
  };
}

const GIT_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "commit.gpgsign=false",
];

function git(name: string, args: string[]): string {
  const repo = fixturePath(name);
  const location = isBare(name) ? ["--git-dir", repo] : ["-C", repo];
  return execFileSync("git", [...location, ...GIT_CONFIG, ...args], {
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Resolves a revision in a fixture repository. */
export function fixtureSha(name: string, rev = "HEAD"): string {
  return git(name, ["rev-parse", rev]);
}

/** Runs an arbitrary read-only Git command inside a fixture. */
export function fixtureGit(name: string, args: string[]): string {
  return git(name, args);
}

export interface FixtureManifestEntry {
  path: string;
  bare: boolean;
  head: string;
  refs: Record<string, string>;
}

export interface FixtureManifest {
  generatedBy: string;
  author: { name: string; email: string };
  epoch: string;
  fixtures: Record<string, FixtureManifestEntry>;
}

/** Reads `fixtures/manifest.json`; throws a runnable hint when it is missing. */
export function fixtureManifest(): FixtureManifest {
  const file = path.join(fixturesDir(), "manifest.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `fixtures are missing at ${fixturesDir()}; run \`pnpm run fixtures\` first`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as FixtureManifest;
}

/** Fails early with an actionable message when the fixtures were not built. */
export function requireFixtures(): string {
  const dir = fixturesDir();
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error(
      `fixtures are missing at ${dir}; run \`pnpm run fixtures\` first`,
    );
  }
  return dir;
}
