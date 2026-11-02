import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * DOM boundary (architecture §18.2, AC-ARCH-02).
 *
 * Only `src/learning/ui/client.ts` and `src/learning/ui/client/**` may touch
 * `document`, `window` or `localStorage`. Everything else is type-checked
 * against the server lib, so DOM code outside the client would only fail at
 * runtime — this scan makes the mistake a test failure instead.
 *
 * The scan works on the syntax tree, not on raw text, so a comment that
 * mentions "document." is not a false positive.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LEARNING_SRC = path.join(REPO_ROOT, "src/learning");
const CLIENT_ENTRY = path.join(LEARNING_SRC, "ui/client.ts");
const CLIENT_DIR = path.join(LEARNING_SRC, "ui/client");

const DOM_GLOBALS = new Set(["document", "window", "localStorage"]);

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

function isAllowed(filePath: string): boolean {
  if (filePath === CLIENT_ENTRY) return true;
  const relative = path.relative(CLIENT_DIR, filePath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function relativeToRepo(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Returns one message per DOM global used outside the client allowlist. */
export function scanSource(filePath: string, source: string): string[] {
  if (isAllowed(filePath)) return [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: string[] = [];
  const report = (node: ts.Node, name: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    violations.push(
      `${relativeToRepo(filePath)}:${line + 1}: uses DOM global "${name}"`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        DOM_GLOBALS.has(node.expression.text)
      ) {
        report(node, node.expression.text);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "globalThis" &&
        DOM_GLOBALS.has(node.expression.name.text)
      ) {
        report(node, node.expression.name.text);
      }
    } else if (ts.isIdentifier(node) && node.text === "localStorage") {
      report(node, "localStorage");
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe("DOM boundary", () => {
  it("keeps document/window/localStorage out of the server tree", () => {
    const violations = walkTypeScriptFiles(LEARNING_SRC)
      .filter((file) => !isAllowed(file))
      .flatMap((file) => scanSource(file, fs.readFileSync(file, "utf8")));
    expect(violations).toEqual([]);
  });

  it("flags document, window and localStorage outside the allowlist", () => {
    const importer = path.join(LEARNING_SRC, "ui", "render", "leaky.ts");
    expect(
      scanSource(importer, "export const el = document.body;"),
    ).not.toEqual([]);
    expect(
      scanSource(importer, "export const w = window.innerWidth;"),
    ).not.toEqual([]);
    expect(
      scanSource(importer, "export const s = localStorage.getItem('x');"),
    ).not.toEqual([]);
    expect(
      scanSource(importer, "export const el = globalThis.document.body;"),
    ).not.toEqual([]);
  });

  it("permits the client entry and the client directory", () => {
    expect(
      scanSource(CLIENT_ENTRY, "export const el = document.body;"),
    ).toEqual([]);
    expect(
      scanSource(
        path.join(CLIENT_DIR, "render.ts"),
        "export const el = document.body;\nexport const w = window.innerWidth;",
      ),
    ).toEqual([]);
  });

  it("ignores comments and strings that merely mention the names", () => {
    const file = path.join(LEARNING_SRC, "contracts", "sources.ts");
    expect(
      scanSource(
        file,
        "/** Heading inside the document. */\nexport const note = 'window.';",
      ),
    ).toEqual([]);
  });
});
