/**
 * Child process for the crash-consistency matrix.
 *
 * It builds the same harness as the parent, enqueues one update job and lets
 * the writer loop run. `CODETRAIL_FAULT_INJECT` makes `faultPoint` terminate
 * the process at the requested boundary, which is exactly the durability event
 * the parent then restarts from.
 */

import { createHarness, generationInput } from "./harness.ts";

async function main(): Promise<void> {
  const sha = process.env.CODETRAIL_CRASH_SHA;
  const oldSha = process.env.CODETRAIL_CRASH_OLD_SHA;
  if (sha === undefined || oldSha === undefined) {
    throw new Error("CODETRAIL_CRASH_SHA and CODETRAIL_CRASH_OLD_SHA are required");
  }
  const harness = await createHarness({
    dataDir: process.env.CODETRAIL_DATA_DIR,
    commits: [oldSha, sha],
  });
  try {
    await harness.runner.enqueue(
      generationInput(harness, { sha, mode: "update" }),
    );
    await harness.runner.drain();
  } finally {
    harness.close();
  }
}

void main();
