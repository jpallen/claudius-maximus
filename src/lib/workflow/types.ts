/**
 * Workflow types for orchestration mode
 */

/** Frontmatter metadata for a workflow */
export interface WorkflowMeta {
  name: string;
  description: string;
  model?: string;
  color?: string;
}

/** A loaded workflow with parsed content */
export interface Workflow {
  /** Path to the workflow file */
  path: string;
  /** Parsed frontmatter metadata */
  meta: WorkflowMeta;
  /** Raw markdown body (workflow steps) */
  body: string;
}

/** Summary for listing workflows */
export interface WorkflowSummary {
  name: string;
  description: string;
  path: string;
}
