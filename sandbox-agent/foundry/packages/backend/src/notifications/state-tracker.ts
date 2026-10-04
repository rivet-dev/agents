export type CiState = "running" | "pass" | "fail" | "unknown";
export type ReviewState = "approved" | "changes_requested" | "pending" | "none" | "unknown";

export interface PrStateTransition {
  type: "ci_passed" | "ci_failed" | "pr_approved" | "changes_requested";
  branchName: string;
  prNumber: number;
  reviewer?: string;
}

export class PrStateTracker {
  private states: Map<string, { ci: CiState; review: ReviewState }>;

  constructor() {
    this.states = new Map();
  }

  update(repoId: string, branchName: string, prNumber: number, ci: CiState, review: ReviewState, reviewer?: string): PrStateTransition[] {
    const key = `${repoId}:${branchName}`;
    const prev = this.states.get(key);
    const transitions: PrStateTransition[] = [];

    if (prev) {
      // CI transitions: only fire when moving from "running" to a terminal state
      if (prev.ci === "running" && ci === "pass") {
        transitions.push({ type: "ci_passed", branchName, prNumber });
      } else if (prev.ci === "running" && ci === "fail") {
        transitions.push({ type: "ci_failed", branchName, prNumber });
      }

      // Review transitions: only fire when moving from "pending" to a terminal state
      if (prev.review === "pending" && review === "approved") {
        transitions.push({ type: "pr_approved", branchName, prNumber, reviewer });
      } else if (prev.review === "pending" && review === "changes_requested") {
        transitions.push({ type: "changes_requested", branchName, prNumber, reviewer });
      }
    }

    this.states.set(key, { ci, review });

    return transitions;
  }
}
