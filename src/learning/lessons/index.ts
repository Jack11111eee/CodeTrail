/**
 * Lessons component barrel (architecture §3.18).
 *
 * Cross-component imports go through this file, never through a deep import
 * into `lessons/`. `diagram.ts` and `builder.ts` (issue-16) extend the surface.
 */

export * from "./schema.js";
export * from "./assemble.js";
