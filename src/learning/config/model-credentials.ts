import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LearningError } from "../contracts/index.js";
import type { DataPaths } from "../contracts/index.js";
import { assertInsideDataDir } from "./paths.js";

/** Credentials stay outside the database, generated content and backup allowlist. */
export function loadModelKey(
  paths: DataPaths,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const file = assertInsideDataDir(
    paths,
    path.join(paths.root, "model-credentials.json"),
  );
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      anthropicApiKey?: unknown;
    };
    if (
      typeof stored.anthropicApiKey === "string" &&
      stored.anthropicApiKey.trim()
    )
      return stored.anthropicApiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LearningError(
        "internal_error",
        "模型凭据无法读取，请重新保存 API Key",
      );
    }
  }
  return (
    env.CODETRAIL_ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    undefined
  );
}

export function saveModelKey(paths: DataPaths, key: string): void {
  const file = assertInsideDataDir(
    paths,
    path.join(paths.root, "model-credentials.json"),
  );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ anthropicApiKey: key.trim() }),
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
