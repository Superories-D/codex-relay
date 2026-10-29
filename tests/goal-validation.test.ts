import { expect, it } from "vitest";
import { goalObjectiveSchema } from "../src/main/validation";
import { goalBudgetState } from "../src/shared/goal";
it.each([
  [{},"unknown"], [{tokenBudget:undefined,tokensUsed:0},"unknown"],
  [{tokenBudget:NaN,tokensUsed:0},"unknown"], [{tokenBudget:100,tokensUsed:Infinity},"unknown"],
  [{tokenBudget:-1,tokensUsed:0},"unknown"], [{tokenBudget:100,tokensUsed:-1},"unknown"],
  [{tokenBudget:null},"available"], [{tokenBudget:100,tokensUsed:99},"available"],
  [{tokenBudget:0,tokensUsed:0},"limited"], [{tokenBudget:100,tokensUsed:101},"limited"],
] as const)("classifies native Goal accounting before automatic activation: %j",(goal,expected)=>{
  expect(goalBudgetState(goal)).toBe(expected);
});
it("matches the observed native objective limit before creating or editing a Goal", () => {
  expect(goalObjectiveSchema.parse("x".repeat(4000))).toHaveLength(4000);
  expect(goalObjectiveSchema.safeParse("x".repeat(4001)).success).toBe(false);
  expect(goalObjectiveSchema.safeParse(" \n ").success).toBe(false);
  expect(goalObjectiveSchema.parse("  clear objective  ")).toBe(
    "clear objective",
  );
});
