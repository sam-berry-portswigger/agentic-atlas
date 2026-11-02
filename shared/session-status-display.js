/**
 * A finished turn and the legacy input-needed state are ordinary idle activity.
 * Keep native states intact; neither means the user's work is complete.
 * @param {"running" | "needs_input" | "idle" | "done" | "error" | "unknown"} status
 */
export function displaySessionStatus(status) {
  return status === "needs_input" || status === "done" ? "idle" : status;
}

export const statusLabels = {
  running: "Running",
  idle: "Idle",
  done: "Turn complete",
  error: "Error",
  unknown: "Unverified",
};

export const statusColors = {
  running: "#629b7b",
  idle: "#a0aba5",
  done: "#8da78a",
  error: "#bd786c",
  unknown: "#b5b6bf",
};
