/**
 * Agent loading and discovery
 */

import { join } from "path";
import type { Agent } from "./types";

const AGENTS_DIR = ".claude/agents";

/**
 * Get the agents directory for a repository
 */
export function getAgentsDir(repoPath: string): string {
  return join(repoPath, AGENTS_DIR);
}

/**
 * List all available agents in a repository
 */
export async function listAgents(repoPath: string): Promise<Agent[]> {
  try {
    const agentsDir = getAgentsDir(repoPath);
    const glob = new Bun.Glob("*.md");
    const agents: Agent[] = [];

    for await (const file of glob.scan({ cwd: agentsDir })) {
      const name = file.replace(/\.md$/, "");
      const path = join(agentsDir, file);
      agents.push({ name, path });
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
