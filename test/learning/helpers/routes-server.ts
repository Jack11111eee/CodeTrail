/**
 * A real learning server with the production store, but only the route modules
 * a test asks for. The HTTP core and the SQLite repositories are the real ones,
 * so request validation, the error funnel and the DTO projections are exercised
 * end to end (architecture §17.5).
 */

import { createSessionStore } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import {
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import type { DataPaths } from "../../../src/learning/config/paths.ts";
import type {
  AppDeps,
  Clock,
  Database,
  Repositories,
  RouteModule,
  RunningServer,
  SessionStore,
} from "../../../src/learning/contracts/index.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export interface RoutesServer {
  url: string;
  port: number;
  paths: DataPaths;
  clock: Clock;
  db: Database;
  repos: Repositories;
  session: SessionStore;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function startRoutesServer(
  modules: RouteModule[],
): Promise<RoutesServer> {
  const paths = resolveDataPaths(process.env);
  await ensureDataDir(paths);

  const db = openDatabase({ file: paths.db });
  migrate(db);
  const repos = createRepositories(db);
  const session = createSessionStore(paths);
  const clock = createClock(FIXED_NOW);
  const deps = {
    paths,
    clock,
    db,
    repos,
    session,
    model: null,
  } as unknown as AppDeps;

  for (const module of modules) registerRouteModule(module);

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
    clock,
    db,
    repos,
    session,
    deps,
    async close(): Promise<void> {
      await server.close();
      db.close();
    },
  };
}
