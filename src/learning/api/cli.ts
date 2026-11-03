/**
 * The composition root (architecture §3.13, §4.1, §14.2, §18).
 *
 * This is the only file allowed to know every component. It
 *   - hardens the process (telemetry/tracing off) **before** any upstream
 *     module is loaded, because several of them read `process.env` at module
 *     scope (§4.1, AC-SEC-08),
 *   - constructs the single `AppDeps` graph exactly once (AC-SEC-08),
 *   - runs restart recovery — `JobRunner.recoverInterrupted()` and the
 *     streaming-message sweep — before the listener exists (§7.1, AC-OPS-02),
 *   - binds `127.0.0.1` only, prints exactly one loopback URL and drains
 *     (server close → watch stop → job drain) on SIGTERM/SIGINT.
 *
 * Every value import is dynamic so the hardening step really is the first
 * thing that runs. Only type imports are static; TypeScript erases them.
 * `ServerOptions`/`RunningServer` and `AppDeps` live in `contracts/ports.ts`
 * and are never redeclared here.
 */

import type {
  AppDeps,
  Binding,
  Clock,
  DataPaths,
  ModelHandle,
  Repositories,
  RouteModule,
  RunningServer,
  SnapshotService,
} from "../contracts/index.js";
import type { RetrievalContext } from "../retrieval/search.js";

// ── hardening (AC-SEC-08) ───────────────────────────────────────────────────

/**
 * This must be the first runtime statement. `config/env.ts` imports only the
 * contract types, `defaults.ts` and `paths.ts`, none of which read
 * `process.env` at module scope.
 */
const { applyProcessHardening } = await import("../config/env.js");
applyProcessHardening(process.env);

// ── argument parsing (AC-SEC-01) ────────────────────────────────────────────

interface CliOptions {
  /** `--port` override; `null` keeps `CODETRAIL_PORT` (or its default). */
  port: number | null;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535
    ? parsed
    : -1;
}

/**
 * Parses the CLI flags. The listen address is deliberately not configurable:
 * `--host` (in either spelling) is rejected as `invalid_input` and no
 * environment variable can widen the bind (AC-SEC-01).
 */
async function parseArgv(argv: readonly string[]): Promise<CliOptions> {
  const { LearningError } = await import("../contracts/index.js");
  const options: CliOptions = { port: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--host" || argument.startsWith("--host=")) {
      const value =
        argument === "--host" ? (argv[index + 1] ?? "") : argument.slice(7);
      throw new LearningError(
        "invalid_input",
        "the learning server binds 127.0.0.1 only; --host is not supported",
        { flag: "--host", value },
      );
    }

    if (argument === "--port" || argument.startsWith("--port=")) {
      const value =
        argument === "--port" ? (argv[index + 1] ?? "") : argument.slice(7);
      if (argument === "--port") index += 1;
      const port = parsePort(value);
      if (port === -1) {
        throw new LearningError(
          "invalid_input",
          "--port must be an integer between 0 and 65535",
          { flag: "--port", value },
        );
      }
      options.port = port;
      continue;
    }

    throw new LearningError("invalid_input", `unknown argument: ${argument}`, {
      argument,
    });
  }

  return options;
}

// ── the clock ───────────────────────────────────────────────────────────────

/**
 * A live clock, unless `CODETRAIL_NOW` freezes it (§4.1). The test-only
 * deterministic clock lives in `testing/` and is not part of the application.
 */
function createSystemClock(now: string | null): Clock {
  let frozen = now === null ? null : Date.parse(now);
  return {
    now: () => new Date(frozen ?? Date.now()),
    set: (iso: string): void => {
      frozen = Date.parse(iso);
    },
    advance: (ms: number): void => {
      frozen = (frozen ?? Date.now()) + ms;
    },
  };
}

// ── retrieval context ───────────────────────────────────────────────────────

interface RetrievalContextDeps {
  paths: DataPaths;
  repos: Repositories;
  snapshotService: SnapshotService;
}

/**
 * Binds a retrieval request to one published generation: its sealed knowledge
 * directory, its commit-bound snapshot and its read scope (§10.3). A
 * comparison binding also gets the base commit's snapshot.
 */
async function resolveRetrievalContext(
  deps: RetrievalContextDeps,
  binding: Binding,
): Promise<RetrievalContext> {
  const [
    { LearningError, publishedRef },
    { isAbsolute },
    { createSnapshotReader, normalizeScope },
  ] = await Promise.all([
    import("../contracts/index.js"),
    import("node:path"),
    import("../projects/index.js"),
  ]);

  const record = deps.repos.generations.byId(binding.generationId);
  if (record === null) {
    throw new LearningError("unpublished_generation", "该生成版本尚未发布", {
      generationId: binding.generationId,
      status: null,
    });
  }
  const ref = publishedRef(record);
  const project =
    record.projectId === null
      ? null
      : deps.repos.projects.byId(record.projectId);
  const scope = project?.scope ?? normalizeScope();

  const snapshot = await deps.snapshotService.ensure(
    record.repoId,
    record.commitSha,
  );
  const context: RetrievalContext = {
    wiki:
      record.kind === "comparison"
        ? null
        : {
            state: "published",
            generationId: ref.generationId,
            commitSha: ref.commitSha,
            knowledgeDir: isAbsolute(ref.knowledgeDir)
              ? ref.knowledgeDir
              : `${deps.paths.knowledge}/${ref.knowledgeDir}`,
            sealedTreeHash: ref.sealedTreeHash,
          },
    snapshot: createSnapshotReader(snapshot, scope),
    scope,
  };

  if (record.comparisonBaseSha !== null && record.comparisonBaseSha !== "") {
    const base = await deps.snapshotService.ensure(
      record.repoId,
      record.comparisonBaseSha,
    );
    context.baseSnapshot = createSnapshotReader(base, scope);
  }
  return context;
}

// ── the dependency root (AC-SEC-08) ─────────────────────────────────────────

/**
 * Constructs every port exactly once. Pure wiring: it opens the database and
 * migrates it (there is nothing to wire without a DB), but it never listens.
 * A factory failure closes the database and aborts boot.
 */
export async function createAppDeps(env: NodeJS.ProcessEnv): Promise<AppDeps> {
  const [
    { ensureDataDir, resolveDataPaths },
    { createRepositories, migrate, openDatabase },
    { createPublisher },
    { createJobRunner },
    { createUsageMeter },
    { createRemovalService, createSnapshotService },
    { createExternalDocService, createSourceRegistry },
    {
      createChangeLessonBuilder,
      createDiscoveryService,
      createGithubClient,
      createWatchScheduler,
    },
    { createUpstreamGenerationPort },
    { createUpstreamRetrievalPort },
    { createRetriever },
    { createSourceSearcher },
    { createConversationService },
    { createAnswerService },
    { createSessionStore },
    { createModelHandle },
    { loadCredential },
    { resolveEnv },
  ] = await Promise.all([
    import("../config/paths.js"),
    import("../store/index.js"),
    import("./jobs/publish.js"),
    import("./jobs/runner.js"),
    import("./jobs/usage.js"),
    import("../projects/index.js"),
    import("../evidence/index.js"),
    import("../updates/index.js"),
    import("../upstream/generation.js"),
    import("../upstream/retrieval.js"),
    import("../retrieval/search.js"),
    import("../retrieval/source-search.js"),
    import("../qa/conversations.js"),
    import("../qa/answer.js"),
    import("./auth.js"),
    import("../config/model.js"),
    import("../config/credentials.js"),
    import("../config/env.js"),
  ]);

  const runtime = resolveEnv(env);
  const paths = resolveDataPaths(env);
  await ensureDataDir(paths);

  const clock = createSystemClock(runtime.now);
  const db = openDatabase({ file: paths.db, clock });

  try {
    migrate(db);
    const repos = createRepositories(db);

    // ── model: absent settings mean "reads work, generation asks for setup"
    const settings = repos.settings.model();
    const model: ModelHandle | null =
      settings === null ? null : createModelHandle(settings, env);

    // ── snapshot / publish / jobs
    const snapshotService = createSnapshotService({ paths, repos, clock });
    const publisher = createPublisher({ paths, db, repos, clock });
    const registry = createSourceRegistry({
      clock,
      sources: repos.sources,
      generations: repos.generations,
    });
    const external = createExternalDocService({ paths, clock });
    const usage = createUsageMeter({ db, repos, clock });

    const jobRunner = createJobRunner({
      db,
      repos,
      paths,
      clock,
      snapshotService,
      publisher,
      upstream: createUpstreamGenerationPort(),
      lessons: createChangeLessonBuilder(),
      model,
      usage,
      registry,
      external,
    });

    // ── read-only Q&A
    const conversations = createConversationService({ db, repos, clock });
    const retriever = createRetriever({
      upstream: createUpstreamRetrievalPort(),
      source: createSourceSearcher(),
      resolve: (binding: Binding) =>
        resolveRetrievalContext({ paths, repos, snapshotService }, binding),
    });
    const answers = createAnswerService({
      db,
      repos,
      clock,
      model,
      retriever,
      registry,
      snapshotService,
      external,
      conversations,
    });

    // ── session, removal, watch
    const session = createSessionStore(paths);
    const removal = createRemovalService({
      db,
      repos,
      clock,
      jobs: jobRunner,
    });
    const github = createGithubClient({
      baseUrl: runtime.githubBaseUrl,
      credential: loadCredential(paths, env),
      clock,
    });
    const discovery = createDiscoveryService({
      db,
      repos,
      clock,
      github,
      paths,
    });
    const watch = createWatchScheduler({
      db,
      repos,
      clock,
      github,
      discovery,
      jobRunner,
      intervalMs: runtime.watchIntervalMs,
    });

    return {
      paths,
      clock,
      db,
      repos,
      jobRunner,
      publisher,
      watch,
      snapshotService,
      retriever,
      conversations,
      answers,
      registry,
      external,
      model,
      session,
      removal,
      usage,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

// ── route modules ───────────────────────────────────────────────────────────

/**
 * Every route module, loaded lazily so the module graph is built after process
 * hardening. The server binds these to the single `AppDeps` instance; nothing
 * here constructs a second dependency root.
 */
const ROUTE_MODULES: readonly (() => Promise<RouteModule>)[] = [
  () => import("./routes/projects.js").then((module) => module.projectsRoutes),
  () => import("./routes/jobs.js").then((module) => module.jobsRoutes),
  () =>
    import("./routes/generations.js").then(
      (module) => module.generationsRoutes,
    ),
  () =>
    import("./routes/conversations.js").then(
      (module) => module.conversationsModule,
    ),
  () => import("./routes/prefs.js").then((module) => module.prefsModule),
  () => import("./routes/terms.js").then((module) => module.termsModule),
  () => import("./routes/settings.js").then((module) => module.settingsModule),
  () => import("./routes/ops.js").then((module) => module.opsModule),
  () => import("./routes/changes.js").then((module) => module.changesModule),
];

/** Registers every route module; a typo in a module fails at boot. */
async function registerRouteModules(): Promise<void> {
  const { registerRouteModule } = await import("./router.js");
  for (const load of ROUTE_MODULES) {
    registerRouteModule(await load());
  }
}

/**
 * Fails boot when a `RouteHandlerKey` has no handler. `health`/`bootstrap` are
 * supplied inline by `api/server.ts`; every other key must come from a route
 * module. Without this, a missing wire would only surface as a runtime 500.
 */
async function assertEveryRouteResolves(): Promise<void> {
  const [{ ROUTE_HANDLER_KEYS, registeredHandlers }, { LearningError }] =
    await Promise.all([import("./router.js"), import("../contracts/index.js")]);

  const inline: ReadonlySet<string> = new Set(["health", "bootstrap"]);
  const bound = registeredHandlers();
  const missing = [...ROUTE_HANDLER_KEYS].filter(
    (key) => !inline.has(key) && !bound.has(key),
  );
  if (missing.length > 0) {
    throw new LearningError("internal_error", "路由处理器未全部装配", {
      missing,
    });
  }
}

// ── boot / shutdown (AC-OPS-02) ─────────────────────────────────────────────

interface BootState {
  deps: AppDeps | null;
  server: { close: () => Promise<void> } | null;
  draining: boolean;
}

/**
 * Drains in the documented order — HTTP listener → watch scheduler → job
 * queue — then exits **0**. Repeated signals are idempotent. A signal that
 * arrives before startup finishes still exits 0.
 */
async function drain(state: BootState): Promise<void> {
  if (state.draining) return;
  state.draining = true;

  try {
    if (state.server !== null) await state.server.close();
  } catch {
    // A listener that already failed to start has nothing to close.
  }
  try {
    state.deps?.watch.stop();
  } catch {
    // Stopping an unstarted scheduler is a no-op.
  }
  try {
    await state.deps?.jobRunner.drain();
  } catch {
    // Draining best-effort: shutdown must still complete.
  }
  try {
    state.deps?.db.close();
  } catch {
    // Closing twice is harmless.
  }

  process.exit(0);
}

function installSignalHandlers(state: BootState): void {
  const onSignal = (): void => {
    void drain(state);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

/**
 * Boots the learning server: hardening → arguments → dependency root →
 * restart recovery → route registration → watch → listen → URL.
 */
export async function main(argv: readonly string[]): Promise<void> {
  // Hardening is already the module's first statement; repeating it here keeps
  // `main` self-contained and idempotent (it only writes env values).
  applyProcessHardening(process.env);

  const options = await parseArgv(argv);
  const env: NodeJS.ProcessEnv =
    options.port === null
      ? process.env
      : { ...process.env, CODETRAIL_PORT: String(options.port) };

  const state: BootState = { deps: null, server: null, draining: false };
  installSignalHandlers(state);

  try {
    const { resolveEnv } = await import("../config/env.js");
    const runtime = resolveEnv(env);
    const { createLearningServer } = await import("./server.js");
    const { createStaticUi } = await import("./static.js");
    const { LearningError } = await import("../contracts/index.js");

    const deps = await createAppDeps(env);
    state.deps = deps;

    // Restart recovery completes before the listener exists, so no request can
    // observe a half-recovered database (AC-OPS-02).
    await deps.jobRunner.recoverInterrupted();
    deps.repos.conversations.cancelStreaming();

    await registerRouteModules();
    await assertEveryRouteResolves();
    deps.watch.start();

    let server: RunningServer;
    try {
      server = await createLearningServer({
        paths: deps.paths,
        port: runtime.port,
        clock: deps.clock,
        deps,
        ui: createStaticUi(deps),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new LearningError("conflict", `端口已被占用: ${runtime.port}`, {
          port: runtime.port,
        });
      }
      throw error;
    }
    state.server = server;

    // Exactly one line on stdout: the loopback URL (AC-OPS-02).
    process.stdout.write(`${server.url}\n`);
  } catch (error) {
    state.deps?.watch.stop();
    state.deps?.db.close();
    throw error;
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

async function isEntryPoint(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const [{ realpathSync }, { pathToFileURL }] = await Promise.all([
    import("node:fs"),
    import("node:url"),
  ]);
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

/** Runs the entry point, mapping failures onto a structured body + exit code. */
async function run(): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const { LearningError, toErrorBody } =
      await import("../contracts/index.js");
    const body: { error: { code: string; message: string } } =
      error instanceof LearningError
        ? toErrorBody(error)
        : {
            error: {
              code: "internal_error",
              message: error instanceof Error ? error.message : String(error),
            },
          };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    process.exitCode =
      error instanceof LearningError && error.code === "invalid_input" ? 2 : 1;
  }
}

if (await isEntryPoint()) {
  void run();
}
