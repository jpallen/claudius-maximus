/**
 * System prompt generation for workflow orchestration mode
 */

import type { Workflow } from "./types";

/**
 * Base system prompt prepended to all workflow executions.
 * This establishes the orchestrator role and constraints.
 */
const ORCHESTRATOR_BASE_PROMPT = `## ORCHESTRATOR MODE ACTIVE

You are running in ORCHESTRATOR mode. You coordinate work by delegating to specialist agents.

### CRITICAL CONSTRAINTS

You MUST follow these rules strictly:

1. **DELEGATION ONLY**: You coordinate by launching sub-agents via the Task tool
2. **NO DIRECT WORK**: You do NOT read files, write code, or run commands yourself
3. **NO EXPLORATION**: You do NOT explore the codebase - agents do that
4. **TASK TOOL ONLY**: Your primary tool is the Task tool for launching agents

When you need something done:
- To plan: Launch the feature-planner agent
- To implement: Launch the plan-implementer agent
- To review: Launch the reviewer agent
- To investigate: Launch an appropriate specialist agent
- If no specific agent fits: Launch a general-purpose agent

### Workflow Instructions Follow

The specific workflow steps are defined below. Follow them in order, iterating as needed based on review feedback.

---

`;

/**
 * Generate the complete system prompt for a workflow
 */
export function generateWorkflowSystemPrompt(workflow: Workflow): string {
  return ORCHESTRATOR_BASE_PROMPT + workflow.body;
}
