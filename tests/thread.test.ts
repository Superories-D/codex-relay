import { describe, expect, it, vi } from "vitest";
import { prepareThread } from "../src/core/thread";

describe("thread identity before task submission", () => {
  it.each([undefined, {}, { thread: { id: "another-thread" } }])(
    "rejects an unverified ordinary resume result: %j",
    async (response) => {
      const call = vi.fn(async () => response);
      await expect(
        prepareThread({ call } as any, "original", {}),
      ).rejects.toThrow("ID");
      expect(call).toHaveBeenCalledExactlyOnceWith("thread/resume", {
        threadId: "original",
      });
    },
  );
  it("checks the identity after materializing a new thread", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "created" } };
      if (method === "thread/resume") return { thread: { id: "different" } };
      return {};
    });
    await expect(prepareThread({ call } as any, undefined, {})).rejects.toThrow(
      "ID",
    );
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/archive",
      "thread/unarchive",
      "thread/resume",
    ]);
  });
  it.each([undefined, {}, { thread: { id: "" } }])(
    "stops before archive or resume if creation returns no usable identity: %j",
    async (response) => {
      const call = vi.fn(async () => response);
      await expect(
        prepareThread({ call } as any, undefined, {}),
      ).rejects.toThrow("ID");
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it("retains the configured workspace and model on a verified resume", async () => {
    const result = { thread: { id: "original" }, model: "model-1" };
    const call = vi.fn(async () => result);
    const config = { cwd: "/project", model: "model-1" };
    expect(await prepareThread({ call } as any, "original", config)).toBe(
      result,
    );
    expect(call).toHaveBeenCalledWith("thread/resume", {
      threadId: "original",
      ...config,
    });
  });
});
