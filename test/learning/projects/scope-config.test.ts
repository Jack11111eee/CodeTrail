import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  assertReadable,
  isReadable,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  cloneFixture,
  createHarness,
  restoreWritable,
  thrownBy,
  type ProjectsHarness,
} from "./harness.ts";

/**
 * AC-PRJ-10: include/exclude changes the scope hash, and every read outside
 * the include list is refused with `out_of_scope_path`.
 */
describe("scope configuration", () => {
  it("changes the hash for each configurable dimension", () => {
    const base = normalizeScope();
    const variants = [
      normalizeScope({ include: ["src/**"] }),
      normalizeScope({ exclude: ["docs/**"] }),
      normalizeScope({ maxFiles: 10 }),
      normalizeScope({ maxFileBytes: 10 }),
    ];
    for (const variant of variants) {
      expect(variant.hash).not.toBe(base.hash);
    }
    // The same logical scope always hashes identically.
    expect(normalizeScope({ include: ["src/**"] }).hash).toBe(variants[0].hash);
  });

  it("reads outside the include list are refused by assertReadable", () => {
    const scope = normalizeScope({
      include: ["src/**"],
      exclude: ["src/generated/**"],
    });
    expect(isReadable("src/app.py", scope)).toBe(true);
    expect(isReadable("README.md", scope)).toBe(false);
    expect(isReadable("src/generated/types.py", scope)).toBe(false);

    expect(() => assertReadable("src/app.py", scope)).not.toThrow();
    const outside = thrownBy(() => assertReadable("README.md", scope));
    expect(outside.code).toBe("out_of_scope_path");
    expect(outside.status).toBe(403);
    expect(outside.details).toMatchObject({ path: "README.md" });

    const excluded = thrownBy(() =>
      assertReadable("src/generated/types.py", scope),
    );
    expect(excluded.code).toBe("out_of_scope_path");
  });

  it("default scope still refuses secrets, build output and dependency trees", () => {
    const scope = normalizeScope();
    for (const path of [
      ".env",
      "node_modules/left-pad/index.js",
      "dist/bundle.js",
      "model.bin",
      "weights/model.safetensors",
    ]) {
      expect(() => assertReadable(path, scope), path).toThrow(LearningError);
    }
  });
});

describe("SnapshotService honours the read scope", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    if (harness !== undefined) {
      restoreWritable(harness.paths.work);
      harness.close();
    }
    harness = undefined;
  });

  it("reads inside the include and rejects everything else", async () => {
    harness = await createHarness();
    const fixture = await cloneFixture(harness, "scope-hygiene");
    const service = createSnapshotService({
      paths: harness.paths,
      repos: harness.repos,
      clock: harness.clock,
    });
    const snapshot = await service.ensure(fixture.repo.repoId, fixture.sha);
    const scope = normalizeScope({ include: ["src/**"] });

    await expect(
      service.readFile(snapshot, "src/app.py", scope),
    ).resolves.toContain("def greet");

    await expect(
      service.readFile(snapshot, "README.md", scope),
    ).rejects.toMatchObject({ code: "out_of_scope_path" });

    await expect(
      service.readFile(snapshot, ".env", normalizeScope()),
    ).rejects.toMatchObject({ code: "out_of_scope_path" });
  });
});
