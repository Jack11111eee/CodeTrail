import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Upstream import boundary (architecture §2.1, AC-ARCH-01).
 *
 * Nothing outside `src/learning/upstream/**` may import the pinned upstream
 * modules. The adapter is the single coupling point; a stray import elsewhere
 * would let fork internals leak into the domain and break the isolation the
 * whole design rests on.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = path.join(REPO_ROOT, "src");
const LEARNING_SRC = path.join(SRC, "learning");
const UPSTREAM_ADAPTER = path.join(LEARNING_SRC, "upstream");

/** Upstream areas that only the adapter may touch. */
const FORBIDDEN_AREAS = [
  "agent",
  "generation",
  "retrieval",
  "claims",
  "visualize",
  "mermaid",
];

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(full));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relativeToRepo(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function forbiddenArea(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  for (const area of FORBIDDEN_AREAS) {
    const areaRoot = path.join(SRC, area);
    const relative = path.relative(areaRoot, resolved);
    if (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    ) {
      return area;
    }
    if (resolved === areaRoot) return area;
  }
  return null;
}

/** Returns one message per upstream import outside the adapter. */
export function scanSource(filePath: string, source: string): string[] {
  if (path.relative(UPSTREAM_ADAPTER, filePath).startsWith("..") === false) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: string[] = [];
  const report = (node: ts.Node, specifier: string): void => {
    const area = forbiddenArea(specifier, filePath);
    if (area === null) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    violations.push(
      `${relativeToRepo(filePath)}:${line + 1}: imports upstream "${area}" via ${specifier}`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier))
        report(node, specifier.text);
    } else if (ts.isImportTypeNode(node)) {
      if (
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        report(node, node.argument.literal.text);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument))
          report(node, argument.text);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        report(node, node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe("upstream import boundary", () => {
  it("has no upstream imports outside src/learning/upstream", () => {
    const violations = walkTypeScriptFiles(LEARNING_SRC).flatMap((file) =>
      scanSource(file, fs.readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("flags every forbidden import form outside the adapter", () => {
    const importer = path.join(LEARNING_SRC, "store", "leaky.ts");
    const cases = [
      'import { run } from "../../agent/run.js";',
      'export { x } from "../../generation/index.js";',
      'const m = await import("../../retrieval/search.js");',
      'const c = require("../../claims/registry.js");',
      'type V = import("../../visualize/client.js").View;',
      'import { m } from "../../mermaid/render.js";',
    ];
    for (const source of cases) {
      expect(scanSource(importer, source), source).not.toEqual([]);
    }
  });

  it("permits the adapter and unrelated imports", () => {
    const adapter = path.join(UPSTREAM_ADAPTER, "generation.ts");
    expect(
      scanSource(adapter, 'import { run } from "../../agent/run.js";'),
    ).toEqual([]);
    const contracts = path.join(LEARNING_SRC, "contracts", "ids.ts");
    expect(scanSource(contracts, 'import fs from "node:fs";')).toEqual([]);
    expect(
      scanSource(contracts, 'import type { X } from "./refs.js";'),
    ).toEqual([]);
    expect(
      scanSource(contracts, 'import { y } from "../store/db.js";'),
    ).toEqual([]);
  });
});
