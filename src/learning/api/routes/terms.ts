/**
 * Bilingual term glossary (architecture §3.8, §3.11, §14.1).
 *
 * `GET /api/terms?q=` filters on the server through `TermsRepo.list(q)` — the
 * handler never filters in memory, so `q` matching is one SQL `LIKE` over both
 * `zh` and `en`. Every row is projected to `TermView`, whose `links` carry the
 * cross-project generation/source references (AC-UI-07, AC-F08-01).
 */

import { LearningError, errorMessageFor } from "../../contracts/index.js";
import type {
  HandlerFactory,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  TermId,
  TermListView,
  TermView,
} from "../../contracts/index.js";

export const routes: RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/terms",
    auth: "session",
    handler: "terms.list",
  },
  {
    method: "GET",
    pattern: "/api/terms/:id",
    auth: "session",
    handler: "terms.get",
  },
];

const listTerms: HandlerFactory = (deps) => (req) => {
  const raw = req.query.q;
  const trimmed = raw === undefined ? undefined : raw.trim();
  const terms: TermView[] = deps.repos.terms.list(
    trimmed === undefined || trimmed === "" ? undefined : trimmed,
  );
  const body: TermListView = { terms };
  return Promise.resolve({ kind: "json", status: 200, body });
};

const getTerm: HandlerFactory = (deps) => (req) => {
  const termId = req.params.id;
  if (termId === undefined || termId === "") {
    throw new LearningError("not_found", errorMessageFor("not_found", "zh"), {
      termId: null,
    });
  }
  const term = deps.repos.terms.byId(termId as TermId);
  if (term === null) {
    throw new LearningError("not_found", errorMessageFor("not_found", "zh"), {
      termId,
    });
  }
  return Promise.resolve({ kind: "json", status: 200, body: term });
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "terms.list": listTerms,
  "terms.get": getTerm,
};

export const termsModule: RouteModule = {
  id: "terms",
  routes,
  handlers,
};
