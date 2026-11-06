import type { LessonKind } from "../contracts/index.js";

/** Older generations stored a scenario ID in the title column. */
export function lessonTitle(
  title: string,
  kind: LessonKind,
  lesson?: { technicalExplanation: { terms: { zh: string }[] }[] } | null,
): string {
  if (title.trim() && !/^(?:sc|l|lesson)_[a-f0-9]+$/iu.test(title))
    return title;
  const label = {
    research: "项目讲解",
    change: "变更讲解",
    comparison: "版本对比",
  }[kind];
  const term = lesson?.technicalExplanation?.[0]?.terms?.[0]?.zh?.trim();
  return term ? `${label}：${term.slice(0, 40)}` : label;
}
