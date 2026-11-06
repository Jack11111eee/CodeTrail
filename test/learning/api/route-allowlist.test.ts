import { describe, expect, it } from "vitest";

import {
  matchRoute,
  registerRouteModule,
  ROUTES,
  ROUTE_HANDLER_KEYS,
} from "../../../src/learning/api/router.ts";
import type {
  HandlerFactory,
  RouteModule,
} from "../../../src/learning/contracts/index.ts";

/**
 * The route table contains PRD §5 plus the model connectivity test.
 *
 * The expected list is written out independently of `ROUTES` and compared in
 * order; the DTO table in architecture §3.8 has the same sequence, so a
 * one-entry drift in either direction fails here.
 */

const SECTION_14_1_ORDER: readonly (readonly [string, string])[] = [
  ["GET", "/api/health"],
  ["GET", "/session/bootstrap"],
  ["POST", "/api/projects"],
  ["GET", "/api/projects"],
  ["GET", "/api/projects/:id"],
  ["GET", "/api/projects/:id/dependents"],
  ["DELETE", "/api/projects/:id"],
  ["POST", "/api/projects/:id/analyses"],
  ["POST", "/api/projects/:id/comparisons"],
  ["GET", "/api/jobs/:id"],
  ["GET", "/api/jobs/:id/events"],
  ["POST", "/api/jobs/:id/cancel"],
  ["POST", "/api/jobs/:id/retry"],
  ["GET", "/api/generations/:id/lessons"],
  ["GET", "/api/generations/:id/lessons/:lessonId"],
  ["DELETE", "/api/generations/:id/lessons/:lessonId"],
  ["POST", "/api/generations/:id/lessons/:lessonId/restore"],
  ["GET", "/api/generations/:id/sources/:sourceId"],
  ["GET", "/api/generations/:id/coverage"],
  ["POST", "/api/generations/:id/topics"],
  ["GET", "/api/topics/:id"],
  ["POST", "/api/topics/:id/messages"],
  ["DELETE", "/api/topics/:id"],
  ["POST", "/api/topics/:id/restore"],
  ["POST", "/api/conversations"],
  ["GET", "/api/conversations/:id"],
  ["GET", "/api/conversations/:id/messages"],
  ["POST", "/api/conversations/:id/messages"],
  ["PUT", "/api/projects/:id/watch"],
  ["GET", "/api/projects/:id/changes"],
  ["GET", "/api/projects/:id/changes/:changeId"],
  ["GET", "/api/preferences"],
  ["PUT", "/api/preferences"],
  ["GET", "/api/terms"],
  ["GET", "/api/terms/:id"],
  ["GET", "/api/settings/model"],
  ["PUT", "/api/settings/model"],
  ["POST", "/api/settings/model/test"],
  ["GET", "/api/usage"],
  ["GET", "/api/storage"],
];

const routePairs = (): string[] =>
  ROUTES.map((route) => `${route.method} ${route.pattern}`);

describe("ROUTES equals the expected API set", () => {
  it("has exactly 40 entries", () => {
    expect(ROUTES).toHaveLength(40);
  });

  it("matches the ordered (method, pattern) list entry for entry", () => {
    expect(routePairs()).toEqual(
      SECTION_14_1_ORDER.map(([method, pattern]) => `${method} ${pattern}`),
    );
  });

  it("is set-equal in both directions (no extras, no omissions)", () => {
    const actual = new Set(routePairs());
    const expected = new Set(
      SECTION_14_1_ORDER.map(([method, pattern]) => `${method} ${pattern}`),
    );
    for (const pair of expected) expect(actual.has(pair)).toBe(true);
    for (const pair of actual) expect(expected.has(pair)).toBe(true);
    expect(actual.size).toBe(40);
  });

  it("makes only health and bootstrap public", () => {
    const publicRoutes = ROUTES.filter((route) => route.auth === "public");
    expect(publicRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /api/health",
      "GET /session/bootstrap",
    ]);
  });

  it("names every handler key exactly once", () => {
    const keys = ROUTES.map((route) => route.handler);
    expect(new Set(keys).size).toBe(ROUTES.length);
    expect(ROUTE_HANDLER_KEYS.size).toBe(ROUTES.length);
  });
});

describe("the table grants no forbidden capability (AC-SCOPE-01)", () => {
  const forbidden = [
    /github/i,
    /repo(?:sitory)?-?write/i,
    /comment/i,
    /\/pulls?\b/i,
    /\/issues?\b/i,
    /merge/i,
    /push/i,
    /exec(?:ute)?\b/i,
    /shell/i,
    /command/i,
    /terminal/i,
    /eval\b/i,
    /arbitrary/i,
    /\bfiles?\b/i,
    /browse/i,
    /\burl\b/i,
    /account/i,
    /collaborat/i,
    /invite/i,
    /score/i,
    /grade/i,
    /exam/i,
    /mastery/i,
  ];

  it("has no GitHub write, execution, arbitrary read/fetch, account or scoring path", () => {
    for (const route of ROUTES) {
      const label = `${route.method} ${route.pattern}`;
      for (const pattern of forbidden) {
        expect(pattern.test(label), `${label} matched ${String(pattern)}`).toBe(
          false,
        );
      }
    }
  });

  it("only accepts opaque id parameters, never a path or URL", () => {
    const allowed = new Set(["id", "lessonId", "sourceId", "changeId"]);
    for (const route of ROUTES) {
      const params = route.pattern.match(/:([A-Za-z0-9_]+)/gu) ?? [];
      for (const raw of params) {
        expect(allowed.has(raw.slice(1))).toBe(true);
      }
    }
  });

  it("keeps every non-/api route to the bootstrap entry only", () => {
    const nonApi = ROUTES.filter((route) => !route.pattern.startsWith("/api"));
    expect(nonApi.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /session/bootstrap",
    ]);
  });
});

describe("matchRoute", () => {
  it("extracts and percent-decodes params", () => {
    const match = matchRoute("GET", "/api/projects/prj_%E4%B8%AD");
    expect(match).not.toBeNull();
    if (match === null || !("route" in match)) throw new Error("no route");
    expect(match.route.handler).toBe("projects.get");
    expect(match.params.id).toBe("prj_中");
  });

  it("treats one trailing slash as the same path", () => {
    const withSlash = matchRoute("GET", "/api/projects/");
    const withoutSlash = matchRoute("GET", "/api/projects");
    expect(withSlash).toEqual(withoutSlash);
    if (withSlash === null || !("route" in withSlash)) {
      throw new Error("no route");
    }
    expect(withSlash.route.handler).toBe("projects.list");
  });

  it("returns the Allow list when the path matches another method", () => {
    expect(matchRoute("PUT", "/api/projects")).toEqual({
      allow: ["GET", "POST"],
    });
    expect(matchRoute("PUT", "/api/projects/prj_1")).toEqual({
      allow: ["GET", "DELETE"],
    });
    expect(matchRoute("DELETE", "/api/projects")).toEqual({
      allow: ["GET", "POST"],
    });
  });

  it("returns null for an unknown path", () => {
    expect(matchRoute("GET", "/api/does-not-exist")).toBeNull();
  });

  it("rejects traversal-shaped params before any handler runs", () => {
    expect(() => matchRoute("GET", "/api/projects/%2e%2e")).toThrowError(
      /路径超出允许范围/u,
    );
    expect(() =>
      matchRoute("GET", "/api/generations/g1/sources/%2Fetc%2Fpasswd"),
    ).toThrowError(/路径超出允许范围/u);
  });
});

describe("registerRouteModule validation", () => {
  const empty: HandlerFactory = () => () => ({
    kind: "empty",
    status: 204,
  });

  it("rejects an unknown handler key", () => {
    const module = {
      id: "ops",
      routes: [],
      handlers: { "projects.nope": empty },
    } as unknown as RouteModule;
    expect(() => {
      registerRouteModule(module);
    }).toThrowError(/未知处理器/u);
  });

  it("rejects a duplicate route declaration", () => {
    const first = ROUTES[0];
    const module: RouteModule = {
      id: "ops",
      routes: [first, first],
      handlers: {},
    };
    expect(() => {
      registerRouteModule(module);
    }).toThrowError(/路由重复注册/u);
  });

  it("rejects a route whose handler disagrees with ROUTES", () => {
    const first = ROUTES[0];
    const module: RouteModule = {
      id: "ops",
      routes: [{ ...first, handler: "projects.list" }],
      handlers: {},
    };
    expect(() => {
      registerRouteModule(module);
    }).toThrowError(/路由处理器不匹配/u);
  });

  it("accepts a module that matches the table", () => {
    const module: RouteModule = {
      id: "ops",
      routes: ROUTES,
      handlers: { "projects.list": empty },
    };
    expect(() => {
      registerRouteModule(module);
    }).not.toThrow();
  });
});
