/**
 * Lessons component barrel (architecture §3.18).
 *
 * Cross-component imports go through this file, never through a deep import
 * into `lessons/`. `diagram.ts` and `builder.ts` (issue-16) extend the surface.
 */

export * from "./schema.js";
export * from "./assemble.js";
export * from "./diagram.js";
export * from "./export.js";
export * from "./builder.js";
export * from "./validate/structural.js";
export * from "./validate/evidence.js";
export * from "./validate/labels.js";
export * from "./validate/diagram.js";
export * from "./validate/semantic.js";
