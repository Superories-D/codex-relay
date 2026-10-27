// Native thread/goal/set rejects objectives longer than this limit.
export const GOAL_OBJECTIVE_MAX_LENGTH = 4000;

// A usage stop can mask a budget stop. Missing accounting is not evidence of
// permission to resume; an explicit null budget is the unlimited case.
export function goalBudgetState(goal: {
  tokenBudget?: number | null;
  tokensUsed?: number;
}): "available" | "limited" | "unknown" {
  if (goal.tokenBudget === null) return "available";
  if (typeof goal.tokenBudget !== "number" || !Number.isFinite(goal.tokenBudget) ||
      goal.tokenBudget < 0 || typeof goal.tokensUsed !== "number" ||
      !Number.isFinite(goal.tokensUsed) || goal.tokensUsed < 0) return "unknown";
  return goal.tokensUsed >= goal.tokenBudget ? "limited" : "available";
}
