#!/usr/bin/env node
/**
 * Production-code pattern scanner (PRD §15.1, AC-SCOPE-03).
 *
 *   node scripts/scan-code.mjs [--root <dir>] [--forbid-patterns <csv regex>] \
 *     [--roots <csv>] [--exclude <csv>] [--include-tests] [--keep-comments]
 *
 * Each comma-separated entry in `--forbid-patterns` is a JavaScript regular
 * expression. Every match prints `path:line: ...` and the process exits 1; a
 * clean scan exits 0 and a usage error exits 2.
 *
 * Exclusions are explicit, never silent:
 *   - the default roots are `src` and `scripts` (production code);
 *   - the test tree is excluded by default, `--include-tests` opts back in;
 *   - comments (doc strings) are stripped before matching, `--keep-comments`
 *     opts back in;
 *   - `--exclude` adds path prefixes, e.g. the fake GitHub helper.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE = `usage: node scripts/scan-code.mjs [--root <dir>] [--forbid-patterns <csv regex>]
       [--roots <csv>] [--exclude <csv>] [--include-tests] [--keep-comments]
`;

const DEFAULT_ROOTS = ["src", "scripts"];
const DEFAULT_EXCLUDES = [
  ".artifacts",
  ".git",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "test",
];
const TEST_EXCLUDES = ["test"];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function splitList(value) {
  if (value === undefined || value === null) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function matchesExclude(root, file, excludes) {
  const relative = toPosix(path.relative(root, file));
  return excludes.some(
    (entry) =>
      relative === entry ||
      relative.startsWith(`${entry.replace(/\/$/u, "")}/`),
  );
}

function walk(root, start, excludes, onFile) {
  const absolute = path.isAbsolute(start) ? start : path.join(root, start);
  if (!isInside(root, absolute) || matchesExclude(root, absolute, excludes))
    return;
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return;
  }
  if (stat.isFile()) {
    onFile(absolute);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(root, path.join(absolute, entry.name), excludes, onFile);
    } else if (entry.isFile()) {
      const file = path.join(absolute, entry.name);
      if (!matchesExclude(root, file, excludes)) onFile(file);
    }
  }
}

/**
 * Blanks every comment while preserving byte offsets and line numbers, so a
 * regex match on the result maps to the original line. Strings and template
 * literals stay intact: a call written as `exec("...")` is still visible.
 */
export function stripComments(source, fileName) {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".ts")
      ? ts.ScriptKind.TS
      : fileName.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const ranges = [];
  const addRanges = (candidates) => {
    for (const range of candidates ?? []) {
      if (
        range.kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        range.kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        ranges.push([range.pos, range.end]);
      }
    }
  };

  const visit = (node) => {
    addRanges(ts.getLeadingCommentRanges(source, node.pos));
    addRanges(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);

  if (ranges.length === 0) return source;

  // Split into UTF-16 code units: TypeScript offsets are code-unit offsets.
  const characters = source.split("");
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  }
  return characters.join("");
}

function lineOf(source, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function lineText(source, offset) {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    roots: null,
    exclude: [],
    includeTests: false,
    keepComments: false,
    patterns: [],
    help: false,
  };
  const take = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = path.resolve(take(index, arg));
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--roots") {
      options.roots = splitList(take(index, arg));
      index += 1;
    } else if (arg.startsWith("--roots=")) {
      options.roots = splitList(arg.slice("--roots=".length));
    } else if (arg === "--exclude") {
      options.exclude.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--exclude=")) {
      options.exclude.push(...splitList(arg.slice("--exclude=".length)));
    } else if (arg === "--include-tests") {
      options.includeTests = true;
    } else if (arg === "--keep-comments") {
      options.keepComments = true;
    } else if (arg === "--forbid-patterns") {
      options.patterns.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--forbid-patterns=")) {
      options.patterns.push(
        ...splitList(arg.slice("--forbid-patterns=".length)),
      );
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function scanCode(options) {
  const root = options.root ?? REPO_ROOT;
  // `--include-tests` widens the default roots; an explicit `--roots` wins.
  const roots =
    options.roots ??
    (options.includeTests ? [...DEFAULT_ROOTS, "test"] : DEFAULT_ROOTS);
  const excludes = [...DEFAULT_EXCLUDES];
  if (options.includeTests) {
    for (const entry of TEST_EXCLUDES) {
      const index = excludes.indexOf(entry);
      if (index !== -1) excludes.splice(index, 1);
    }
  }
  excludes.push(...(options.exclude ?? []));

  const patterns = (options.patterns ?? []).map((source) => {
    try {
      return { source, regex: new RegExp(source, "gu") };
    } catch (error) {
      throw new Error(
        `invalid --forbid-patterns entry "${source}": ${error.message}`,
        {
          cause: error,
        },
      );
    }
  });

  const files = [];
  for (const entry of roots) {
    walk(root, entry, excludes, (file) => {
      if (SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
        files.push(file);
    });
  }

  const violations = [];
  for (const file of [...new Set(files)].sort()) {
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (source.includes("\u0000")) continue;
    const scanned = options.keepComments ? source : stripComments(source, file);
    for (const { source: pattern, regex } of patterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(scanned)) !== null) {
        violations.push({
          file,
          line: lineOf(scanned, match.index),
          message: `forbidden pattern /${pattern}/ matched: ${lineText(scanned, match.index)}`,
        });
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
  }

  return { root, violations };
}

function printViolations(root, violations) {
  for (const violation of violations) {
    process.stdout.write(
      `${toPosix(path.relative(root, violation.file))}:${violation.line}: ${violation.message}\n`,
    );
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.patterns.length === 0) {
    process.stderr.write(
      `scan-code: at least one --forbid-patterns entry is required\n${USAGE}`,
    );
    return 2;
  }
  let result;
  try {
    result = scanCode(options);
  } catch (error) {
    process.stderr.write(`scan-code: ${error.message}\n`);
    return 2;
  }
  printViolations(result.root, result.violations);
  return result.violations.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
