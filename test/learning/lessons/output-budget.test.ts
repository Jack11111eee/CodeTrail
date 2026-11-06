import { AIMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildResearchLessons,
  assertPublishable,
} from "../../../src/learning/lessons/builder.ts";
import {
  EMPTY_CLAIMS,
  cleanupScripts,
  fakeSnapshot,
  fixedClock,
  okMermaid,
  researchFixture,
  scriptedHandle,
  scriptDir,
  stubExternal,
} from "../helpers/lesson-context.ts";
import { emptyCoverage } from "../helpers/lesson-sample.ts";

afterEach(cleanupScripts);

describe("lesson output contract and output budget", () => {
  it("retries a truncated draft once with an explicit compact schema, then validates the result", async () => {
    const fixture = researchFixture();
    const original = scriptedHandle(scriptDir([]));
    const {
      plainExplanation,
      technicalExplanation,
      choices,
      choicesOmittedReason,
      boundaries,
      statements,
      evidence,
      diagram,
    } = fixture.lesson;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(
        new AIMessage({
          content: '{"plainExplanation":[',
          response_metadata: { stop_reason: "max_tokens" },
        }),
      )
      .mockResolvedValueOnce(
        new AIMessage(
          JSON.stringify({
            plainExplanation,
            technicalExplanation,
            choices,
            choicesOmittedReason,
            boundaries,
            statements,
            evidence,
            diagram,
          }),
        ),
      );
    const model = { ...original, chat: () => ({ invoke }) as never };
    const result = await buildResearchLessons(
      {
        generation: fixture.ctx.generation,
        snapshot: fakeSnapshot(fixture.files),
        scope: fixture.ctx.scope,
        coverage: emptyCoverage(["src/index.ts"]),
        model,
        registry: fixture.registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );
    expect(result.failures).toEqual([]);
    expect(result.lessons).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    const second: unknown = invoke.mock.calls[1][0];
    const prompt = JSON.stringify(second);
    expect(prompt).toContain("mechanismId");
    expect(prompt).toContain("evidenceIds");
    expect(prompt).toContain("fresh compact object");
    expect(Array.isArray(second) && second.length).toBe(2);
  });

  it("stops after one compact retry and reports the reason without publishing malformed output", async () => {
    const fixture = researchFixture();
    const original = scriptedHandle(scriptDir([]));
    const invoke = vi.fn().mockResolvedValue(
      new AIMessage({
        content: '{"plainExplanation":[',
        response_metadata: { stop_reason: "max_tokens" },
      }),
    );
    const result = await buildResearchLessons(
      {
        generation: fixture.ctx.generation,
        snapshot: fakeSnapshot(fixture.files),
        scope: fixture.ctx.scope,
        coverage: emptyCoverage(["src/index.ts"]),
        model: { ...original, chat: () => ({ invoke }) as never },
        registry: fixture.registry,
        external: stubExternal(),
        clock: fixedClock(),
      },
      { claims: EMPTY_CLAIMS, mermaid: okMermaid() },
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.lessons).toHaveLength(0);
    expect(() => assertPublishable(result)).toThrow("输出上限");
  });
});
