import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GithubCredential } from "../../../src/learning/contracts/index.ts";
import { LearningError } from "../../../src/learning/contracts/index.ts";
import { git, gitEnvFor } from "../../../src/learning/projects/git.ts";
import {
  githubIdentity,
  localIdentity,
  normalizeGithubUrl,
} from "../../../src/learning/projects/identity.ts";
import { cloneMirror } from "../../../src/learning/projects/mirror.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import {
  cloneFixture,
  createHarness,
  thrownBy,
  type ProjectsHarness,
} from "./harness.ts";

const CANARY = "ghp_canary_token_1234567890";

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe(code);
    },
  );
}

/**
 * AC-PRJ-15: unreadable, non-Git, corrupt and remote-404 each produce a
 * distinct structured code — never an empty success.
 */
describe("import failures", () => {
  let harness: ProjectsHarness | undefined;
  const restores: (() => void)[] = [];

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
    harness?.close();
    harness = undefined;
  });

  function scratch(name: string): string {
    const dir = path.join(harness!.paths.root, "scratch", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("maps unreadable, non-Git, corrupt and 404 to distinct codes", async () => {
    harness = await createHarness();

    // Non-Git directory.
    const plain = scratch("plain");
    fs.writeFileSync(path.join(plain, "README.md"), "# not a repo\n");

    // Corrupt `.git` entry: Git cannot resolve a repository at all.
    const corrupt = scratch("corrupt");
    fs.writeFileSync(
      path.join(corrupt, ".git"),
      "gitdir: /nonexistent/place\n",
    );

    // Unreadable: a real repository whose directory cannot be accessed.
    const copied = path.join(harness.paths.root, "scratch", "unreadable");
    fs.cpSync(fixturePath("evolution"), copied, { recursive: true });
    fs.chmodSync(copied, 0o000);
    restores.push(() => fs.chmodSync(copied, 0o755));

    const codes: string[] = [];
    for (const [candidate, expected] of [
      [plain, "invalid_input"],
      [corrupt, "object_unavailable"],
      [copied, "invalid_path"],
    ] as const) {
      await expectCode(
        Promise.resolve().then(() => localIdentity(candidate)),
        expected,
      );
      codes.push(expected);
    }

    // A path that never existed is `invalid_path` as well (AC-PRJ-02).
    await expectCode(
      Promise.resolve().then(() => localIdentity(path.join(plain, "missing"))),
      "invalid_path",
    );

    // Relative paths are rejected before touching the filesystem.
    expect(() => localIdentity("relative/path")).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    // The non-Git case carries the documented reason.
    const nonGit = thrownBy(() => localIdentity(plain));
    expect(nonGit.code).toBe("invalid_input");
    expect(nonGit.details?.reason).toBe("not_git_repo");

    // Remote 404.
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      await expectCode(
        cloneMirror(harness.paths, "github:owner/missing", {
          remoteUrl: `http://127.0.0.1:${port}/owner/missing.git`,
        }),
        "not_found",
      );
      codes.push("not_found");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // No failure shared a code with another failure class.
    expect(new Set(codes).size).toBe(4);
  });

  it("never puts the token in argv and scrubs it from stderr", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "evolution");

    const previous = process.env.CODETRAIL_GIT_TOKEN;
    process.env.CODETRAIL_GIT_TOKEN = "inherited-value-must-be-dropped";
    try {
      const plain = gitEnvFor({});
      expect(plain.CODETRAIL_GIT_TOKEN).toBeUndefined();
      expect(plain.GIT_TERMINAL_PROMPT).toBe("0");
      expect(plain.GIT_LFS_SKIP_SMUDGE).toBe("1");
      expect(plain.GIT_ASKPASS?.endsWith("scripts/git-askpass.mjs")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CODETRAIL_GIT_TOKEN;
      else process.env.CODETRAIL_GIT_TOKEN = previous;
    }

    const credential: GithubCredential = {
      kind: "token",
      token: CANARY,
      login: null,
    };
    expect(gitEnvFor({ credentials: credential }).CODETRAIL_GIT_TOKEN).toBe(
      CANARY,
    );

    // Git echoes the bad rev in stderr; the token must be scrubbed before the
    // result is returned to a caller that may log it.
    const result = await git(
      fixture.handle.path,
      ["rev-parse", `${CANARY}^{commit}`],
      { credentials: credential },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain(CANARY);
    expect(result.stderr).toContain("[redacted]");
  });

  it("does not leave a partial mirror behind when a clone fails", async () => {
    harness = await createHarness();
    const bogus = path.join(harness.paths.root, "scratch", "not-a-repo");
    fs.mkdirSync(bogus, { recursive: true });
    // `git init` is deliberately not used: the directory stays non-Git.
    await expectCode(
      cloneMirror(harness.paths, "local:" + bogus, { localPath: bogus }),
      "invalid_input",
    );
    const leftovers = fs
      .readdirSync(harness.paths.mirrors)
      .filter((entry) => entry.endsWith(".git"));
    expect(leftovers).toEqual([]);
    // Sanity: the scratch directory itself was untouched.
    expect(fs.readdirSync(bogus)).toEqual([]);
  });
});

describe("normalizeGithubUrl", () => {
  it("accepts the four supported spellings and a /tree/<ref> suffix", () => {
    const expected = {
      owner: "Owner",
      repo: "Repo",
      url: "https://github.com/Owner/Repo.git",
    };
    expect(normalizeGithubUrl("https://github.com/Owner/Repo")).toEqual(
      expected,
    );
    expect(normalizeGithubUrl("https://github.com/Owner/Repo.git")).toEqual(
      expected,
    );
    expect(normalizeGithubUrl("git@github.com:Owner/Repo.git")).toEqual(
      expected,
    );
    expect(normalizeGithubUrl("github.com/Owner/Repo")).toEqual(expected);
    expect(
      normalizeGithubUrl("https://github.com/Owner/Repo/tree/feature/x"),
    ).toEqual(expected);
    expect(githubIdentity("Owner", "Repo")).toBe("github:owner/repo");
  });

  it("rejects any other host with reason unsupported_host", () => {
    for (const input of [
      "https://gitlab.com/owner/repo",
      "git@bitbucket.org:owner/repo.git",
      "example.com/owner/repo",
    ]) {
      const error = thrownBy(() => normalizeGithubUrl(input));
      expect(error.code).toBe("invalid_input");
      expect(error.details?.reason).toBe("unsupported_host");
    }
    expect(() => normalizeGithubUrl("")).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
