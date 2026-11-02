import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  emptyCursor,
  type ChangeEventId,
  type ConversationId,
  type GenerationId,
  type JobId,
  type LessonId,
  type MessageId,
  type ProjectId,
  type RepoId,
  type Repositories,
  type SourceId,
  type TermId,
} from "../../../src/learning/contracts/index.ts";
import { createRepositories } from "../../../src/learning/store/index.ts";
import {
  AT,
  closeTempDb,
  createTempDb,
  makeChange,
  makeCitation,
  makeGeneration,
  makeJob,
  makeLesson,
  makeMessage,
  makeModelSettings,
  makeProject,
  makeReadingPosition,
  makeRepo,
  makeSnapshot,
  makeSource,
  makeUsage,
  type TempDb,
} from "./helpers.ts";

const LATER = "2026-01-02T00:00:00.000Z";

describe("store repositories", () => {
  let ctx: TempDb;
  let repos: Repositories;

  beforeEach(() => {
    ctx = createTempDb();
    repos = createRepositories(ctx.db);
  });

  afterEach(() => {
    closeTempDb(ctx);
  });

  it("repos: upsert reuses an identity and byId round-trips", () => {
    const record = makeRepo();
    expect(repos.repos.upsert(record)).toEqual(record);
    expect(repos.repos.byIdentity(record.identity)).toEqual(record);
    expect(repos.repos.byId(record.repoId)).toEqual(record);
    expect(repos.repos.byIdentity("local:/nope")).toBeNull();
  });

  it("projects: insert, list, setWatch, markDeleted and liveProjectForRepo", () => {
    repos.repos.upsert(makeRepo());
    const project = makeProject();
    repos.projects.insert(project);

    expect(repos.projects.byId(project.projectId)).toEqual(project);
    expect(repos.projects.list()).toHaveLength(1);
    expect(repos.projects.liveProjectForRepo(project.repoId)).toEqual(project);

    repos.projects.setWatch(project.projectId, true, null);
    const watched = repos.projects.byId(project.projectId);
    expect(watched?.watchEnabled).toBe(true);
    expect(watched?.scope).toEqual(project.scope);

    repos.projects.markDeleted(project.projectId, LATER);
    expect(repos.projects.list()).toEqual([]);
    expect(repos.projects.byId(project.projectId)?.deletedAt).toBe(LATER);
    expect(repos.projects.liveProjectForRepo(project.repoId)).toBeNull();
  });

  it("snapshots: upsert, byCommit and referencedByPublished", () => {
    const snapshot = makeSnapshot();
    repos.snapshots.upsert(snapshot);
    expect(
      repos.snapshots.byCommit(snapshot.repoId, snapshot.commitSha),
    ).toEqual(snapshot);
    expect(repos.snapshots.referencedByPublished(snapshot.commitSha)).toBe(
      false,
    );

    repos.generations.insertPublished(
      makeGeneration({ commitSha: snapshot.commitSha }),
    );
    expect(repos.snapshots.referencedByPublished(snapshot.commitSha)).toBe(
      true,
    );

    repos.snapshots.upsert({ ...snapshot, treeHash: "tree-2" });
    expect(
      repos.snapshots.byCommit(snapshot.repoId, snapshot.commitSha)?.treeHash,
    ).toBe("tree-2");
  });

  it("jobs: transition is false on an illegal move and true on a legal one", () => {
    const job = makeJob({
      jobId: "j_1" as JobId,
      projectId: "p_1" as ProjectId,
    });
    repos.jobs.insert(job);

    expect(repos.jobs.byId(job.jobId)).toEqual(job);
    expect(repos.jobs.byDedupeKey(job.dedupeKey)).toEqual(job);

    expect(repos.jobs.transition(job.jobId, ["running"], "completed")).toBe(
      false,
    );
    expect(repos.jobs.transition(job.jobId, ["queued"], "running")).toBe(true);
    const running = repos.jobs.byId(job.jobId);
    expect(running?.state).toBe("running");
    expect(running?.startedAt).toBeNull();

    expect(
      repos.jobs.transition(job.jobId, ["running"], "completed", {
        finishedAt: LATER,
        progress: { phase: "sealing", done: 1, total: 1 },
        errorCode: "interrupted",
      }),
    ).toBe(true);
    const completed = repos.jobs.byId(job.jobId);
    expect(completed?.state).toBe("completed");
    expect(completed?.finishedAt).toBe(LATER);
    expect(completed?.progress).toEqual({
      phase: "sealing",
      done: 1,
      total: 1,
    });
    expect(completed?.errorCode).toBe("interrupted");

    expect(repos.jobs.bumpAttempt(job.jobId)).toBe(1);
    expect(repos.jobs.bumpAttempt(job.jobId)).toBe(2);
    expect(repos.jobs.byId(job.jobId)?.attempt).toBe(2);

    expect(repos.jobs.listByState(["completed"])).toHaveLength(1);
    expect(repos.jobs.listByState([])).toEqual([]);
    expect(repos.jobs.listByStream("stream-x")).toEqual([]);
    expect(
      repos.jobs.listByProject("p_1" as ProjectId, ["completed"]),
    ).toHaveLength(1);
  });

  it("attempts: open, close and list", () => {
    repos.jobs.insert(makeJob({ jobId: "j_1" as JobId }));
    repos.attempts.open("j_1" as JobId, 1, AT);
    expect(repos.attempts.list("j_1" as JobId)).toEqual([
      {
        jobId: "j_1",
        attempt: 1,
        state: "running",
        startedAt: AT,
        finishedAt: null,
        usageId: null,
      },
    ]);

    repos.attempts.close("j_1" as JobId, 1, "completed", LATER, "u_1");
    expect(repos.attempts.list("j_1" as JobId)[0]).toMatchObject({
      state: "completed",
      finishedAt: LATER,
      usageId: "u_1",
    });
  });

  it("generations: insertPublished, lookups, latestPublished and setStatus", () => {
    const older = makeGeneration({
      generationId: "g_old" as GenerationId,
      cacheKey: "ck_old",
      publishedAt: AT,
    });
    const newer = makeGeneration({
      generationId: "g_new" as GenerationId,
      cacheKey: "ck_new",
      publishedAt: LATER,
    });
    repos.generations.insertPublished(older);
    repos.generations.insertPublished(newer);

    expect(repos.generations.byCacheKey("ck_old")).toEqual(older);
    expect(repos.generations.byId("g_new" as GenerationId)).toEqual(newer);
    expect(repos.generations.byId("g_missing" as GenerationId)).toBeNull();

    expect(
      repos.generations.latestPublished("r_1" as RepoId)?.generationId,
    ).toBe("g_new");
    expect(
      repos.generations.latestPublished("r_1" as RepoId, { before: LATER })
        ?.generationId,
    ).toBe("g_old");
    expect(
      repos.generations.latestPublished("r_1" as RepoId, { kind: "change" }),
    ).toBeNull();
    expect(repos.generations.listByProject("p_1" as ProjectId)).toHaveLength(2);

    repos.generations.setStatus("g_old" as GenerationId, "superseded", {
      fallbackReason: "config_changed",
    });
    const superseded = repos.generations.byId("g_old" as GenerationId);
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.fallbackReason).toBe("config_changed");
  });

  it("lessons and sources: insertMany and lookups", () => {
    repos.generations.insertPublished(makeGeneration());
    const lesson = makeLesson();
    repos.lessons.insertMany([lesson]);
    expect(repos.lessons.listByGeneration("g_1" as GenerationId)).toEqual([
      lesson,
    ]);
    expect(repos.lessons.byId("g_1" as GenerationId, lesson.lessonId)).toEqual(
      lesson,
    );
    expect(
      repos.lessons.byId("g_1" as GenerationId, "l_missing" as LessonId),
    ).toBeNull();

    const source = makeSource();
    repos.sources.insertMany([source]);
    expect(repos.sources.all("g_1" as GenerationId)).toEqual([source]);
    expect(repos.sources.get("g_1" as GenerationId, source.sourceId)).toEqual(
      source,
    );
    expect(
      repos.sources.get("g_1" as GenerationId, "s_missing" as SourceId),
    ).toBeNull();
  });

  it("conversations: messages ordering, limit, before and updateMessage", () => {
    repos.generations.insertPublished(makeGeneration());
    repos.conversations.insert({
      conversationId: "c_1" as ConversationId,
      generationIds: ["g_1" as GenerationId],
      at: AT,
    });

    const m1 = makeMessage({
      messageId: "m_1" as MessageId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    const m2 = makeMessage({
      messageId: "m_2" as MessageId,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    const m3 = makeMessage({
      messageId: "m_3" as MessageId,
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    for (const message of [m1, m2, m3]) {
      repos.conversations.insertMessage(message);
    }

    expect(
      repos.conversations
        .messages("c_1" as ConversationId)
        .map((m) => m.messageId),
    ).toEqual(["m_1", "m_2", "m_3"]);
    expect(
      repos.conversations
        .messages("c_1" as ConversationId, { limit: 2 })
        .map((m) => m.messageId),
    ).toEqual(["m_2", "m_3"]);
    expect(
      repos.conversations
        .messages("c_1" as ConversationId, {
          limit: 2,
          before: "2026-01-01T00:00:03.000Z",
        })
        .map((m) => m.messageId),
    ).toEqual(["m_1", "m_2"]);
    expect(
      repos.conversations
        .messages("c_1" as ConversationId, {
          before: "2026-01-01T00:00:02.000Z",
        })
        .map((m) => m.messageId),
    ).toEqual(["m_1"]);

    repos.conversations.updateMessage("m_1" as MessageId, {
      status: "complete",
      answerPhase: "complete",
      incomplete: false,
      unknownReason: "no_source",
      citations: [makeCitation()],
    });
    const updated = repos.conversations.messages("c_1" as ConversationId)[0];
    expect(updated).toMatchObject({
      status: "complete",
      answerPhase: "complete",
      incomplete: false,
      unknownReason: "no_source",
    });
    expect(updated?.citations).toHaveLength(1);

    repos.conversations.touch("c_1" as ConversationId, LATER);
    expect(
      repos.conversations.byId("c_1" as ConversationId)?.lastActiveAt,
    ).toBe(LATER);
  });

  it("conversations: selections and countByProject", () => {
    repos.generations.insertPublished(makeGeneration());
    repos.conversations.insert({
      conversationId: "c_1" as ConversationId,
      generationIds: ["g_1" as GenerationId],
      at: AT,
    });

    const selection = repos.conversations.addSelection({
      conversationId: "c_1" as ConversationId,
      lessonId: "l_1" as LessonId,
      moduleId: null,
      sourceId: "s_1" as SourceId,
      codeLocation: { path: "src/index.ts", lines: { start: 1, end: 3 } },
      createdAt: AT,
    });
    expect(selection.id).toBeGreaterThan(0);
    expect(repos.conversations.selections("c_1" as ConversationId)).toEqual([
      selection,
    ]);

    expect(repos.conversations.countByProject("p_1" as ProjectId)).toBe(1);
    expect(repos.conversations.countByProject("p_other" as ProjectId)).toBe(0);
  });

  it("cursors: put is a compare-and-swap", () => {
    expect(
      repos.cursors.get("r_1" as RepoId, "default_branch", "discovery"),
    ).toBeNull();

    expect(
      repos.cursors.put({
        repoId: "r_1" as RepoId,
        streamId: "default_branch",
        kind: "discovery",
        cursor: { ...emptyCursor("default_branch"), headSha: "head-1" },
        expectedPrevious: null,
      }),
    ).toBe(true);

    expect(
      repos.cursors.get("r_1" as RepoId, "default_branch", "discovery")
        ?.headSha,
    ).toBe("head-1");

    expect(
      repos.cursors.put({
        repoId: "r_1" as RepoId,
        streamId: "default_branch",
        kind: "discovery",
        cursor: { ...emptyCursor("default_branch"), headSha: "head-2" },
        expectedPrevious: { headSha: "stale", updatedAt: null },
      }),
    ).toBe(false);

    expect(
      repos.cursors.put({
        repoId: "r_1" as RepoId,
        streamId: "default_branch",
        kind: "discovery",
        cursor: { ...emptyCursor("default_branch"), headSha: "head-2" },
        expectedPrevious: { headSha: "head-1", updatedAt: null },
      }),
    ).toBe(true);
    expect(
      repos.cursors.get("r_1" as RepoId, "default_branch", "discovery")
        ?.headSha,
    ).toBe("head-2");
  });

  it("changes: insertMany, stable page, setState, link and counts", () => {
    repos.changes.insertMany([
      makeChange({ eventId: "e_1" as ChangeEventId, discoveredAt: AT }),
      makeChange({
        eventId: "e_2" as ChangeEventId,
        discoveredAt: "2026-01-01T00:00:02.000Z",
      }),
      makeChange({
        eventId: "e_3" as ChangeEventId,
        discoveredAt: "2026-01-01T00:00:03.000Z",
      }),
    ]);

    expect(repos.changes.countByProject("p_1" as ProjectId)).toBe(3);

    const first = repos.changes.page("p_1" as ProjectId, null, 2);
    expect(first.items.map((item) => item.eventId)).toEqual(["e_3", "e_2"]);
    expect(first.next).not.toBeNull();

    const second = repos.changes.page("p_1" as ProjectId, first.next, 2);
    expect(second.items.map((item) => item.eventId)).toEqual(["e_1"]);
    expect(second.next).toBeNull();

    expect(() =>
      repos.changes.page("p_1" as ProjectId, "not-a-cursor", 2),
    ).toThrow(/游标无法解析/);

    repos.changes.setState("e_1" as ChangeEventId, "queued", {
      jobId: "j_1" as JobId,
      gapReason: "manual",
    });
    const queued = repos.changes.byId("e_1" as ChangeEventId);
    expect(queued?.state).toBe("queued");
    expect(queued?.jobId).toBe("j_1");
    expect(queued?.gapReason).toBe("manual");

    repos.changes.link({
      prEventId: "e_2" as ChangeEventId,
      defaultBranchEventId: "e_1" as ChangeEventId,
      relation: "identical_content",
    });
    expect(repos.changes.byId("e_2" as ChangeEventId)?.linkedEventId).toBe(
      "e_1",
    );
    expect(repos.changes.byId("e_2" as ChangeEventId)?.linkRelation).toBe(
      "identical_content",
    );

    expect(
      repos.changes.listByStream("default_branch", ["queued"]),
    ).toHaveLength(1);
    expect(repos.changes.listByStream("default_branch", [])).toEqual([]);
  });

  it("usage: groups by kind and keeps unpriced cost null", () => {
    repos.usage.insert(makeUsage({ usageId: "u_1", kind: "qa" }));
    repos.usage.insert(
      makeUsage({
        usageId: "u_2",
        kind: "initial",
        inputTokens: 100,
        outputTokens: 20,
        calls: 2,
        costCents: 5,
      }),
    );

    const all = repos.usage.groupByKind();
    expect(all).toHaveLength(2);
    expect(all.find((group) => group.kind === "qa")?.costCents).toBeNull();
    expect(all.find((group) => group.kind === "initial")).toEqual({
      kind: "initial",
      inputTokens: 100,
      outputTokens: 20,
      calls: 2,
      costCents: 5,
    });

    expect(repos.usage.groupByKind("qa")).toHaveLength(1);
  });

  it("prefs: defaults, version bump and reading positions", () => {
    expect(repos.prefs.get()).toEqual({
      explainLevel: "plain_first",
      background: null,
      language: "zh",
      version: 0,
    });
    expect(repos.prefs.version()).toBe(0);

    const first = repos.prefs.put({ explainLevel: "technical_first" });
    expect(first.explainLevel).toBe("technical_first");
    expect(first.version).toBe(1);

    const second = repos.prefs.put({ background: "熟悉 Python" });
    expect(second.background).toBe("熟悉 Python");
    expect(second.explainLevel).toBe("technical_first");
    expect(second.version).toBe(2);
    expect(repos.prefs.version()).toBe(2);

    expect(repos.prefs.readingPositions()).toEqual([]);
    const position = makeReadingPosition();
    repos.prefs.putReadingPosition(position);
    expect(repos.prefs.readingPositions()).toEqual([position]);
    repos.prefs.putReadingPosition({ ...position, offset: 9 });
    expect(repos.prefs.readingPositions()[0]?.offset).toBe(9);
  });

  it("settings: model round-trip", () => {
    expect(repos.settings.model()).toBeNull();
    const settings = makeModelSettings();
    repos.settings.putModel(settings);
    expect(repos.settings.model()).toEqual(settings);
  });

  it("terms: list, search, byId and linkTerm", () => {
    const insertTerm = ctx.db.raw.prepare(
      "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
    );
    insertTerm.run("t_1", "注意力", "attention", JSON.stringify(["Attention"]));
    insertTerm.run("t_2", "词元", "token", JSON.stringify([]));

    repos.generations.insertPublished(makeGeneration());
    repos.terms.linkTerm({
      termId: "t_1" as TermId,
      generationId: "g_1" as GenerationId,
      sourceId: "s_1" as SourceId,
    });
    // Linking twice is idempotent.
    repos.terms.linkTerm({
      termId: "t_1" as TermId,
      generationId: "g_1" as GenerationId,
      sourceId: "s_1" as SourceId,
    });

    const all = repos.terms.list();
    expect(all.map((term) => term.termId).sort()).toEqual(["t_1", "t_2"]);
    const attention = repos.terms.byId("t_1" as TermId);
    expect(attention?.symbols).toEqual(["Attention"]);
    expect(attention?.links).toEqual([
      {
        generationId: "g_1",
        repoId: "r_1",
        projectId: "p_1",
        sourceId: "s_1",
      },
    ]);

    expect(repos.terms.list("词元").map((term) => term.termId)).toEqual([
      "t_2",
    ]);
  });
});
