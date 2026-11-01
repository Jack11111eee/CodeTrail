#!/usr/bin/env node
/**
 * GIT_ASKPASS helper for every Git invocation that may need a credential.
 *
 * `projects/git.ts` sets `GIT_ASKPASS` to this file and puts the token in
 * `CODETRAIL_GIT_TOKEN` (never in `argv`, never on disk, never in a URL). Git
 * invokes the helper with a single prompt argument — "Username for ..." or
 * "Password for ..." — and reads the answer from stdout. The prompt is
 * deliberately ignored: the token is the only answer this helper ever gives.
 *
 * Contract:
 *   - `CODETRAIL_GIT_TOKEN` set   -> print the token plus one newline, exit 0
 *   - `CODETRAIL_GIT_TOKEN` unset -> print nothing, exit 1 (Git then fails
 *     fast, and `GIT_TERMINAL_PROMPT=0` keeps it from falling back to a TTY)
 *
 * The token is written to stdout and nowhere else: no logging, no argv echo, no
 * stderr. Keeping the helper this small is the point — it is the one process
 * that must be trusted with the secret.
 */
const token = process.env.CODETRAIL_GIT_TOKEN;

if (typeof token !== "string" || token.length === 0) {
  process.exit(1);
}

process.stdout.write(`${token}\n`);
