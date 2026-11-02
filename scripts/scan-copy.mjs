#!/usr/bin/env node
/**
 * Copy and structure scanner (PRD §15.1, AC-LES-14/AC-UPD-26/AC-OPS-05/AC-SCOPE-02).
 *
 *   node scripts/scan-copy.mjs [--root <dir>] \
 *     [--forbid <csv>] [--forbid-in-schema <csv>] \
 *     [--require <csv>] [--require-headings <csv>]
 *
 * `--forbid` rejects literal phrases anywhere in the copy surface (README,
 * `docs/`, UI templates and lesson samples). `--forbid-in-schema` rejects
 * identifiers in the schema/response-model surface (everything under
 * `src/learning/**` except the UI and the test-only helpers).
 * `--require` demands that each phrase appears at least once in the copy
 * surface. `--require-headings` demands that each Markdown heading exists and
 * that its section contains a fenced command block.
 *
 * Every hit prints `path:line: message` relative to the scan root and the
 * process exits 1. A clean scan exits 0. Usage errors exit 2.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE = `usage: node scripts/scan-copy.mjs [--root <dir>] [--forbid <csv>]
       [--forbid-in-schema <csv>] [--require <csv>] [--require-headings <csv>]
`;

/** Where user-visible copy lives: docs, UI templates and lesson samples. */
const COPY_ROOTS = [
  "README.md",
  "docs",
  "src/learning/ui",
  "src/learning/lessons",
  "skills",
];

/** Where schema and response-model identifiers live. */
const SCHEMA_ROOTS = ["src/learning"];
const SCHEMA_EXCLUDES = ["src/learning/ui", "src/learning/testing"];

const COPY_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".json",
]);

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".artifacts",
  ".fixtures",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
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

function walk(root, start, onFile) {
  const absolute = path.isAbsolute(start) ? start : path.join(root, start);
  if (!isInside(root, absolute)) return;
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
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(root, path.join(absolute, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(path.join(absolute, entry.name));
    }
  }
}

function readText(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return null;
  }
  // A NUL byte means binary: never scan a blob as copy.
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function copyFiles(root) {
  const files = [];
  for (const entry of COPY_ROOTS) {
    walk(root, entry, (file) => {
      if (COPY_EXTENSIONS.has(path.extname(file).toLowerCase()))
        files.push(file);
    });
  }
  return [...new Set(files)].sort();
}

function schemaFiles(root) {
  const files = [];
  for (const entry of SCHEMA_ROOTS) {
    walk(root, entry, (file) => {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;
      if (
        SCHEMA_EXCLUDES.some((excluded) =>
          isInside(path.join(root, excluded), file),
        )
      ) {
        return;
      }
      files.push(file);
    });
  }
  return [...new Set(files)].sort();
}

function lines(text) {
  return text.split(/\r?\n/u);
}

function literalHits(files, phrases, kind) {
  const violations = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    lines(text).forEach((line, index) => {
      for (const phrase of phrases) {
        if (line.includes(phrase)) {
          violations.push({
            file,
            line: index + 1,
            message: `${kind} copy "${phrase}"`,
          });
        }
      }
    });
  }
  return violations;
}

function requirePhrases(files, phrases) {
  const texts = files
    .map((file) => ({ file, text: readText(file) }))
    .filter((entry) => entry.text !== null);
  const violations = [];
  for (const phrase of phrases) {
    const found = texts.some((entry) => entry.text.includes(phrase));
    if (!found) {
      violations.push({
        file: null,
        line: null,
        message: `missing required copy "${phrase}"`,
      });
    }
  }
  return violations;
}

/** `## heading` lines in a Markdown document, with their section end. */
function markdownSections(text) {
  const all = lines(text);
  const sections = [];
  all.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!match) return;
    sections.push({
      line: index + 1,
      level: match[1].length,
      title: line.trim(),
      bodyStart: index + 1,
    });
  });
  sections.forEach((section, index) => {
    const next = sections
      .slice(index + 1)
      .find((candidate) => candidate.level <= section.level);
    section.bodyEnd = next ? next.line - 1 : all.length;
  });
  return { all, sections };
}

function hasCommandBlock(all, section) {
  let insideFence = false;
  let blockHasCommand = false;
  for (let index = section.bodyStart; index < section.bodyEnd; index += 1) {
    const line = all[index] ?? "";
    if (/^\s*(```|~~~)/u.test(line)) {
      if (insideFence && blockHasCommand) return true;
      insideFence = !insideFence;
      blockHasCommand = false;
      continue;
    }
    if (insideFence) {
      const trimmed = line.trim();
      if (
        trimmed !== "" &&
        (/^(?:\$ )?(?:pnpm|npm|npx|node|git|curl|codetrail|bash|sh)\b/u.test(
          trimmed,
        ) ||
          trimmed.startsWith("./"))
      ) {
        blockHasCommand = true;
      }
    }
  }
  return insideFence && blockHasCommand;
}

function requireHeadings(root, headings) {
  const files = copyFiles(root).filter((file) => file.endsWith(".md"));
  const parsed = files
    .map((file) => {
      const text = readText(file);
      return text === null ? null : { file, ...markdownSections(text) };
    })
    .filter(Boolean);

  const violations = [];
  for (const heading of headings) {
    let matched = false;
    for (const document of parsed) {
      const section = document.sections.find(
        (candidate) => candidate.title === heading,
      );
      if (!section) continue;
      matched = true;
      if (!hasCommandBlock(document.all, section)) {
        violations.push({
          file: document.file,
          line: section.line,
          message: `heading "${heading}" has no executable command block`,
        });
      }
    }
    if (!matched) {
      violations.push({
        file: null,
        line: null,
        message: `missing required heading "${heading}"`,
      });
    }
  }
  return violations;
}

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    forbid: [],
    forbidInSchema: [],
    require: [],
    requireHeadings: [],
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
    } else if (arg === "--forbid") {
      options.forbid.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--forbid=")) {
      options.forbid.push(...splitList(arg.slice("--forbid=".length)));
    } else if (arg === "--forbid-in-schema") {
      options.forbidInSchema.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--forbid-in-schema=")) {
      options.forbidInSchema.push(
        ...splitList(arg.slice("--forbid-in-schema=".length)),
      );
    } else if (arg === "--require") {
      options.require.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--require=")) {
      options.require.push(...splitList(arg.slice("--require=".length)));
    } else if (arg === "--require-headings") {
      options.requireHeadings.push(...splitList(take(index, arg)));
      index += 1;
    } else if (arg.startsWith("--require-headings=")) {
      options.requireHeadings.push(
        ...splitList(arg.slice("--require-headings=".length)),
      );
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printViolations(root, violations) {
  for (const violation of violations) {
    if (violation.file) {
      process.stdout.write(
        `${toPosix(path.relative(root, violation.file))}:${violation.line}: ${violation.message}\n`,
      );
    } else {
      process.stdout.write(`${violation.message}\n`);
    }
  }
}

export function scanCopy(options) {
  const root = options.root ?? REPO_ROOT;
  const violations = [];
  if (options.forbid?.length) {
    violations.push(
      ...literalHits(copyFiles(root), options.forbid, "forbidden"),
    );
  }
  if (options.forbidInSchema?.length) {
    violations.push(
      ...literalHits(
        schemaFiles(root),
        options.forbidInSchema,
        "forbidden schema identifier",
      ),
    );
  }
  if (options.require?.length) {
    violations.push(...requirePhrases(copyFiles(root), options.require));
  }
  if (options.requireHeadings?.length) {
    violations.push(...requireHeadings(root, options.requireHeadings));
  }
  return { root, violations };
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
  const { root, violations } = scanCopy(options);
  printViolations(root, violations);
  return violations.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
