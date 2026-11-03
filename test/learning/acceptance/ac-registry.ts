/**
 * Canonical acceptance-criterion registry (architecture Appendix A).
 *
 * Each entry is the id, the owner that *is* the verdict (a test file or a
 * script/`package.json` command) and the owner kind. The table is transcribed
 * from Appendix A; `APPENDIX_A_IDS_SHA256` pins the exact id set so an id
 * cannot be added or dropped silently.
 */

export type AcceptanceOwnerKind = "test" | "command";

export interface AcceptanceOwner {
  /** The file or command that decides the criterion. */
  owner: string;
  kind: AcceptanceOwnerKind;
}

/** The sha256 of the newline-joined, sorted Appendix A id list. */
export const APPENDIX_A_IDS_SHA256 =
  "79031b360b41435fa5c18473b569d23be58335d38a84a40540525c61ab5a83e8";

/** Per-family row counts Appendix A pins (15 families, 208 ids). */
export const FAMILY_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  ENV: 5,
  FORK: 8,
  PRJ: 17,
  GEN: 20,
  LES: 17,
  RET: 9,
  QA: 15,
  UPD: 27,
  API: 13,
  SEC: 12,
  UI: 11,
  OPS: 9,
  R: 27,
  F: 10,
  "GATE+SCOPE": 8,
});

export const AC_REGISTRY: Readonly<Record<string, AcceptanceOwner>> =
  Object.freeze({
    "AC-API-01": {
      owner: "test/learning/api/route-allowlist.test.ts",
      kind: "test",
    },
    "AC-API-02": { owner: "test/learning/api/auth.test.ts", kind: "test" },
    "AC-API-03": {
      owner: "test/learning/api/not-found-and-unpublished.test.ts",
      kind: "test",
    },
    "AC-API-04": {
      owner: "test/learning/api/version-mismatch.test.ts",
      kind: "test",
    },
    "AC-API-05": {
      owner: "test/learning/api/out-of-scope-path.test.ts",
      kind: "test",
    },
    "AC-API-06": { owner: "test/learning/qa/model-seam.test.ts", kind: "test" },
    "AC-API-07": {
      owner: "test/learning/api/error-shape.test.ts",
      kind: "test",
    },
    "AC-API-08": {
      owner: "test/learning/api/method-not-allowed.test.ts",
      kind: "test",
    },
    "AC-API-09": {
      owner: "test/learning/api/idempotent-analysis.test.ts",
      kind: "test",
    },
    "AC-API-10": {
      owner: "test/learning/api/changes-pagination.test.ts",
      kind: "test",
    },
    "AC-API-11": {
      owner: "test/learning/api/request-limits.test.ts",
      kind: "test",
    },
    "AC-API-12": {
      owner: "test/learning/api/sse-authoritative-state.test.ts",
      kind: "test",
    },
    "AC-API-13": { owner: "test/learning/api/health.test.ts", kind: "test" },
    "AC-ENV-01": { owner: "pnpm:env:check", kind: "command" },
    "AC-ENV-02": { owner: "scripts/check-env.mjs", kind: "command" },
    "AC-ENV-03": { owner: "pnpm:env:check", kind: "command" },
    "AC-ENV-04": { owner: "scripts/check-env.mjs", kind: "command" },
    "AC-ENV-05": { owner: "pnpm:install", kind: "command" },
    "AC-F01-01": {
      owner: "test/learning/acceptance/f01-project-sources.test.ts",
      kind: "test",
    },
    "AC-F02-01": {
      owner: "test/learning/acceptance/f02-scenario-modules.test.ts",
      kind: "test",
    },
    "AC-F03-01": {
      owner: "test/learning/acceptance/f03-mechanism-depth.test.ts",
      kind: "test",
    },
    "AC-F04-01": {
      owner: "test/learning/acceptance/f04-chinese-and-graph.test.ts",
      kind: "test",
    },
    "AC-F05-01": {
      owner: "test/learning/acceptance/f05-continuous-qa-refresh.test.ts",
      kind: "test",
    },
    "AC-F06-01": {
      owner: "test/learning/acceptance/f06-watch-streams.test.ts",
      kind: "test",
    },
    "AC-F07-01": {
      owner: "test/learning/acceptance/f07-choices-and-boundaries.test.ts",
      kind: "test",
    },
    "AC-F08-01": {
      owner: "test/learning/acceptance/f08-preferences-term-links.test.ts",
      kind: "test",
    },
    "AC-F09-01": {
      owner: "test/learning/acceptance/f09-no-side-effects.test.ts",
      kind: "test",
    },
    "AC-F10-01": {
      owner: "test/learning/acceptance/f10-failure-resources.test.ts",
      kind: "test",
    },
    "AC-FORK-01": { owner: "pnpm:provenance:check", kind: "command" },
    "AC-FORK-02": { owner: "pnpm:provenance:check", kind: "command" },
    "AC-FORK-03": { owner: "scripts/check-provenance.mjs", kind: "command" },
    "AC-FORK-04": { owner: "pnpm:provenance:check", kind: "command" },
    "AC-FORK-05": { owner: "pnpm:test:upstream", kind: "command" },
    "AC-FORK-06": { owner: "pnpm:typecheck", kind: "command" },
    "AC-FORK-07": { owner: "pnpm:build", kind: "command" },
    "AC-FORK-08": { owner: "pnpm:test:upstream", kind: "command" },
    "AC-GATE-A": { owner: "pnpm:phase:check", kind: "command" },
    "AC-GATE-B": { owner: "pnpm:phase:check", kind: "command" },
    "AC-GATE-C": { owner: "pnpm:phase:check", kind: "command" },
    "AC-GATE-D": { owner: "pnpm:phase:check", kind: "command" },
    "AC-GATE-ORDER": { owner: "scripts/phase-check.mjs", kind: "command" },
    "AC-GEN-01": {
      owner: "test/learning/generation/job-state-machine.test.ts",
      kind: "test",
    },
    "AC-GEN-02": {
      owner: "test/learning/generation/cancel-queued.test.ts",
      kind: "test",
    },
    "AC-GEN-03": {
      owner: "test/learning/generation/cancel-running.test.ts",
      kind: "test",
    },
    "AC-GEN-04": {
      owner: "test/learning/generation/restart-interrupted.test.ts",
      kind: "test",
    },
    "AC-GEN-05": {
      owner: "test/learning/generation/retry-policy.test.ts",
      kind: "test",
    },
    "AC-GEN-06": {
      owner: "test/learning/generation/single-writer.test.ts",
      kind: "test",
    },
    "AC-GEN-07": {
      owner: "test/learning/generation/dedupe-key.test.ts",
      kind: "test",
    },
    "AC-GEN-08": {
      owner: "test/learning/generation/cache-hit.test.ts",
      kind: "test",
    },
    "AC-GEN-09": {
      owner: "test/learning/generation/seal-integrity.test.ts",
      kind: "test",
    },
    "AC-GEN-10": {
      owner: "test/learning/generation/crash-consistency.test.ts",
      kind: "test",
    },
    "AC-GEN-11": {
      owner: "test/learning/generation/failure-preserves-old.test.ts",
      kind: "test",
    },
    "AC-GEN-12": {
      owner: "test/learning/generation/publish-transaction.test.ts",
      kind: "test",
    },
    "AC-GEN-13": {
      owner: "test/learning/generation/baseline-reuse.test.ts",
      kind: "test",
    },
    "AC-GEN-14": {
      owner: "test/learning/generation/baseline-fallback.test.ts",
      kind: "test",
    },
    "AC-GEN-15": {
      owner: "test/learning/generation/protected-writes.test.ts",
      kind: "test",
    },
    "AC-GEN-16": {
      owner: "test/learning/generation/no-repo-setup-writes.test.ts",
      kind: "test",
    },
    "AC-GEN-17": {
      owner: "test/learning/generation/source-drift.test.ts",
      kind: "test",
    },
    "AC-GEN-18": {
      owner: "test/learning/generation/concurrency.test.ts",
      kind: "test",
    },
    "AC-GEN-19": {
      owner: "test/learning/generation/usage-records.test.ts",
      kind: "test",
    },
    "AC-GEN-20": {
      owner: "test/learning/generation/quota.test.ts",
      kind: "test",
    },
    "AC-LES-01": {
      owner: "test/learning/lessons/schema-valid.test.ts",
      kind: "test",
    },
    "AC-LES-02": {
      owner: "test/learning/lessons/schema-invalid.test.ts",
      kind: "test",
    },
    "AC-LES-03": {
      owner: "test/learning/lessons/layering.test.ts",
      kind: "test",
    },
    "AC-LES-04": {
      owner: "test/learning/lessons/choices.test.ts",
      kind: "test",
    },
    "AC-LES-05": {
      owner: "test/learning/lessons/boundaries.test.ts",
      kind: "test",
    },
    "AC-LES-06": {
      owner: "test/learning/lessons/statement-labels.test.ts",
      kind: "test",
    },
    "AC-LES-07": {
      owner: "test/learning/lessons/evidence-repo.test.ts",
      kind: "test",
    },
    "AC-LES-08": {
      owner: "test/learning/lessons/evidence-before-after.test.ts",
      kind: "test",
    },
    "AC-LES-09": {
      owner: "test/learning/lessons/diagram-kind.test.ts",
      kind: "test",
    },
    "AC-LES-10": {
      owner: "test/learning/lessons/diagram-evidence.test.ts",
      kind: "test",
    },
    "AC-LES-11": {
      owner: "test/learning/lessons/diagram-mermaid.test.ts",
      kind: "test",
    },
    "AC-LES-12": {
      owner: "test/learning/lessons/no-ui-scenario.test.ts",
      kind: "test",
    },
    "AC-LES-13": {
      owner: "test/learning/lessons/partial-publish.test.ts",
      kind: "test",
    },
    "AC-LES-14": { owner: "scripts/scan-copy.mjs", kind: "command" },
    "AC-LES-15": {
      owner: "test/learning/lessons/example-labeling.test.ts",
      kind: "test",
    },
    "AC-LES-16": {
      owner: "test/learning/lessons/export.test.ts",
      kind: "test",
    },
    "AC-LES-17": {
      owner: "test/learning/lessons/semantic-check-once.test.ts",
      kind: "test",
    },
    "AC-OPS-01": { owner: "pnpm:smoke", kind: "command" },
    "AC-OPS-02": { owner: "scripts/smoke.mjs", kind: "command" },
    "AC-OPS-03": {
      owner: "test/learning/ops/backup-restore.test.ts",
      kind: "test",
    },
    "AC-OPS-04": { owner: "test/learning/ops/gc.test.ts", kind: "test" },
    "AC-OPS-05": { owner: "scripts/scan-copy.mjs", kind: "command" },
    "AC-OPS-06": { owner: "pnpm:licenses", kind: "command" },
    "AC-OPS-07": {
      owner: "test/learning/ops/data-dir-boundary.test.ts",
      kind: "test",
    },
    "AC-OPS-08": { owner: "test/learning/ops/logs.test.ts", kind: "test" },
    "AC-OPS-09": {
      owner: "test/learning/ops/storage-usage.test.ts",
      kind: "test",
    },
    "AC-PRJ-01": {
      owner: "test/learning/projects/import-local.test.ts",
      kind: "test",
    },
    "AC-PRJ-02": {
      owner: "test/learning/projects/import-validation.test.ts",
      kind: "test",
    },
    "AC-PRJ-03": {
      owner: "test/learning/projects/local-path-boundary.test.ts",
      kind: "test",
    },
    "AC-PRJ-04": {
      owner: "test/learning/projects/import-github.test.ts",
      kind: "test",
    },
    "AC-PRJ-05": {
      owner: "test/learning/projects/import-github-private.test.ts",
      kind: "test",
    },
    "AC-PRJ-06": {
      owner: "test/learning/projects/local-unpushed.test.ts",
      kind: "test",
    },
    "AC-PRJ-07": {
      owner: "test/learning/projects/no-user-repo-writes.test.ts",
      kind: "test",
    },
    "AC-PRJ-08": {
      owner: "test/learning/projects/ref-resolution.test.ts",
      kind: "test",
    },
    "AC-PRJ-09": {
      owner: "test/learning/projects/scope-defaults.test.ts",
      kind: "test",
    },
    "AC-PRJ-10": {
      owner: "test/learning/projects/scope-config.test.ts",
      kind: "test",
    },
    "AC-PRJ-11": {
      owner: "test/learning/projects/submodule-lfs.test.ts",
      kind: "test",
    },
    "AC-PRJ-12": {
      owner: "test/learning/projects/snapshot-immutability.test.ts",
      kind: "test",
    },
    "AC-PRJ-13": {
      owner: "test/learning/projects/local-manual-compare.test.ts",
      kind: "test",
    },
    "AC-PRJ-14": {
      owner: "test/learning/projects/removal-dependents.test.ts",
      kind: "test",
    },
    "AC-PRJ-15": {
      owner: "test/learning/projects/import-failures.test.ts",
      kind: "test",
    },
    "AC-PRJ-16": {
      owner: "test/learning/projects/coverage-declaration.test.ts",
      kind: "test",
    },
    "AC-PRJ-17": {
      owner: "test/learning/projects/language-coverage.test.ts",
      kind: "test",
    },
    "AC-QA-01": {
      owner: "test/learning/qa/conversation-binding.test.ts",
      kind: "test",
    },
    "AC-QA-02": {
      owner: "test/learning/qa/selection-ownership.test.ts",
      kind: "test",
    },
    "AC-QA-03": {
      owner: "test/learning/qa/streaming-answer.test.ts",
      kind: "test",
    },
    "AC-QA-04": {
      owner: "test/learning/qa/refresh-restore.test.ts",
      kind: "test",
    },
    "AC-QA-05": {
      owner: "test/learning/qa/selection-switch.test.ts",
      kind: "test",
    },
    "AC-QA-06": {
      owner: "test/learning/qa/context-budget.test.ts",
      kind: "test",
    },
    "AC-QA-07": {
      owner: "test/learning/qa/tool-registry.test.ts",
      kind: "test",
    },
    "AC-QA-08": {
      owner: "test/learning/qa/no-writes-to-generation.test.ts",
      kind: "test",
    },
    "AC-QA-09": {
      owner: "test/learning/qa/two-generation-compare.test.ts",
      kind: "test",
    },
    "AC-QA-10": {
      owner: "test/learning/qa/answer-check-status.test.ts",
      kind: "test",
    },
    "AC-QA-11": {
      owner: "test/learning/qa/budget-exhausted.test.ts",
      kind: "test",
    },
    "AC-QA-12": {
      owner: "test/learning/qa/version-pinned-during-turn.test.ts",
      kind: "test",
    },
    "AC-QA-13": {
      owner: "test/learning/qa/prompt-injection.test.ts",
      kind: "test",
    },
    "AC-QA-14": {
      owner: "test/learning/qa/uncited-unknown.test.ts",
      kind: "test",
    },
    "AC-QA-15": {
      owner: "test/learning/qa/cancel-and-restart.test.ts",
      kind: "test",
    },
    "AC-R01-01": {
      owner: "test/learning/regression/r01-lastmile-snapshot-approve.test.ts",
      kind: "test",
    },
    "AC-R01-02": {
      owner: "test/learning/regression/r01-no-invented-decision.test.ts",
      kind: "test",
    },
    "AC-R02-01": {
      owner: "test/learning/regression/r02-numbering-vs-existence.test.ts",
      kind: "test",
    },
    "AC-R03-01": {
      owner: "test/learning/regression/r03-pr-callsite-removal.test.ts",
      kind: "test",
    },
    "AC-R03-02": {
      owner: "test/learning/regression/r03-renamed-module.test.ts",
      kind: "test",
    },
    "AC-R04-01": {
      owner: "test/learning/regression/r04-duplicate-and-squash.test.ts",
      kind: "test",
    },
    "AC-R04-02": {
      owner: "test/learning/regression/r04-resume-after-interrupt.test.ts",
      kind: "test",
    },
    "AC-R05-01": {
      owner: "test/learning/regression/r05-version-switch.test.ts",
      kind: "test",
    },
    "AC-R06-01": {
      owner: "test/learning/regression/r06-chinese-identifier.test.ts",
      kind: "test",
    },
    "AC-R07-01": {
      owner: "test/learning/regression/r07-planned-vs-implemented.test.ts",
      kind: "test",
    },
    "AC-R08-01": {
      owner: "test/learning/regression/r08-injection-not-executed.test.ts",
      kind: "test",
    },
    "AC-R09-01": {
      owner: "test/learning/regression/r09-local-unpushed.test.ts",
      kind: "test",
    },
    "AC-R10-01": {
      owner: "test/learning/regression/r10-init-update-no-writes.test.ts",
      kind: "test",
    },
    "AC-R10-02": {
      owner: "test/learning/regression/r10-baseline-fallback.test.ts",
      kind: "test",
    },
    "AC-R11-01": {
      owner: "test/learning/regression/r11-pagination-no-silent-loss.test.ts",
      kind: "test",
    },
    "AC-R11-02": {
      owner: "test/learning/regression/r11-base-change-recheck.test.ts",
      kind: "test",
    },
    "AC-R12-01": {
      owner: "test/learning/regression/r12-discovery-advanced-failure.test.ts",
      kind: "test",
    },
    "AC-R12-02": {
      owner: "test/learning/regression/r12-process-exit.test.ts",
      kind: "test",
    },
    "AC-R13-01": {
      owner: "test/learning/regression/r13-crash-seal-tx.test.ts",
      kind: "test",
    },
    "AC-R14-01": {
      owner: "test/learning/regression/r14-cancel-and-budget.test.ts",
      kind: "test",
    },
    "AC-R14-02": {
      owner: "test/learning/regression/r14-rate-limit-and-credentials.test.ts",
      kind: "test",
    },
    "AC-R15-01": {
      owner: "test/learning/regression/r15-sourceref-validation.test.ts",
      kind: "test",
    },
    "AC-R15-02": {
      owner: "test/learning/regression/r15-out-of-scope-blocks-publish.test.ts",
      kind: "test",
    },
    "AC-R16-01": {
      owner: "test/learning/regression/r16-two-versions-same-lines.test.ts",
      kind: "test",
    },
    "AC-R16-02": {
      owner: "test/learning/regression/r16-switch-and-removed-source.test.ts",
      kind: "test",
    },
    "AC-R17-01": {
      owner: "test/learning/regression/r17-lesson-layers.test.ts",
      kind: "test",
    },
    "AC-R17-02": {
      owner: "test/learning/regression/r17-rationale-and-prefs.test.ts",
      kind: "test",
    },
    "AC-RET-01": {
      owner: "test/learning/retrieval/term-aliases.test.ts",
      kind: "test",
    },
    "AC-RET-02": {
      owner: "test/learning/retrieval/expand-preserves-symbols.test.ts",
      kind: "test",
    },
    "AC-RET-03": {
      owner: "test/learning/retrieval/chinese-question-recall.test.ts",
      kind: "test",
    },
    "AC-RET-04": {
      owner: "test/learning/retrieval/source-search-fallback.test.ts",
      kind: "test",
    },
    "AC-RET-05": {
      owner: "test/learning/retrieval/version-isolation.test.ts",
      kind: "test",
    },
    "AC-RET-06": {
      owner: "test/learning/retrieval/external-source-ref.test.ts",
      kind: "test",
    },
    "AC-RET-07": {
      owner: "test/learning/retrieval/external-ssrf.test.ts",
      kind: "test",
    },
    "AC-RET-08": {
      owner: "test/learning/retrieval/external-missing.test.ts",
      kind: "test",
    },
    "AC-RET-09": {
      owner: "test/learning/retrieval/embeddings-unused.test.ts",
      kind: "test",
    },
    "AC-SCOPE-01": {
      owner: "test/learning/api/route-allowlist.test.ts",
      kind: "test",
    },
    "AC-SCOPE-02": { owner: "scripts/scan-copy.mjs", kind: "command" },
    "AC-SCOPE-03": { owner: "scripts/scan-code.mjs", kind: "command" },
    "AC-SEC-01": {
      owner: "test/learning/security/loopback-bind.test.ts",
      kind: "test",
    },
    "AC-SEC-02": {
      owner: "test/learning/security/host-check.test.ts",
      kind: "test",
    },
    "AC-SEC-03": {
      owner: "test/learning/security/origin-check.test.ts",
      kind: "test",
    },
    "AC-SEC-04": {
      owner: "test/learning/security/session-token.test.ts",
      kind: "test",
    },
    "AC-SEC-05": { owner: "test/learning/security/csp.test.ts", kind: "test" },
    "AC-SEC-06": {
      owner: "test/learning/security/markdown-sanitize.test.ts",
      kind: "test",
    },
    "AC-SEC-07": {
      owner: "test/learning/regression/r08-injection-not-executed.test.ts",
      kind: "test",
    },
    "AC-SEC-08": {
      owner: "test/learning/security/telemetry-off.test.ts",
      kind: "test",
    },
    "AC-SEC-09": {
      owner: "test/learning/projects/import-github-private.test.ts",
      kind: "test",
    },
    "AC-SEC-10": { owner: "test/learning/security/ssrf.test.ts", kind: "test" },
    "AC-SEC-11": {
      owner: "test/learning/security/path-sandbox.test.ts",
      kind: "test",
    },
    "AC-SEC-12": {
      owner: "test/learning/security/prompt-injection-boundary.test.ts",
      kind: "test",
    },
    "AC-UI-01": {
      owner: "test/learning/ui/projects-page.test.ts",
      kind: "test",
    },
    "AC-UI-02": {
      owner: "test/learning/ui/reader-layout.test.ts",
      kind: "test",
    },
    "AC-UI-03": {
      owner: "test/learning/ui/lesson-blocks.test.ts",
      kind: "test",
    },
    "AC-UI-04": { owner: "test/learning/ui/diagram.test.ts", kind: "test" },
    "AC-UI-05": {
      owner: "test/learning/ui/coverage-panel.test.ts",
      kind: "test",
    },
    "AC-UI-06": { owner: "test/learning/ui/inbox.test.ts", kind: "test" },
    "AC-UI-07": { owner: "test/learning/ui/terms-page.test.ts", kind: "test" },
    "AC-UI-08": { owner: "test/learning/ui/preferences.test.ts", kind: "test" },
    "AC-UI-09": { owner: "test/learning/ui/model-scope.test.ts", kind: "test" },
    "AC-UI-10": { owner: "test/learning/ui/usage-page.test.ts", kind: "test" },
    "AC-UI-11": {
      owner: "test/learning/ui/watch-controls.test.ts",
      kind: "test",
    },
    "AC-UPD-01": {
      owner: "test/learning/updates/watch-toggle.test.ts",
      kind: "test",
    },
    "AC-UPD-02": {
      owner: "test/learning/updates/baseline-no-replay.test.ts",
      kind: "test",
    },
    "AC-UPD-03": {
      owner: "test/learning/updates/poll-interval.test.ts",
      kind: "test",
    },
    "AC-UPD-04": {
      owner: "test/learning/updates/catchup-from-cursor.test.ts",
      kind: "test",
    },
    "AC-UPD-05": {
      owner: "test/learning/updates/first-parent.test.ts",
      kind: "test",
    },
    "AC-UPD-06": {
      owner: "test/learning/updates/multiple-nodes.test.ts",
      kind: "test",
    },
    "AC-UPD-07": {
      owner: "test/learning/updates/pr-pagination.test.ts",
      kind: "test",
    },
    "AC-UPD-08": {
      owner: "test/learning/updates/pr-overlap-dedupe.test.ts",
      kind: "test",
    },
    "AC-UPD-09": {
      owner: "test/learning/updates/pr-metadata-only.test.ts",
      kind: "test",
    },
    "AC-UPD-10": {
      owner: "test/learning/updates/pr-base-change.test.ts",
      kind: "test",
    },
    "AC-UPD-11": {
      owner: "test/learning/updates/pr-diff-direction.test.ts",
      kind: "test",
    },
    "AC-UPD-12": {
      owner: "test/learning/updates/merge-association.test.ts",
      kind: "test",
    },
    "AC-UPD-13": {
      owner: "test/learning/updates/squash-ambiguity.test.ts",
      kind: "test",
    },
    "AC-UPD-14": {
      owner: "test/learning/updates/history-gap.test.ts",
      kind: "test",
    },
    "AC-UPD-15": {
      owner: "test/learning/updates/branch-rename.test.ts",
      kind: "test",
    },
    "AC-UPD-16": {
      owner: "test/learning/updates/stream-failure-waiting.test.ts",
      kind: "test",
    },
    "AC-UPD-17": {
      owner: "test/learning/updates/discovery-transaction.test.ts",
      kind: "test",
    },
    "AC-UPD-18": {
      owner: "test/learning/updates/crash-after-discovery.test.ts",
      kind: "test",
    },
    "AC-UPD-19": {
      owner: "test/learning/updates/retry-scope.test.ts",
      kind: "test",
    },
    "AC-UPD-20": {
      owner: "test/learning/updates/cancel-change-job.test.ts",
      kind: "test",
    },
    "AC-UPD-21": {
      owner: "test/learning/updates/object-unavailable.test.ts",
      kind: "test",
    },
    "AC-UPD-22": {
      owner: "test/learning/updates/local-diff-computation.test.ts",
      kind: "test",
    },
    "AC-UPD-23": {
      owner: "test/learning/updates/short-record.test.ts",
      kind: "test",
    },
    "AC-UPD-24": {
      owner: "test/learning/updates/config-change-full.test.ts",
      kind: "test",
    },
    "AC-UPD-25": {
      owner: "test/learning/updates/no-github-writes.test.ts",
      kind: "test",
    },
    "AC-UPD-26": { owner: "scripts/scan-copy.mjs", kind: "command" },
    "AC-UPD-27": {
      owner: "test/learning/updates/change-record-fields.test.ts",
      kind: "test",
    },
  });
