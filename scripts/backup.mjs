#!/usr/bin/env node
/**
 * Backup (architecture §4.2, §13.2, §18; PRD §14).
 *
 *   node scripts/backup.mjs --out <dir>
 *
 * Produces a self-contained archive that contains **no secret**:
 *
 *   manifest.json            schema, source root and sha256 of every file
 *   db/codetrail.sqlite      a consistent snapshot via `VACUUM INTO` (never a
 *                            raw copy of a WAL database)
 *   knowledge/               the published generation trees
 *   git-objects/<id>.bundle  one `git bundle --all` per bare mirror
 *
 * `credentials.json`, `session.json` and `logs/` are deliberately excluded;
 * every archived file is additionally scanned for the process's known secrets
 * (the GitHub token and the session token) before the command succeeds.
 *
 * The module exports `createBackup()` for the ops test; the CLI wrapper only
 * runs when this file is the entry point.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * The data-directory algebra (architecture §4.2). The scripts cannot import
 * the TypeScript module, so the twelve members are mirrored here; the ops test
 * asserts this mirror agrees with `resolveDataPaths`.
 *
 * `canonicalize` follows the same rule as `config/paths.ts`: resolve the
 * longest existing prefix and append the not-yet-created tail. A plain
 * `realpathSync` would leave a fresh target spelled through a `/var` →
 * `/private/var` alias, which would no longer match the rewritten columns.
 */
function canonicalize(candidate) {
  let current = path.resolve(candidate);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolvePaths(env) {
  const configured = env.CODETRAIL_DATA_DIR;
  const base =
    typeof configured === "string" && configured.trim() !== ""
      ? expandHome(configured.trim())
      : path.join(os.homedir(), ".codetrail");
  const root = canonicalize(base);
  return {
    root,
    db: path.join(root, "db", "codetrail.sqlite"),
    mirrors: path.join(root, "mirrors"),
    work: path.join(root, "work"),
    knowledge: path.join(root, "knowledge"),
    staging: path.join(root, "staging"),
    external: path.join(root, "external"),
    logs: path.join(root, "logs"),
    backups: path.join(root, "backups"),
    credentials: path.join(root, "credentials.json"),
    session: path.join(root, "session.json"),
    openwikiHome: path.join(root, "openwiki-home"),
  };
}

function toPosix(value) {
  return value.replace(/\\/gu, "/");
}

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function listFilesRecursive(root, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory())
      out.push(...listFilesRecursive(absolute, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

function treeBytes(root) {
  let total = 0;
  for (const relative of listFilesRecursive(root)) {
    try {
      total += fs.statSync(path.join(root, relative)).size;
    } catch {
      // A concurrently removed file contributes nothing.
    }
  }
  return total;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      // Sealed knowledge files are 0444; the archive must be restorable by the
      // same user, so owner write is restored on the copy only.
      fs.chmodSync(to, 0o600);
    }
  }
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every secret the data directory or the environment may hold. */
function collectSecrets(paths, env) {
  const secrets = [];
  const envToken = env.CODETRAIL_GITHUB_TOKEN;
  if (typeof envToken === "string" && envToken.trim() !== "") {
    secrets.push(envToken.trim());
  }

  const credential = readJsonIfPresent(paths.credentials);
  if (credential !== null && typeof credential.token === "string") {
    secrets.push(credential.token);
  }

  const session = readJsonIfPresent(paths.session);
  if (session !== null) {
    if (typeof session === "string" && session.trim() !== "") {
      secrets.push(session.trim());
    } else if (typeof session.token === "string") {
      secrets.push(session.token);
    }
  }
  return secrets.filter(
    (secret) => typeof secret === "string" && secret.length >= 4,
  );
}

function assertNoCanary(root, secrets) {
  if (secrets.length === 0) return;
  for (const relative of listFilesRecursive(root)) {
    const absolute = path.join(root, relative);
    const buffer = fs.readFileSync(absolute);
    for (const secret of secrets) {
      if (buffer.includes(Buffer.from(secret, "utf8"))) {
        throw failure("token_canary", "a secret reached the backup archive", {
          file: toPosix(relative),
        });
      }
    }
  }
}

function gitEnv(env) {
  const clean = { ...env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
  ]) {
    delete clean[name];
  }
  return {
    ...clean,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    TZ: "UTC",
  };
}

function runGit(args, { env, cwd }) {
  const result = spawnSync("git", args, {
    cwd,
    env: gitEnv(env),
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    const detail =
      `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim();
    throw failure("git_failed", `git ${args.join(" ")} failed: ${detail}`, {
      args,
    });
  }
  return result.stdout ?? "";
}

function ensureEmptyDirectory(directory) {
  if (fs.existsSync(directory)) {
    const entries = fs.readdirSync(directory);
    if (entries.length > 0) {
      throw failure("target_not_empty", "the backup target is not empty", {
        directory,
      });
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

/**
 * Creates the archive.
 *
 * @param {{dataDir?: string, outDir: string, env?: NodeJS.ProcessEnv}} options
 */
export async function createBackup(options) {
  const env = options.env ?? process.env;
  const paths = resolvePaths(
    options.dataDir === undefined
      ? env
      : { ...env, CODETRAIL_DATA_DIR: options.dataDir },
  );
  if (!fs.existsSync(paths.root)) {
    throw failure("data_dir_missing", "the data directory does not exist", {
      root: paths.root,
    });
  }
  if (!fs.existsSync(paths.db)) {
    throw failure("database_missing", "the database does not exist", {
      db: paths.db,
    });
  }

  const outDir = path.resolve(options.outDir);
  ensureEmptyDirectory(outDir);
  fs.mkdirSync(path.join(outDir, "db"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(outDir, "knowledge"), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(outDir, "git-objects"), {
    recursive: true,
    mode: 0o700,
  });

  // `VACUUM INTO` writes a single consistent database file, including every
  // committed WAL frame; a plain `copyFile` of a live WAL database can lose
  // the tail of the log.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(paths.db);
  try {
    const target = path.join(outDir, "db", "codetrail.sqlite");
    const escaped = target.split("'").join("''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }

  if (fs.existsSync(paths.knowledge)) {
    copyTree(paths.knowledge, path.join(outDir, "knowledge"));
  }

  const bundles = [];
  if (fs.existsSync(paths.mirrors)) {
    for (const entry of fs.readdirSync(paths.mirrors, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
      const repoId = entry.name.slice(0, -".git".length);
      const bundle = path.join(outDir, "git-objects", `${repoId}.bundle`);
      try {
        runGit(
          [
            "-C",
            path.join(paths.mirrors, entry.name),
            "bundle",
            "create",
            bundle,
            "--all",
          ],
          { env, cwd: REPO_ROOT },
        );
        bundles.push({ repoId, file: `git-objects/${repoId}.bundle` });
      } catch (error) {
        // An empty mirror has no refs and `git bundle` refuses to write one;
        // it cannot contribute objects to a restore either.
        if (!/empty bundle/iu.test(String(error.message))) throw error;
      }
    }
  }

  const files = listFilesRecursive(outDir).map((relative) => {
    const absolute = path.join(outDir, relative);
    return {
      path: toPosix(relative),
      sha256: sha256File(absolute),
      bytes: fs.statSync(absolute).size,
    };
  });
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceRoot: paths.root,
    files,
  };
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const secrets = collectSecrets(paths, env);
  assertNoCanary(outDir, secrets);

  return {
    outDir,
    manifest,
    files: [
      ...files,
      {
        path: "manifest.json",
        sha256: sha256File(path.join(outDir, "manifest.json")),
        bytes: fs.statSync(path.join(outDir, "manifest.json")).size,
      },
    ],
    bundles,
    bytes: treeBytes(outDir),
  };
}

function rewritePath(value, oldRoot, newRoot) {
  if (typeof value !== "string" || value === "") return value;
  if (value === oldRoot) return newRoot;
  const prefix = `${oldRoot}${path.sep}`;
  if (value.startsWith(prefix))
    return path.join(newRoot, value.slice(prefix.length));
  // A POSIX old root on a different platform still uses "/".
  const posixPrefix = `${oldRoot}/`;
  if (value.startsWith(posixPrefix)) {
    return path.join(newRoot, value.slice(posixPrefix.length));
  }
  return value;
}

function copyFileAtomic(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, target);
}

/**
 * Restores an archive into an empty data directory.
 *
 * Rewrites the three absolute-path columns (`repos.mirror_path`,
 * `snapshots.worktree_path`, `generations.content_dir`), rebuilds every mirror
 * from its bundle and recreates the detached snapshot worktrees, so lesson,
 * conversation and source reads work over HTTP exactly as before the backup.
 *
 * @param {{fromDir: string, dataDir?: string, env?: NodeJS.ProcessEnv}} options
 */
export async function restoreBackup(options) {
  const env = options.env ?? process.env;
  const fromDir = path.resolve(options.fromDir);
  const manifestFile = path.join(fromDir, "manifest.json");
  const manifest = readJsonIfPresent(manifestFile);
  if (manifest === null || manifest.schemaVersion !== 1) {
    throw failure("manifest_invalid", "manifest.json is missing or invalid", {
      fromDir,
    });
  }

  const paths = resolvePaths(
    options.dataDir === undefined
      ? env
      : { ...env, CODETRAIL_DATA_DIR: options.dataDir },
  );
  if (fs.existsSync(paths.root) && fs.readdirSync(paths.root).length > 0) {
    throw failure("target_not_empty", "the restore target is not empty", {
      root: paths.root,
    });
  }

  for (const directory of [
    paths.root,
    path.dirname(paths.db),
    paths.mirrors,
    paths.work,
    paths.knowledge,
    paths.staging,
    paths.external,
    paths.logs,
    paths.backups,
    paths.openwikiHome,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const databaseFile = path.join(fromDir, "db", "codetrail.sqlite");
  if (!fs.existsSync(databaseFile)) {
    throw failure("database_missing", "the archive has no database", {
      fromDir,
    });
  }
  copyFileAtomic(databaseFile, paths.db);

  const knowledgeSource = path.join(fromDir, "knowledge");
  if (fs.existsSync(knowledgeSource)) {
    copyTree(knowledgeSource, paths.knowledge);
  }

  const oldRoot =
    typeof manifest.sourceRoot === "string" ? manifest.sourceRoot : "";
  const newRoot = paths.root;

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(paths.db);
  const restored = { repos: 0, snapshots: 0, generations: 0 };
  let repoRows = [];
  let snapshotRows = [];
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const updateRepo = database.prepare(
        "UPDATE repos SET mirror_path = ? WHERE repo_id = ?",
      );
      for (const row of database
        .prepare("SELECT repo_id, mirror_path FROM repos")
        .all()) {
        const rewritten = rewritePath(row.mirror_path, oldRoot, newRoot);
        if (rewritten !== row.mirror_path) {
          updateRepo.run(rewritten, row.repo_id);
          restored.repos += 1;
        }
        repoRows.push({ ...row, mirrorPath: rewritten });
      }

      const updateSnapshot = database.prepare(
        "UPDATE snapshots SET worktree_path = ? WHERE repo_id = ? AND commit_sha = ?",
      );
      for (const row of database
        .prepare("SELECT repo_id, commit_sha, worktree_path FROM snapshots")
        .all()) {
        const rewritten = rewritePath(row.worktree_path, oldRoot, newRoot);
        if (rewritten !== row.worktree_path) {
          updateSnapshot.run(rewritten, row.repo_id, row.commit_sha);
          restored.snapshots += 1;
        }
        snapshotRows.push({
          repoId: row.repo_id,
          commitSha: row.commit_sha,
          worktreePath: rewritten,
        });
      }

      const updateGeneration = database.prepare(
        "UPDATE generations SET content_dir = ? WHERE generation_id = ?",
      );
      for (const row of database
        .prepare("SELECT generation_id, content_dir FROM generations")
        .all()) {
        const rewritten = rewritePath(row.content_dir, oldRoot, newRoot);
        if (rewritten !== row.content_dir) {
          updateGeneration.run(rewritten, row.generation_id);
          restored.generations += 1;
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back.
      }
      throw error;
    }
  } finally {
    database.close();
  }

  // Rebuild mirrors from the bundles, then the detached worktrees from the
  // rewritten snapshot rows.
  const mirrorByRepo = new Map();
  const worktrees = [];
  const failures = [];
  for (const row of repoRows) {
    const target = path.isAbsolute(row.mirrorPath)
      ? row.mirrorPath
      : path.join(paths.mirrors, `${row.repo_id}.git`);
    mirrorByRepo.set(row.repo_id, target);
    const bundle = path.join(fromDir, "git-objects", `${row.repo_id}.bundle`);
    if (fs.existsSync(bundle)) {
      if (fs.existsSync(target))
        fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      runGit(["clone", "--mirror", bundle, target], { env, cwd: REPO_ROOT });
    } else if (!fs.existsSync(target)) {
      runGit(["init", "--bare", target], { env, cwd: REPO_ROOT });
    }
  }

  for (const row of snapshotRows) {
    const mirror = mirrorByRepo.get(row.repoId);
    if (mirror === undefined || !fs.existsSync(mirror)) {
      failures.push({
        repoId: row.repoId,
        commitSha: row.commitSha,
        reason: "mirror_missing",
      });
      continue;
    }
    if (fs.existsSync(row.worktreePath)) continue;
    fs.mkdirSync(path.dirname(row.worktreePath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      runGit(
        [
          "-C",
          mirror,
          "worktree",
          "add",
          "--detach",
          row.worktreePath,
          row.commitSha,
        ],
        { env, cwd: REPO_ROOT },
      );
      worktrees.push(row.worktreePath);
    } catch (error) {
      failures.push({
        repoId: row.repoId,
        commitSha: row.commitSha,
        reason: error.message,
      });
    }
  }

  return {
    dataDir: paths.root,
    restored,
    worktrees,
    failures,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    out: null,
    from: null,
    dataDir: null,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      options.out = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--out=")) {
      options.out = argument.slice("--out=".length);
    } else if (argument === "--from") {
      options.from = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--from=")) {
      options.from = argument.slice("--from=".length);
    } else if (argument === "--data-dir") {
      options.dataDir = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--data-dir=")) {
      options.dataDir = argument.slice("--data-dir=".length);
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function printError(error, command) {
  process.stderr.write(
    `${command} ${error.code ?? "failed"}: ${error.message}` +
      (error.details ? ` ${JSON.stringify(error.details)}` : "") +
      "\n",
  );
}

async function main(argv, command) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(
      command === "backup"
        ? "usage: node scripts/backup.mjs --out <dir> [--data-dir <dir>] [--json]\n"
        : "usage: node scripts/restore.mjs --from <dir> [--data-dir <dir>] [--json]\n",
    );
    return 0;
  }

  try {
    if (command === "backup") {
      if (options.out === null) throw new Error("--out is required");
      const result = await createBackup({
        dataDir: options.dataDir ?? undefined,
        outDir: options.out,
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ outDir: result.outDir, bytes: result.bytes, files: result.files })}\n`
          : `backup: ${result.outDir} (${result.files.length} files, ${result.bytes} bytes)\n`,
      );
      return 0;
    }

    if (options.from === null) throw new Error("--from is required");
    const result = await restoreBackup({
      fromDir: options.from,
      dataDir: options.dataDir ?? undefined,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `restore: ${result.dataDir} (${result.worktrees.length} worktrees, ${result.failures.length} failures)\n`,
    );
    return result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    printError(error, command);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const command = path.basename(process.argv[1]).startsWith("restore")
    ? "restore"
    : "backup";
  main(process.argv.slice(2), command).then((code) => {
    process.exitCode = code;
  });
}
