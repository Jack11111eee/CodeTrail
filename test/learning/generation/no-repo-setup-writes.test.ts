import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Fork-patch contract (AC-GEN-16 and the entry-link half of AC-FORK-03).
 *
 * The learning module generates against a repository it does not own, so every
 * generation entry point accepts `writeRepoFiles: false` and then leaves the
 * analysed checkout byte-identical: no scheduled-update workflow, no
 * `AGENTS.md`, no `CLAUDE.md`. The option is optional and defaults to the
 * upstream CLI behaviour, which the second half of every test pins down.
 *
 * The analysed tree is snapshotted as a recursive path -> sha256 map. The run's
 * own `openwiki/` output directory and `.git/` bookkeeping are excluded: the
 * generation legitimately writes its wiki there, and AC-GEN-16 is about the
 * *source* tree the caller handed over. Anything the run adds outside those two
 * directories fails the comparison.
 */

const beginCalls = vi.hoisted(() => [] as Array<{ writeRepoFiles?: boolean }>);

// Record every begin call so the runner -> lifecycle -> repo-setup path is
// proven to forward the flag, then delegate to the real implementation.
vi.mock("../../../src/generation/repository-run.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/generation/repository-run.js")
    >();
  return {
    ...actual,
    async beginRepositoryRun(
      ...args: Parameters<typeof actual.beginRepositoryRun>
    ) {
      beginCalls.push(args[0]);
      return actual.beginRepositoryRun(...args);
    },
  };
});

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runNativeRepositoryGeneration } from "../../../src/agent/repository-runner.js";
import { ClaimsStore } from "../../../src/claims/brains/code/store.js";
import { beginRepositoryRun } from "../../../src/generation/repository-run.js";
import { ensureCodeModeRepoSetup } from "../../../src/ingestion/code-mode.js";
import { PAGE, STATIC_PAGE } from "../../../src/visualize/page.js";

const execFileAsync = promisify(execFile);
const WORKFLOW_PATH = ".github/workflows/openwiki-update.yml";
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];
const SNIPPET_START = "<!-- OPENWIKI:START -->";
const HAND_WRITTEN_AGENTS =
  "# Hand-written agent notes\n\nKeep this file exactly as written.\n";
const HAND_WRITTEN_CLAUDE =
  "# Team notes\n\nKeep this file exactly as written.\n";
const ACTOR = { producerActor: "host-agent/test", metadataModel: "test-model" };

const temporaryDirectories: string[] = [];

/**
 * Runs one Git command in a temporary test repository.
 *
 * @param root - Absolute temporary repository root.
 * @param args - Git arguments excluding the executable name.
 * @returns Trimmed standard output.
 */
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

/**
 * Creates one empty directory that is cleaned up after the test.
 *
 * @returns Absolute temporary directory path.
 */
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codetrail-fork-patches-"));
  temporaryDirectories.push(root);
  return root;
}

/**
 * One valid factual OpenWiki Markdown page.
 *
 * @param title - Human-readable page title.
 * @returns Complete valid page Markdown.
 */
function validPage(title: string): string {
  return `---\ntype: Guide\ntitle: ${title}\n---\n\n# ${title}\n`;
}

/**
 * sha256 digest of one file, in the same `sha256:<hex>` shape the provenance
 * manifest uses.
 *
 * @param absolutePath - Absolute file path.
 * @returns Digest string.
 */
async function fileDigest(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Recursive path -> sha256 map of the analysed source tree.
 *
 * `.git/` (Git bookkeeping) and the root `openwiki/` directory (the run's own
 * generated output) are skipped; everything else is compared exactly.
 *
 * @param root - Absolute repository root.
 * @returns Sorted record of relative path to content digest.
 */
async function snapshotAnalysedTree(
  root: string,
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  const walk = async (directory: string): Promise<void> => {
    const dirents = await readdir(directory, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = path.join(directory, dirent.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === ".git" || relative === "openwiki") {
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        entries[relative] = `symlink:${await readlink(absolute)}`;
        continue;
      }
      entries[relative] = await fileDigest(absolute);
    }
  };

  await walk(root);
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

/**
 * Paths that appeared, disappeared, or changed between two snapshots.
 *
 * @param before - Snapshot taken before the run.
 * @param after - Snapshot taken after the run.
 * @returns The three difference lists.
 */
function diffSnapshots(
  before: Record<string, string>,
  after: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  return {
    added: Object.keys(after).filter((entry) => !(entry in before)),
    removed: Object.keys(before).filter((entry) => !(entry in after)),
    changed: Object.keys(before).filter(
      (entry) => entry in after && before[entry] !== after[entry],
    ),
  };
}

/**
 * Whether a path exists, without following symlinks.
 *
 * @param absolutePath - Absolute path to test.
 * @returns True when the path exists.
 */
async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a committed repository with a generated wiki plus hand-written
 * `AGENTS.md` and `CLAUDE.md` files, but no code-mode setup files.
 *
 * The hand-written agent files are the "pre-existing file must not be
 * rewritten" case: they are committed before the run and their bytes must
 * survive. `CLAUDE.md` exists because upstream only refreshes that file when it
 * is already present; it never creates one.
 *
 * @returns Absolute temporary repository root.
 */
async function createRepository(): Promise<string> {
  const root = await temporaryDirectory();
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Fork Patch Test"]);
  await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), HAND_WRITTEN_AGENTS, "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), HAND_WRITTEN_CLAUDE, "utf8");
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    validPage("Quickstart"),
    "utf8",
  );

  const claimsStore = new ClaimsStore(root);
  for (const page of await claimsStore.discoverPages()) {
    await claimsStore.writePage(page, {
      schemaVersion: 1,
      pageVersion: await claimsStore.hashPage(page),
      claims: [],
      verification: { by: "openwiki/test", at: "2026-08-23T12:00:00.000Z" },
    });
  }

  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(root, "openwiki", ".last-update.json"),
    `${JSON.stringify(
      {
        updatedAt: "2026-08-23T12:00:00.000Z",
        command: "update",
        gitHead: head,
        model: "previous-model",
        status: "complete",
        language: "en",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

beforeEach(() => {
  beginCalls.length = 0;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ensureCodeModeRepoSetup writeRepoFiles", () => {
  test("omitted option keeps the upstream CLI behaviour", async () => {
    const root = await temporaryDirectory();

    await ensureCodeModeRepoSetup(root);

    // Upstream creates AGENTS.md and deliberately leaves CLAUDE.md absent so
    // the created file is not shadowed.
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(root, "CLAUDE.md"))).toBe(false);
    // `createWorkflow` is what gates the workflow, exactly as before.
    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(false);
  });

  test("createWorkflow still writes the workflow when the option is omitted", async () => {
    const root = await temporaryDirectory();

    await ensureCodeModeRepoSetup(root, { createWorkflow: true });

    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(true);
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  test("writeRepoFiles: true keeps the upstream CLI behaviour", async () => {
    const root = await temporaryDirectory();

    await ensureCodeModeRepoSetup(root, {
      createWorkflow: true,
      writeRepoFiles: true,
    });

    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(true);
    expect(await exists(path.join(root, "AGENTS.md"))).toBe(true);
    expect(await exists(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  test.each([
    { label: "workflow requested", createWorkflow: true },
    { label: "workflow not requested", createWorkflow: false },
  ])(
    "writeRepoFiles: false writes nothing ($label)",
    async ({ createWorkflow }) => {
      const root = await temporaryDirectory();
      const before = await snapshotAnalysedTree(root);

      await ensureCodeModeRepoSetup(root, {
        createWorkflow,
        writeRepoFiles: false,
      });

      expect(await snapshotAnalysedTree(root)).toEqual(before);
      // Not even the parent directory: `git add .github` must never stage it.
      expect(await exists(path.join(root, ".github"))).toBe(false);
      for (const file of AGENT_FILES) {
        expect(await exists(path.join(root, file))).toBe(false);
      }
    },
  );
});

describe("beginRepositoryRun writeRepoFiles", () => {
  test("init with writeRepoFiles: false adds nothing to the analysed tree", async () => {
    const root = await createRepository();
    const before = await snapshotAnalysedTree(root);

    const result = await beginRepositoryRun({
      root,
      mode: "init",
      writeRepoFiles: false,
      actor: ACTOR,
    });

    expect("run" in result).toBe(true);
    expect(diffSnapshots(before, await snapshotAnalysedTree(root))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(false);
    // The pre-existing agent files were not even refreshed.
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(
      HAND_WRITTEN_AGENTS,
    );
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(
      HAND_WRITTEN_CLAUDE,
    );
  });

  test("update with writeRepoFiles: false adds nothing to the analysed tree", async () => {
    const root = await createRepository();
    const before = await snapshotAnalysedTree(root);

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      force: true,
      writeRepoFiles: false,
      actor: ACTOR,
    });

    expect("run" in result).toBe(true);
    expect(diffSnapshots(before, await snapshotAnalysedTree(root))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(false);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(
      HAND_WRITTEN_AGENTS,
    );
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(
      HAND_WRITTEN_CLAUDE,
    );
  });

  test("init with the option omitted keeps writing the workflow and agent files", async () => {
    const root = await createRepository();

    await beginRepositoryRun({ root, mode: "init", actor: ACTOR });

    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(true);
    for (const file of AGENT_FILES) {
      expect(await readFile(path.join(root, file), "utf8")).toContain(
        SNIPPET_START,
      );
    }
  });

  test("update with the option omitted still refreshes the agent files only", async () => {
    const root = await createRepository();

    await beginRepositoryRun({
      root,
      mode: "update",
      force: true,
      actor: ACTOR,
    });

    // `--update` leaves the workflow alone, upstream behaviour.
    expect(await exists(path.join(root, WORKFLOW_PATH))).toBe(false);
    for (const file of AGENT_FILES) {
      expect(await readFile(path.join(root, file), "utf8")).toContain(
        SNIPPET_START,
      );
    }
  });

  test("runNativeRepositoryGeneration forwards writeRepoFiles to the lifecycle", async () => {
    // A missing root is enough: the forwarded flag is recorded before the
    // lifecycle rejects, so the assertion never depends on a real generation.
    const root = path.join(await temporaryDirectory(), "missing");

    await runNativeRepositoryGeneration({
      root,
      mode: "init",
      modelId: "test-model",
      model: {} as unknown as BaseChatModel,
      writeRepoFiles: false,
    }).catch(() => undefined);

    expect(beginCalls).toHaveLength(1);
    expect(beginCalls[0]).toMatchObject({
      root,
      mode: "init",
      writeRepoFiles: false,
    });
  });
});

describe("visualizer learning entry", () => {
  test("PAGE stays a constant string with the learning-entry anchor", () => {
    expect(typeof PAGE).toBe("string");
    expect(PAGE).toContain(
      '<a href="/learn" data-testid="learning-entry">在 Codetrail 中学习</a>',
    );
    expect(STATIC_PAGE).toContain('data-testid="learning-entry"');
  });

  test("PAGE adds no inline script or style element", () => {
    // Four pinned CDN scripts plus the module entry point: the same count the
    // upstream page test asserts. The link must not smuggle in a handler.
    expect(PAGE.split("<script").length - 1).toBe(5);
    expect(STATIC_PAGE.split("<script").length - 1).toBe(5);
    expect(PAGE).not.toMatch(/<style\b/u);
    expect(STATIC_PAGE).not.toMatch(/<style\b/u);
  });
});
