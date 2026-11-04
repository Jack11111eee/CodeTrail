import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderProjectsPage } from "../../../src/learning/ui/pages/projects.ts";
import { pageContext, projectsModel } from "./fixtures.ts";

/**
 * The progressive-enhancement bundle is an ES module (`tsconfig.client.json`
 * compiles it to `export {}`). A classic `<script>` would throw a SyntaxError
 * and every interaction would silently do nothing, so the emitted tag must
 * opt into module semantics.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("client bundle loading", () => {
  it("emits a module script tag for the bundle", () => {
    const html = renderProjectsPage(pageContext, projectsModel());
    expect(html).toContain(
      '<script type="module" src="/assets/client.js" defer></script>',
    );
  });

  it("compiles the bundle to a module that a classic script cannot parse", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "learning", "ui", "client.ts"),
      "utf8",
    );
    expect(source).toMatch(/^export\s*\{\s*\};?\s*$/mu);

    const compiled = path.join(
      REPO_ROOT,
      "dist",
      "learning",
      "ui",
      "client.js",
    );
    // `pnpm build` emits the artifact before `pnpm test`; a source-only run may
    // not have it, in which case the source assertion above still guards us.
    if (!existsSync(compiled)) return;
    const text = readFileSync(compiled, "utf8");
    expect(text).toMatch(/\bexport\s*\{/u);
    expect(() => new Function(text)).toThrow(SyntaxError);
  });
});
