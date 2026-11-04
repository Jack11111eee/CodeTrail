import { describe, expect, it } from "vitest";

import {
  REQUIRED_LESSON_GROUPS,
  parseLesson,
} from "../../../src/learning/lessons/schema.ts";
import {
  changeLesson,
  clone,
  comparisonLesson,
  researchLesson,
} from "../helpers/lesson-sample.ts";

type JsonObject = Record<string, unknown>;

function deleteAt(root: JsonObject, path: string[]): void {
  let cursor: JsonObject = root;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as JsonObject;
  }
  delete cursor[path[path.length - 1]];
}

function at(root: JsonObject, key: string): JsonObject {
  return root[key] as JsonObject;
}

/** AC-LES-02: deleting exactly one required field yields exactly one failure. */
describe("missing required group", () => {
  it.each(REQUIRED_LESSON_GROUPS)(
    "deleting %s fails once and names it",
    (group) => {
      const sample = clone(researchLesson());
      delete sample[group];

      const result = parseLesson(sample);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].group).toBe(group);
        expect(
          `${result.failures[0].path} ${result.failures[0].message}`,
        ).toContain(group);
      }
    },
  );
});

interface NestedCase {
  name: string;
  path: string[];
  field: string;
  prepare?: (sample: JsonObject) => void;
}

const NESTED_CASES: NestedCase[] = [
  { name: "context.repoId", path: ["context", "repoId"], field: "repoId" },
  { name: "scenario.kind", path: ["scenario", "kind"], field: "kind" },
  {
    name: "overview[0].responsibility",
    path: ["overview", "0", "responsibility"],
    field: "responsibility",
  },
  {
    name: "plainExplanation[0].mechanismId",
    path: ["plainExplanation", "0", "mechanismId"],
    field: "mechanismId",
  },
  {
    name: "technicalExplanation[0].terms[0].zh",
    path: ["technicalExplanation", "0", "terms", "0", "zh"],
    field: "zh",
  },
  {
    name: "choices[0].alternatives[0].cost",
    path: ["choices", "0", "alternatives", "0", "cost"],
    field: "cost",
  },
  {
    name: "boundaries[0].status",
    path: ["boundaries", "0", "status"],
    field: "status",
  },
  {
    name: "statements[0].label",
    path: ["statements", "0", "label"],
    field: "label",
  },
  {
    name: "statements[0].evidenceIds",
    path: ["statements", "0", "evidenceIds"],
    field: "evidenceIds",
  },
  {
    name: "diagram.nodes[0].status",
    path: ["diagram", "nodes", "0", "status"],
    field: "status",
  },
  {
    name: "diagram.edges[0].inferred",
    path: ["diagram", "edges", "0", "inferred"],
    field: "inferred",
    prepare: (sample) => {
      (at(sample, "diagram")).edges = [
        {
          from: "n1",
          to: "n1",
          label: "self",
          evidenceIds: ["s_0123456789abcdef"],
          inferred: false,
        },
      ];
    },
  },
];

describe("missing nested field", () => {
  it.each(NESTED_CASES)("$name fails and names $field", (testCase) => {
    const sample = clone(researchLesson());
    testCase.prepare?.(sample);
    deleteAt(sample, testCase.path);

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.failures.some((failure) =>
          `${failure.path} ${failure.message}`.includes(testCase.field),
        ),
      ).toBe(true);
    }
  });
});

/** The change schema owns the six `ChangeRecordFields`, never the research one. */
describe("change lesson fields", () => {
  const CHANGE_FIELDS = [
    "behaviorChange",
    "affectedModules",
    "keyTechnologies",
    "alternatives",
    "evidence",
    "unverifiedEffects",
  ] as const;

  it.each(CHANGE_FIELDS)("deleting %s fails once", (field) => {
    const sample = clone(changeLesson());
    delete sample[field];

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain(field);
    }
  });
});

/** The comparison schema owns `context.comparison` and statement sides. */
describe("comparison lesson invariants", () => {
  it("rejects a comparison payload without context.comparison", () => {
    const sample = clone(comparisonLesson());
    delete at(sample, "context").comparison;

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("comparison");
    }
  });

  it("rejects a comparison whose base and head commits are identical", () => {
    const sample = clone(comparisonLesson());
    const comparison = at(sample, "context").comparison as JsonObject;
    (at(comparison, "head")).commitSha = (
      at(comparison, "base")
    ).commitSha;

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("commitSha");
    }
  });

  it("requires a side on every comparison statement", () => {
    const sample = clone(comparisonLesson());
    delete (at(sample, "statements") as unknown as JsonObject[])[0].side;

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("side");
    }
  });

  it("rejects a side on a research statement", () => {
    const sample = clone(researchLesson());
    (at(sample, "statements") as unknown as JsonObject[])[0].side = "base";

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("side");
    }
  });

  it("rejects context.comparison on a research lesson", () => {
    const sample = clone(researchLesson());
    at(sample, "context").comparison = {
      base: {
        repoId: "r_base",
        commitSha: "b".repeat(40),
        generationId: "g_base",
      },
      head: {
        repoId: "r_head",
        commitSha: "c".repeat(40),
        generationId: "g_head",
      },
    };

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("comparison");
    }
  });
});

describe("cross-field invariants", () => {
  it("rejects empty choices without a reason", () => {
    const sample = clone(researchLesson());
    sample.choices = [];
    sample.choicesOmittedReason = null;

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].group).toBe("choices");
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("choicesOmittedReason");
    }
  });

  it("rejects an edge that points at an undeclared node", () => {
    const sample = clone(researchLesson());
    const diagram = at(sample, "diagram");
    diagram.edges = [
      {
        from: "ghost",
        to: "n1",
        label: "dangling",
        evidenceIds: ["s_0123456789abcdef"],
        inferred: false,
      },
    ];

    const result = parseLesson(sample);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("edges");
      expect(result.failures[0].message).toContain("ghost");
    }
  });
});

/** AC-LES-12: the schema/gate rejects `user_flow` for a non-UI project. */
describe("user_flow on a non-UI project", () => {
  it("blocks publishing when isUiProject is false", () => {
    const sample = clone(researchLesson());
    at(sample, "scenario").kind = "user_flow";

    const result = parseLesson(sample, { isUiProject: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].group).toBe("scenario");
      expect(
        `${result.failures[0].path} ${result.failures[0].message}`,
      ).toContain("user_flow");
    }
  });

  it("still accepts user_flow when the project has a UI surface", () => {
    const sample = clone(researchLesson());
    at(sample, "scenario").kind = "user_flow";
    expect(parseLesson(sample, { isUiProject: true }).ok).toBe(true);
  });
});
