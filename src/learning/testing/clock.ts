/**
 * Injectable clock (architecture §17.3, §4.1).
 *
 * `Clock` is declared in `contracts/ports.ts`; this module supplies the
 * implementation used by the application and by the test suites. The clock is
 * frozen unless a test moves it: watch ticks, cache keys and staleness checks
 * must never depend on the wall clock during a run.
 *
 * The initial instant is `fixed`, else `CODETRAIL_NOW`, else `Date.now()`.
 * `CODETRAIL_NOW` is validated by `resolveEnv`, so a malformed timestamp fails
 * with `invalid_input` before an inconsistent instant can leak into a record.
 */

import { resolveEnv } from "../config/env.js";
import { LearningError } from "../contracts/index.js";
import type { Clock } from "../contracts/index.js";

export type { Clock };

function parseInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new LearningError(
      "invalid_input",
      `${field} must be an ISO timestamp`,
      {
        field,
      },
    );
  }
  return parsed;
}

/** Creates a mutable clock, honouring `fixed` and then `CODETRAIL_NOW`. */
export function createClock(fixed?: string): Clock {
  let current: number;
  if (fixed !== undefined) {
    current = parseInstant(fixed, "fixed");
  } else {
    const now = resolveEnv(process.env).now;
    current = now === null ? Date.now() : parseInstant(now, "CODETRAIL_NOW");
  }

  return {
    now(): Date {
      return new Date(current);
    },
    set(iso: string): void {
      current = parseInstant(iso, "iso");
    },
    advance(ms: number): void {
      if (!Number.isFinite(ms)) {
        throw new LearningError(
          "invalid_input",
          "advance must be a finite number",
          {
            field: "ms",
          },
        );
      }
      current += ms;
    },
  };
}
