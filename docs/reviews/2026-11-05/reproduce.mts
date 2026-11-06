/** Historical diagnostics for the pre-fix baseline (6fe814f2).
 * These assertions describe the former defects and intentionally no longer pass after remediation.
 * Diagnostic observations, NOT desired-behavior regression tests.
 * Run from the repository root:
 * node --import tsx docs/reviews/2026-11-05/reproduce.mts
 * Uses temporary directories and scripted models only; no API credentials needed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import ts from "typescript";
import { createAppDeps } from "../../../src/learning/api/cli.ts";
import { handlers as settingsHandlers } from "../../../src/learning/api/routes/settings.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import { handlers as generationHandlers } from "../../../src/learning/api/routes/generations.ts";
import {
  computeCacheKey,
  computeConfigHash,
} from "../../../src/learning/contracts/index.ts";
import { UPSTREAM_VERSION } from "../../../src/learning/config/defaults.ts";
import { insertJobRow } from "../../../src/learning/updates/discovery.ts";
import {
  createHarness,
  generationInput,
  comparisonInput,
  runToCompletion,
  seedPublishedGeneration,
  SHA_A,
  SHA_B,
  SHA_C,
} from "../../../test/learning/generation/harness.ts";
import * as qa from "../../../test/learning/qa/qa-helpers.ts";
import * as fixtures from "../../../test/learning/ui/fixtures.ts";
import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { renderReaderPage } from "../../../src/learning/ui/pages/reader.ts";
import { renderSettingsPage } from "../../../src/learning/ui/pages/settings.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-audit-"));
  dirs.push(dir);
  return dir;
};
const req = (body = {}, params = {}, query = {}) => ({
  body,
  params,
  query,
  headers: {},
  signal: new AbortController().signal,
});
const observe = (id: string, details: unknown) =>
  console.log(JSON.stringify({ id, ...(details as object) }));
const originalDataDir = process.env.CODETRAIL_DATA_DIR;

try {
  // The public surface cannot configure a model or submit an analysis.
  const projects = renderProjectsPage(
    fixtures.pageContext,
    fixtures.projectsModel(),
  );
  const settings = renderSettingsPage(
    fixtures.pageContext,
    fixtures.settingsModel(),
  );
  assert(!projects.includes("/analyses"));
  assert(!settings.includes("/api/settings/model"));
  observe("R1-ui-entry", {
    analysisControl: false,
    modelSettingsControl: false,
  });

  const app = await createAppDeps({ CODETRAIL_DATA_DIR: temp() });
  try {
    const response = await settingsHandlers["settings.model.put"]!(app)(
      req({ provider: "anthropic", model: "audit-model" }) as never,
    );
    assert.equal(response.status, 200);
    assert.equal(app.repos.settings.model()?.model, "audit-model");
    assert.equal(app.model, null);
    observe("R2-runtime-model", {
      saveStatus: response.status,
      persisted: app.repos.settings.model()?.model,
      runtimeModel: app.model,
    });
  } finally {
    app.db.close();
  }

  // Evaluate a fresh compile of the CURRENT source bundle in a browser DOM.
  const clientSource = fs.readFileSync(
    path.join(root, "src/learning/ui/client.ts"),
    "utf8",
  );
  const client = ts
    .transpileModule(clientSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/export\s*\{\s*\};?/gu, "");
  const domFor = (html: string) =>
    new JSDOM(html, {
      url: "http://127.0.0.1:9999/learn?generation=g_test",
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole(),
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const dom = domFor(
    renderReaderPage(
      fixtures.pageContext,
      fixtures.readerModel({ conversation: null }),
    ),
  );
  const calls: { url: string; body: unknown }[] = [];
  let jsonOnSse = 0;
  dom.window.fetch = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init.body ?? "{}") });
    if (url === "/api/conversations")
      return {
        ok: true,
        json: async () => ({ conversationId: `c_${calls.length}` }),
      };
    return {
      ok: true,
      json: async () => {
        jsonOnSse++;
        throw new SyntaxError("SSE is not JSON");
      },
    };
  }) as never;
  dom.window.eval(client);
  await tick();
  const qaForm = dom.window.document.querySelector("[data-qa-form]")!;
  const input = dom.window.document.querySelector(
    '[data-testid="qa-input"]',
  ) as HTMLTextAreaElement;
  for (const question of ["第一问", "接着上一问"]) {
    input.value = question;
    qaForm.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
  }
  assert.equal(calls.filter((c) => c.url === "/api/conversations").length, 2);
  assert.equal(qaForm.getAttribute("data-conversation-id"), "");
  assert.equal(dom.window.location.search.includes("conversation="), false);
  observe("R3-qa-browser", {
    createdConversations: 2,
    jsonParseAttemptsOnSse: jsonOnSse,
    formConversation: qaForm.getAttribute("data-conversation-id"),
    url: dom.window.location.href,
  });
  dom.window.close();

  // The removal checkbox is never consulted by the client.
  const removalDom = domFor(projects);
  const removalCalls: string[] = [];
  removalDom.window.fetch = (async (url: string) => {
    removalCalls.push(url);
    return { ok: true, json: async () => ({}) };
  }) as never;
  removalDom.window.eval(client);
  await tick();
  (
    removalDom.window.document.querySelector(
      "[data-select-project]",
    ) as HTMLElement
  ).click();
  await tick();
  const removalForm = removalDom.window.document.querySelector(
    "[data-remove-project]",
  )!;
  assert.equal(
    (removalForm.querySelector("input") as HTMLInputElement).checked,
    false,
  );
  assert.equal(
    (removalForm.querySelector("button") as HTMLButtonElement).disabled,
    false,
  );
  removalForm.dispatchEvent(
    new removalDom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await tick();
  assert(removalCalls.some((url) => url.endsWith("?confirm=true")));
  observe("R10-removal-confirmation", {
    checkboxChecked: false,
    deleteWithConfirmTrue: true,
  });
  removalDom.window.close();

  const h = await createHarness({ dataDir: temp() });
  try {
    const input = generationInput(h, { sha: SHA_A });
    const job = insertJobRow(h.repos, input, h.clock.now().toISOString());
    await h.runner.recoverInterrupted();
    await h.runner.enqueue(input);
    await h.runner.drain();
    assert.equal(h.repos.jobs.byId(job.jobId)?.state, "queued");
    observe("R4-discovery-queue", {
      afterRecoveryEnqueueAndDrain: h.repos.jobs.byId(job.jobId)?.state,
      calls: h.calls.count,
    });
  } finally {
    h.close();
  }

  const prefs = await createHarness({ dataDir: temp() });
  try {
    const input = generationInput(prefs, { sha: SHA_A });
    const first = await runToCompletion(prefs, input);
    assert.equal(first.state, "completed", first.errorDetail ?? "");
    const before = prefs.calls.count;
    prefs.repos.prefs.put({ background: "已经熟悉该模块" });
    const second = await runToCompletion(prefs, input);
    assert.equal(second.jobId, first.jobId);
    assert.equal(
      prefs.repos.generations.byId(second.outputGenerationId!)
        ?.preferencesVersion,
      0,
    );
    observe("R6-preferences-dedupe", {
      currentPreferencesVersion: prefs.repos.prefs.version(),
      returnedGenerationPreferencesVersion: 0,
      reusedSameJob: true,
      additionalModelCalls: prefs.calls.count - before,
    });
  } finally {
    prefs.close();
  }

  // Two diverged base refs can share a merge-base with the same target.
  // Seed the first valid published result; submitting the second should not hit it.
  const cmp = await createHarness({ dataDir: temp() });
  try {
    const firstBase = SHA_B,
      secondBase = SHA_C,
      head = "d".repeat(40),
      mergeBase = SHA_A;
    const cacheKey = computeCacheKey({
      repoIdentity: cmp.repos.repos.byId(cmp.repoId)!.identity,
      targetCommitSha: head,
      baseContextSha: mergeBase,
      scopeHash: cmp.scope.hash,
      generationConfigHash: computeConfigHash(cmp.config),
      promptTemplateVersion: cmp.config.promptTemplateVersion,
      preferencesVersion: 0,
      upstreamVersion: UPSTREAM_VERSION,
    });
    const seeded = await seedPublishedGeneration(cmp, {
      generationId: "g_audit_comparison" as never,
      commitSha: head,
    });
    cmp.repos.generations.setStatus(seeded.generationId, "published", {
      kind: "comparison",
      comparisonBaseSha: firstBase,
      cacheKey,
    });
    const input = comparisonInput(cmp, { baseSha: secondBase, headSha: head });
    input.baseContextSha = mergeBase;
    const job = await cmp.runner.enqueue(input);
    assert.equal(job.state, "completed");
    assert.equal(
      cmp.repos.generations.byId(job.outputGenerationId!)?.comparisonBaseSha,
      firstBase,
    );
    observe("R5-comparison-cache", {
      requestedBase: secondBase,
      actualReturnedBase: firstBase,
      cacheHit: true,
    });
  } finally {
    cmp.close();
  }

  // The reader uses a separate read path from the guarded generation API.
  const readerApp = await createAppDeps({ CODETRAIL_DATA_DIR: temp() });
  try {
    const lesson = fixtures.researchLesson();
    qa.publishGeneration(
      { repos: readerApp.repos },
      {
        generationId: fixtures.GENERATION_ID,
        repoId: fixtures.REPO_ID,
        projectId: fixtures.PROJECT_ID,
        contentDir: path.join(
          readerApp.paths.knowledge,
          fixtures.GENERATION_ID,
        ),
        lessons: [{ lessonId: fixtures.LESSON_ID }],
        files: {
          [`lessons/${fixtures.LESSON_ID}.json`]: JSON.stringify(lesson),
        },
      },
    );
    const ui = createStaticUi(readerApp);
    const page = async (query: Record<string, string>) =>
      await ui.handle(req({}, { path: "/learn/reader" }, query) as never);
    const one = await page({
      generation: fixtures.GENERATION_ID,
      source: "s_one",
    });
    const two = await page({
      generation: fixtures.GENERATION_ID,
      source: "s_two",
    });
    assert.deepEqual(one, two);
    observe("R7-evidence-link", { differentSourcesProduceIdenticalPage: true });
    readerApp.repos.projects.markDeleted(
      fixtures.PROJECT_ID,
      readerApp.clock.now().toISOString(),
    );
    const removed = await page({ generation: fixtures.GENERATION_ID });
    let apiError = "";
    try {
      await generationHandlers["generations.lessons"]!(readerApp)(
        req({}, { id: fixtures.GENERATION_ID }) as never,
      );
    } catch (e) {
      apiError = (e as { code: string }).code;
    }
    assert.equal(apiError, "source_removed");
    assert.equal(removed?.status, 200);
    observe("R9-reader-guard", {
      apiError,
      readerStatus: removed?.status,
      lessonStillShown: String((removed as { body: unknown }).body).includes(
        "先去空格",
      ),
    });
  } finally {
    readerApp.db.close();
  }

  // QA bypasses UsageMeter entirely, despite the saved quota.
  const modelDir = qa.scriptDir([
    qa.answerEntry(
      {
        answer: "这是教学示例。",
        conclusion: "teaching_example",
        citations: [],
      },
      1,
    ),
    qa.answerEntry(
      { answer: "继续举例。", conclusion: "teaching_example", citations: [] },
      2,
    ),
  ]);
  let qaCalls = 0;
  const q = qa.createHarness({
    modelDir,
    onCall: () => {
      qaCalls++;
    },
    filesByGeneration: { g_audit: { "src/index.ts": "export const x = 1;" } },
    generationOfCommit: { [qa.COMMIT_A]: "g_audit" },
  });
  try {
    qa.publishGeneration(q.db, { generationId: "g_audit" });
    q.db.repos.settings.putModel({
      ...q.model!.settings,
      quota: { maxCalls: 1, maxInputTokens: 1, maxOutputTokens: 1 },
    });
    const c = await q.conversations.create({
      generationIds: ["g_audit" as never],
    });
    for (const text of ["举例", "继续"])
      await qa.collect(
        q.answers.answer({
          conversationId: c.conversationId,
          text,
          selection: null,
          signal: new AbortController().signal,
        }),
      );
    assert.equal(qaCalls, 2);
    assert.equal(q.db.repos.usage.groupByKind("qa").length, 0);
    observe("R8-qa-quota", {
      configuredMaxCalls: 1,
      actualModelCalls: qaCalls,
      recordedQaUsageRows: 0,
    });
  } finally {
    q.db.close();
  }
} finally {
  qa.cleanupTempDirs();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CODETRAIL_DATA_DIR;
  else process.env.CODETRAIL_DATA_DIR = originalDataDir;
}
