/** Durable stage boundaries. Model conversations are deliberately not persisted. */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { BuildLessonsResult, SourceRow } from "../../contracts/index.js";

export interface GenerationCheckpoint {
  version: 1;
  identity: string;
  commitSha: string;
  baselineFromGenerationId: string | null;
  fallbackReason: string | null;
  documents?: Record<string, string>;
  lessons?: { result: BuildLessonsResult; sources: SourceRow[] };
}

export async function readCheckpoint(
  directory: string,
): Promise<GenerationCheckpoint | null> {
  try {
    const value = JSON.parse(
      await readFile(path.join(directory, "checkpoint.json"), "utf8"),
    ) as GenerationCheckpoint;
    if (
      value.version !== 1 ||
      typeof value.identity !== "string" ||
      typeof value.commitSha !== "string"
    )
      throw new Error(
        "分析断点格式无效；现有文件已保留，请检查 checkpoint.json",
      );
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCheckpoint(
  directory: string,
  checkpoint: GenerationCheckpoint,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.checkpoint-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path.join(directory, "checkpoint.json"));
}

/** File hashes prove a completed module still contains the bytes we accepted. */
export async function documentHashes(
  directory: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".run.json") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`分析断点不能包含符号链接：${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile())
        hashes[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
    }
  }
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("文档断点路径必须是目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  await walk(directory, "");
  return Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)),
  );
}
