import type { UserQuestion } from "./types";

export function questionList(params: unknown): UserQuestion[] {
  const questions = (params as { questions?: unknown })?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3)
    return [];
  if (
    questions.some(
      (q) =>
        !q ||
        typeof q.id !== "string" ||
        typeof q.header !== "string" ||
        typeof q.question !== "string" ||
        !q.id ||
        (q.options != null &&
          (!Array.isArray(q.options) ||
            q.options.some(
              (o: any) =>
                typeof o?.label !== "string" ||
                typeof o?.description !== "string",
            ))),
    )
  )
    return [];
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return [];
  return questions;
}

export function validateQuestionAnswers(params: unknown, value: unknown) {
  const questions = questionList(params),
    answers = (value as any)?.answers;
  if (!questions.length) throw Error("当前问题格式不受支持，请停止本轮后检查");
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    Object.keys(answers).length !== questions.length
  )
    throw Error("请回答全部问题后再提交");
  for (const q of questions) {
    if (!Object.hasOwn(answers, q.id)) throw Error("请回答全部问题后再提交");
    const values = answers[q.id]?.answers;
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 20 ||
      values.some(
        (v: unknown) => typeof v !== "string" || !v.trim() || v.length > 10000,
      )
    )
      throw Error("请填写有效的回答，每项最多 10000 个字符");
    if (
      q.options?.length &&
      !q.isOther &&
      !q.options.some((o) => o.label === values[0])
    )
      throw Error("请从提供的选项中选择回答");
  }
  return answers as Record<string, { answers: string[] }>;
}
