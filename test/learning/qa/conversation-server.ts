/**
 * A real learning server wired for the conversation routes.
 *
 * It is the production HTTP core, the production SQLite store, the production
 * `ConversationService`/`AnswerService` and the production `RemovalService`;
 * only the three external seams (snapshot reader, retriever, model) are
 * doubles. Bodies leave through `api/routes/conversations.ts`, so every test
 * asserts the wire contract and not an internal record.
 *
 * `startConversationServer` is used by the in-process suites and by the
 * restart child (`conversation-restart-child.ts`), which is why it takes the
 * data directory from `CODETRAIL_DATA_DIR` and exposes the raw deps.
 */

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { conversationsModule } from "../../../src/learning/api/routes/conversations.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import type {
  AnswerService,
  AppDeps,
  Binding,
  Clock,
  ConversationService,
  Database,
  ModelHandle,
  RemovalService,
  Repositories,
  RetrievalHit,
  Retriever,
  RunningServer,
  SnapshotService,
  SourceRegistry,
} from "../../../src/learning/contracts/index.ts";
import { createSourceRegistry } from "../../../src/learning/evidence/index.ts";
import { createRemovalService } from "../../../src/learning/projects/removal.ts";
import { createAnswerService } from "../../../src/learning/qa/answer.ts";
import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";
import {
  fakeRetriever,
  fakeSnapshotService,
  scriptedHandle,
  stubExternal,
} from "./qa-helpers.ts";

/** The frozen start of every conversation test clock. */
export const CONVERSATION_NOW = "2026-01-01T00:00:00.000Z";

export interface ConversationServerOptions {
  /** Defaults to `CODETRAIL_DATA_DIR` (the per-test directory). */
  dataDir?: string;
  /** Scripted-model directory; absent ⇒ no model configured. */
  scriptDir?: string;
  hits?: Record<string, RetrievalHit[]>;
  onSearch?: (binding: Binding, query: string) => void;
  /** Overrides the fake retriever (used for the gated disconnect test). */
  retriever?: Retriever;
  filesByGeneration?: Record<string, Record<string, string>>;
  generationOfCommit?: Record<string, string>;
}

export interface ConversationServer {
  url: string;
  port: number;
  paths: DataPaths;
  db: Database;
  repos: Repositories;
  clock: Clock;
  deps: AppDeps;
  conversations: ConversationService;
  answers: AnswerService;
  removal: RemovalService;
  retriever: Retriever;
  snapshotService: SnapshotService;
  registry: SourceRegistry;
  model: ModelHandle | null;
  close(): Promise<void>;
}

/**
 * A clock that advances one second per read, so `created_at` orders the user
 * message before the assistant placeholder it spawns.
 */
export function tickingClock(start = CONVERSATION_NOW): Clock {
  const base = createClock(start);
  return {
    now(): Date {
      const value = base.now();
      base.advance(1_000);
      return value;
    },
    set(iso: string): void {
      base.set(iso);
    },
    advance(ms: number): void {
      base.advance(ms);
    },
  };
}

export async function startConversationServer(
  options: ConversationServerOptions = {},
): Promise<ConversationServer> {
  const env =
    options.dataDir === undefined
      ? process.env
      : { ...process.env, CODETRAIL_DATA_DIR: options.dataDir };
  const paths = resolveDataPaths(env);
  await ensureDataDir(paths);

  const db = openDatabase({ file: paths.db });
  migrate(db);
  const repos = createRepositories(db);
  const clock = tickingClock();
  const session = createSessionStore(paths);

  // Boot normalisation (§3.11 rule 2): a stream cannot survive its process.
  repos.conversations.cancelStreaming();

  const conversations = createConversationService({ db, repos, clock });
  const removal = createRemovalService({ db, repos, clock });
  const snapshotService = fakeSnapshotService(
    options.filesByGeneration ?? {},
    options.generationOfCommit ?? {},
  );
  const registry = createSourceRegistry({
    clock,
    sources: repos.sources,
    generations: repos.generations,
  });
  const model =
    options.scriptDir === undefined
      ? null
      : scriptedHandle(options.scriptDir, undefined, "qa");
  const retriever =
    options.retriever ?? fakeRetriever(options.hits ?? {}, options.onSearch);

  const answers = createAnswerService({
    db,
    repos,
    clock,
    model,
    retriever,
    registry,
    snapshotService,
    external: stubExternal(),
    conversations,
  });

  // Only the ports this module's handlers touch are real; the rest of the DI
  // surface belongs to modules this issue may not import yet.
  const deps = {
    paths,
    clock,
    db,
    repos,
    session,
    conversations,
    answers,
    removal,
    retriever,
    snapshotService,
    registry,
    external: stubExternal(),
    model,
  } as unknown as AppDeps;

  registerRouteModule(conversationsModule);
  let server: RunningServer;
  try {
    server = await createLearningServer({ paths, port: 0, clock, deps });
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    url: server.url,
    port: server.port,
    paths,
    db,
    repos,
    clock,
    deps,
    conversations,
    answers,
    removal,
    retriever,
    snapshotService,
    registry,
    model,
    async close(): Promise<void> {
      await server.close();
      db.close();
    },
  };
}

// ── SSE frame parsing ───────────────────────────────────────────────────────

export interface SseFrame {
  event: string;
  data: string;
  json: unknown;
}

/** Parses a complete `text/event-stream` body into named frames. */
export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    if (block.trim() === "") continue;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:"))
        data.push(line.slice("data:".length).trimStart());
      // `retry:` and comment lines carry no payload.
    }
    if (event === "message" && data.length === 0) continue;
    const joined = data.join("\n");
    let json: unknown;
    try {
      json = joined === "" ? null : (JSON.parse(joined) as unknown);
    } catch {
      json = null;
    }
    frames.push({ event, data: joined, json });
  }
  return frames;
}

/** Every key that appears anywhere in a JSON value, for leak assertions. */
export function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}
