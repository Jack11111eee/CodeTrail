import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyCursor,
  type ProjectId,
  type RepoId,
  type Repositories,
} from "../../../src/learning/contracts/index.ts";
import {
  createRepositories,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import {
  AT,
  closeTempDb,
  createTempDb,
  makeChange,
  makeGeneration,
  makeLesson,
  makeSource,
  type TempDb,
} from "./helpers.ts";

describe("store transactions", () => {
  let ctx: TempDb;
  let writer: Repositories;

  beforeEach(() => {
    ctx = createTempDb();
    writer = createRepositories(ctx.db);
  });

  afterEach(() => {
    closeTempDb(ctx);
  });

  it("publishes generation, lessons, sources, event state and cursor all-or-nothing", () => {
    const reader = openDatabase({ file: ctx.file });
    const readerRepos = createRepositories(reader);
    try {
      writer.changes.insertMany([
        makeChange({ eventId: "e_1", state: "discovered" }),
      ]);

      ctx.db.transaction(() => {
        writer.generations.insertPublished(
          makeGeneration({ generationId: "g_pub", cacheKey: "ck_pub" }),
        );
        writer.lessons.insertMany([makeLesson({ generationId: "g_pub" })]);
        writer.sources.insertMany([makeSource({ generationId: "g_pub" })]);
        writer.changes.setState("e_1", "published", { publishedAt: AT });
        writer.cursors.put({
          repoId: "r_1" as RepoId,
          streamId: "default_branch",
          kind: "published",
          cursor: { ...emptyCursor("default_branch"), headSha: "head-1" },
          expectedPrevious: null,
        });

        // Nothing is visible to a second connection until COMMIT.
        expect(readerRepos.generations.byId("g_pub")).toBeNull();
        expect(readerRepos.lessons.listByGeneration("g_pub")).toEqual([]);
        expect(readerRepos.sources.all("g_pub")).toEqual([]);
        expect(readerRepos.changes.byId("e_1")?.state).toBe("discovered");
        expect(
          readerRepos.cursors.get("r_1", "default_branch", "published"),
        ).toBeNull();
      });

      // After COMMIT the whole publish is visible together.
      expect(readerRepos.generations.byId("g_pub")).not.toBeNull();
      expect(readerRepos.lessons.listByGeneration("g_pub")).toHaveLength(1);
      expect(readerRepos.sources.all("g_pub")).toHaveLength(1);
      expect(readerRepos.changes.byId("e_1")?.state).toBe("published");
      expect(
        readerRepos.cursors.get("r_1", "default_branch", "published")?.headSha,
      ).toBe("head-1");
    } finally {
      reader.close();
    }
  });

  it("never shows a partial publish to an open readTransaction reader", () => {
    writer.changes.insertMany([
      makeChange({ eventId: "e_1", state: "discovered" }),
    ]);

    const reader = openDatabase({ file: ctx.file });
    const readerRepos = createRepositories(reader);
    try {
      reader.readTransaction(() => {
        // The first read pins the reader's snapshot before the publish commits.
        expect(readerRepos.generations.byId("g_pub")).toBeNull();
        expect(readerRepos.changes.byId("e_1")?.state).toBe("discovered");

        ctx.db.transaction(() => {
          writer.generations.insertPublished(
            makeGeneration({ generationId: "g_pub", cacheKey: "ck_pub" }),
          );
          writer.lessons.insertMany([makeLesson({ generationId: "g_pub" })]);
          writer.sources.insertMany([makeSource({ generationId: "g_pub" })]);
          writer.changes.setState("e_1", "published", { publishedAt: AT });
        });

        // The committed publish is still invisible to the pinned snapshot, so
        // the reader can never observe generation-without-lessons or a
        // half-updated event.
        expect(readerRepos.generations.byId("g_pub")).toBeNull();
        expect(readerRepos.lessons.listByGeneration("g_pub")).toEqual([]);
        expect(readerRepos.sources.all("g_pub")).toEqual([]);
        expect(readerRepos.changes.byId("e_1")?.state).toBe("discovered");
      });

      // A fresh read outside the transaction sees the whole publish at once.
      expect(readerRepos.generations.byId("g_pub")).not.toBeNull();
      expect(readerRepos.lessons.listByGeneration("g_pub")).toHaveLength(1);
      expect(readerRepos.sources.all("g_pub")).toHaveLength(1);
      expect(readerRepos.changes.byId("e_1")?.state).toBe("published");
    } finally {
      reader.close();
    }
  });

  it("rolls the whole publish back when the transaction throws", () => {
    expect(() =>
      ctx.db.transaction(() => {
        writer.generations.insertPublished(
          makeGeneration({ generationId: "g_rb", cacheKey: "ck_rb" }),
        );
        writer.lessons.insertMany([makeLesson({ generationId: "g_rb" })]);
        writer.sources.insertMany([makeSource({ generationId: "g_rb" })]);
        throw new Error("publish failed");
      }),
    ).toThrow("publish failed");

    expect(writer.generations.byId("g_rb")).toBeNull();
    expect(writer.lessons.listByGeneration("g_rb")).toEqual([]);
    expect(writer.sources.all("g_rb")).toEqual([]);
  });

  it("gives a readTransaction a stable snapshot while another connection commits", () => {
    writer.generations.insertPublished(
      makeGeneration({ generationId: "g_base", cacheKey: "ck_base" }),
    );

    const reader = openDatabase({ file: ctx.file });
    const readerRepos = createRepositories(reader);
    const projectId = "p_1" as ProjectId;
    try {
      reader.readTransaction(() => {
        const before = readerRepos.generations.listByProject(projectId);
        expect(before).toHaveLength(1);

        writer.generations.insertPublished(
          makeGeneration({ generationId: "g_new", cacheKey: "ck_new" }),
        );

        expect(readerRepos.generations.listByProject(projectId)).toHaveLength(
          1,
        );
      });

      expect(readerRepos.generations.listByProject(projectId)).toHaveLength(2);
    } finally {
      reader.close();
    }
  });
});
