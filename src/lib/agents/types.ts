/**
 * Agent types
 */

/** An agent configuration from .claude/agents/ */
export interface Agent {
  name: string;
  path: string;
}

/** Summary for listing agents */
export interface AgentSummary {
  name: string;
  path: string;
}
