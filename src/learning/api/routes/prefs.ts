/**
 * Preferences and reading positions (architecture §3.8, §3.11, §14.1).
 *
 * Two independent stores, two independent payload fields: `explainLevel` /
 * `background` go to `learner_preferences` (bumping the preference version),
 * `readingPosition` goes to `reading_positions`. Neither write path can touch
 * the other table, and the response carries only `{preferences,
 * readingPositions}` — no skill level, ranking or ability field exists in the
 * DTO (AC-UI-08, AC-SCOPE-02). A reading position is a reader restore
 * point, never a comprehension signal (§11.4).
 */

import { LearningError, errorMessageFor } from "../../contracts/index.js";
import type {
  AppDeps,
  HandlerFactory,
  LearnerPreferences,
  PreferencesView,
  PutPreferencesRequest,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
} from "../../contracts/index.js";

export const routes: RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/preferences",
    auth: "session",
    handler: "preferences.get",
  },
  {
    method: "PUT",
    pattern: "/api/preferences",
    auth: "session",
    handler: "preferences.put",
  },
];

function view(deps: AppDeps): PreferencesView {
  return {
    preferences: deps.repos.prefs.get(),
    readingPositions: deps.repos.prefs.readingPositions(),
  };
}

const getPreferences: HandlerFactory = (deps) => () =>
  Promise.resolve({
    kind: "json",
    status: 200,
    body: view(deps),
  });

const putPreferences: HandlerFactory = (deps) => (req) => {
  if (
    typeof req.body !== "object" ||
    req.body === null ||
    Array.isArray(req.body)
  ) {
    throw new LearningError(
      "invalid_input",
      errorMessageFor("invalid_input", "zh"),
      { field: "body" },
    );
  }
  const body = req.body as PutPreferencesRequest;

  // Preferences and reading positions are written through separate statements
  // below; a payload naming only one of them never touches the other table.
  const patch: Partial<LearnerPreferences> = {};
  if (body.explainLevel !== undefined) patch.explainLevel = body.explainLevel;
  if (body.background !== undefined) patch.background = body.background;
  if (patch.explainLevel !== undefined || patch.background !== undefined) {
    deps.repos.prefs.put(patch);
  }

  if (body.readingPosition !== undefined) {
    deps.repos.prefs.putReadingPosition({
      generationId: body.readingPosition.generationId,
      lessonId: body.readingPosition.lessonId,
      conversationId: null,
      offset: body.readingPosition.offset,
      updatedAt: deps.clock.now().toISOString(),
    });
  }

  return Promise.resolve({
    kind: "json",
    status: 200,
    body: view(deps),
  });
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "preferences.get": getPreferences,
  "preferences.put": putPreferences,
};

export const prefsModule: RouteModule = {
  id: "prefs",
  routes,
  handlers,
};
