import { agentWorkflow } from "./agent-workflow.js";
import { searchWorkflow } from "./atlas-search-workflow.js";

// One maintained workflow for setup, local skill installs and MCP initialization.
export function atlasSkill(name = "atlas") {
  if (!["atlas", "atlas-board"].includes(name))
    throw new Error("Unsupported Atlas skill name");
  return `---
name: ${name}
description: Use by default at the start of substantial user-requested work to track tasks in Atlas, and whenever past conversations, decisions, prior attempts or handovers could inform the request. Includes adaptive multi-query search and shared task updates. Also use for explicit Atlas search or board requests. Skip task creation for trivial actions and skip historical search for self-contained questions.
---

# Atlas search and tasks

Use the connected Atlas MCP server. It supplies original session evidence and a shared task board; the calling assistant evaluates the evidence. Discover deferred tools when needed. If the connection is unavailable, explain the limitation briefly and continue work that does not depend on it. Do not invent successful board updates or search results.

## Default task tracking

${agentWorkflow}

## Adaptive historical search

${searchWorkflow}
`;
}

export function atlasDefaultRule(name = "atlas") {
  // Validate the name before embedding it in durable client instructions.
  atlasSkill(name);
  return `Use the ${name} skill by default at the start of substantial user-requested work to read and maintain the Atlas task board, and whenever past conversations or decisions could inform the request. Load the skill and follow its adaptive search workflow; do not stop at the first search result. Skip task creation for trivial actions and historical search for self-contained requests. If Atlas is unavailable, report that briefly and continue independent work. Respect the user's scope and existing access approvals.`;
}
