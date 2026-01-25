/**
 * TypeScript interfaces for workflow configuration and execution
 */

/** Model types */
export type Model = "opus" | "sonnet" | "haiku";

/** A single step in a workflow */
export interface WorkflowStep {
  /** Step name (used for identification and logging) */
  name: string;
  /** Model to use for this step */
  model?: Model;
  /** Agent to use (path to agent in .claude/agents/, passed via --agent flag) */
  agent?: string;
  /** Prompt to send to Claude */
  prompt?: string;
  /** Timeout in milliseconds (no timeout if not specified) */
  timeout?: number;
}

/** A complete workflow definition */
export interface Workflow {
  /** Orchestrator prompt - instructions for Claude on how to orchestrate the workflow */
  prompt: string;
  /** Model to use for the orchestrator (default: opus) */
  model?: Model;
  /** Available steps that the orchestrator can invoke */
  steps: WorkflowStep[];
}

/** Default settings that apply to all workflows */
export interface WorkflowDefaults {
  /** Default timeout for all steps in milliseconds */
  timeout?: number;
}

/** Root configuration from cm.yml */
export interface CmConfig {
  /** Config schema version */
  version: string;
  /** Default settings for all workflows */
  defaults?: WorkflowDefaults;
  /** Named workflows */
  workflows: Record<string, Workflow>;
}

/** Raw YAML structure for a step (before validation) */
export interface RawWorkflowStep {
  name?: string;
  model?: string;
  agent?: string;
  prompt?: string;
  timeout?: number;
}

/** Raw YAML structure for a workflow (before validation) */
export interface RawWorkflow {
  prompt?: string;
  model?: string;
  steps?: RawWorkflowStep[];
}

/** Raw YAML structure for the config (before validation) */
export interface RawCmConfig {
  version?: string;
  defaults?: {
    timeout?: number;
  };
  workflows?: Record<string, RawWorkflow>;
}
