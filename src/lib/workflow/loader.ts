/**
 * Workflow loading and parsing
 */

import { join } from "path";
import { readdir } from "fs/promises";
import { WorkflowNotFoundError } from "../errors";
import type { Workflow, WorkflowMeta, WorkflowSummary } from "./types";

const WORKFLOWS_DIR = ".claudius-maximus/workflows";

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { meta: WorkflowMeta; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Invalid workflow file: missing frontmatter");
  }

  // Parse YAML frontmatter (simple key: value parsing)
  const frontmatterLines = match[1].split("\n");
  const meta: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }

  if (!meta.name || !meta.description) {
    throw new Error("Workflow must have name and description in frontmatter");
  }

  return {
    meta: meta as unknown as WorkflowMeta,
    body: match[2].trim(),
  };
}

/**
 * Get the workflows directory for a repository
 */
export function getWorkflowsDir(repoPath: string): string {
  return join(repoPath, WORKFLOWS_DIR);
}

/**
 * Load a workflow by name from a repository
 */
export async function loadWorkflow(
  repoPath: string,
  name: string
): Promise<Workflow> {
  const workflowPath = join(getWorkflowsDir(repoPath), `${name}.md`);
  const file = Bun.file(workflowPath);

  if (!(await file.exists())) {
    throw new WorkflowNotFoundError(name);
  }

  const content = await file.text();
  const { meta, body } = parseFrontmatter(content);

  return { path: workflowPath, meta, body };
}

/**
 * List all available workflows in a repository
 */
export async function listWorkflows(repoPath: string): Promise<WorkflowSummary[]> {
  const dir = getWorkflowsDir(repoPath);

  try {
    const files = await readdir(dir);
    const workflows: WorkflowSummary[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const content = await Bun.file(join(dir, file)).text();
      try {
        const { meta } = parseFrontmatter(content);
        workflows.push({
          name: meta.name,
          description: meta.description,
          path: join(dir, file),
        });
      } catch {
        // Skip invalid workflow files
      }
    }

    return workflows;
  } catch {
    return []; // No workflows directory
  }
}
