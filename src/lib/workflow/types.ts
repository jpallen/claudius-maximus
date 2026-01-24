/**
 * TypeScript interfaces for workflow configuration and execution
 */

/** Agent model types */
export type AgentModel = "opus" | "sonnet" | "haiku";

/** A single step in a workflow */
export interface WorkflowStep {
  /** Step name (used for identification and logging) */
  name: string;
  /** Agent model to use for this step */
  agent?: AgentModel;
  /** Prompt to send to the agent */
  prompt?: string;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
}

/** A complete workflow definition */
export interface Workflow {
  /** Workflow steps to execute in order */
  steps: WorkflowStep[];
}

/** Default settings that apply to all workflows */
export interface WorkflowDefaults {
  /** Default allowed tools for all steps */
  allowedTools?: string[];
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
  agent?: string;
  prompt?: string;
  timeout?: number;
}

/** Raw YAML structure for a workflow (before validation) */
export interface RawWorkflow {
  steps?: RawWorkflowStep[];
}

/** Raw YAML structure for the config (before validation) */
export interface RawCmConfig {
  version?: string;
  defaults?: {
    allowedTools?: string[];
    timeout?: number;
  };
  workflows?: Record<string, RawWorkflow>;
}
