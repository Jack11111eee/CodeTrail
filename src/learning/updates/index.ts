/**
 * `updates/` barrel (architecture §3.18).
 *
 * Cross-component imports go through this file. Contract types remain the
 * source of truth and are only re-exported here.
 */

export * from "./change-lesson.js";
export * from "./diff.js";
export * from "./discovery.js";
export * from "./github-client.js";
export * from "./linkage.js";
export * from "./watch.js";
