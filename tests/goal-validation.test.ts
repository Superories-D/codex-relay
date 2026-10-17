import { expect, it } from "vitest";
import { goalObjectiveSchema } from "../src/main/validation";
it("matches the observed native objective limit before creating or editing a Goal", () => {
  expect(goalObjectiveSchema.parse("x".repeat(4000))).toHaveLength(4000);
  expect(goalObjectiveSchema.safeParse("x".repeat(4001)).success).toBe(false);
  expect(goalObjectiveSchema.safeParse(" \n ").success).toBe(false);
  expect(goalObjectiveSchema.parse("  clear objective  ")).toBe(
    "clear objective",
  );
});
