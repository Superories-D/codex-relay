import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Chats } from "../src/core/chat";
import {
  questionList,
  validateQuestionAnswers,
} from "../src/shared/user-questions";
import type { Approval } from "../src/shared/types";
const questions = [
  {
    id: "choice",
    header: "Direction",
    question: "Which direction?",
    isOther: true,
    isSecret: false,
    options: [
      { label: "Small", description: "Fast" },
      { label: "Large", description: "Thorough" },
    ],
  },
  {
    id: "private",
    header: "Private",
    question: "Private answer?",
    isOther: false,
    isSecret: true,
    options: null,
  },
];
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-questions-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("requires one complete response per requested question, preserving options and explicit custom answers", () => {
  expect(questionList({ questions })).toHaveLength(2);
  expect(questionList({ questions: [questions[0], questions[0]] })).toEqual([]);
  expect(() => validateQuestionAnswers({ questions }, { answers: {} })).toThrow(
    "全部问题",
  );
  const value = {
    answers: {
      choice: { answers: ["Custom direction", "Keep this note"] },
      private: { answers: ["synthetic-private"] },
    },
  };
  expect(validateQuestionAnswers({ questions }, value)).toEqual(value.answers);
  expect(() =>
    validateQuestionAnswers(
      { questions: [{ ...questions[0], isOther: false }, questions[1]] },
      value,
    ),
  ).toThrow("选项");
  expect(() =>
    validateQuestionAnswers(
      { questions },
      { answers: { ...value.answers, extra: { answers: ["no"] } } },
    ),
  ).toThrow("全部问题");
});
it("updates one durable question entry in order, excludes secret answers, and restores paginated history", async () => {
  const chats = new Chats(root);
  const approval: Approval = {
    id: "71",
    jobId: "job",
    historyId: "question:one",
    createdAt: 123,
    method: "item/tool/requestUserInput",
    kind: "input",
    params: {
      threadId: "child",
      turnId: "turn-1",
      isBlocking: true,
      questions,
    },
  };
  const first = chats.question(approval, "pending");
  const second = chats.question(approval, "answered", {
    choice: { answers: ["Small", "Use a readable interface"] },
    private: { answers: ["NEVER_PERSIST_THIS_SYNTHETIC_VALUE"] },
  });
  await Promise.all([first, second]);
  expect((await chats.questions("job")).items).toMatchObject([
    {
      status: "answered",
      threadId: "child",
      answers: { choice: { answers: ["Small", "Use a readable interface"] } },
    },
  ]);
  const text = await fs.readFile(chats.file("job"), "utf8");
  expect(text).not.toContain("NEVER_PERSIST_THIS_SYNTHETIC_VALUE");
  expect((await chats.questions("job")).items[0].answers).not.toHaveProperty(
    "private",
  );
  for (let index = 0; index < 21; index++)
    await chats.question(
      {
        ...approval,
        id: String(index),
        historyId: `question:next-${index}`,
        createdAt: 200 + index,
      },
      "expired",
    );
  const restored = new Chats(root),
    latest = await restored.questions("job");
  expect(latest.items).toHaveLength(20);
  expect(latest.total).toBe(22);
  const older = await restored.questions("job", latest.before);
  expect(older.items).toHaveLength(2);
  expect(older.items[0].status).toBe("answered");
});
