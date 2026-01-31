/**
 * Agent selector component - choose an agent from .claude/agents/*.md
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { join } from "path";
import { findGitRoot } from "../../lib/task/worktree";

interface Agent {
  name: string;
  path: string;
}

interface AgentSelectorProps {
  onSelect: (agentPath: string | undefined) => void;
  onCancel: () => void;
}

export function AgentSelector({ onSelect, onCancel }: AgentSelectorProps): React.ReactElement {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAgents().then((loaded) => {
      setAgents(loaded);
      setLoading(false);
    });
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(agents.length, prev + 1));
    } else if (key.return) {
      if (selectedIndex === agents.length) {
        // "No agent" option
        onSelect(undefined);
      } else {
        onSelect(agents[selectedIndex].path);
      }
    }
  });

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">Loading agents...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="cyan" bold>Select Agent</Text>
      <Box marginTop={1} flexDirection="column">
        {agents.map((agent, index) => (
          <Box key={agent.path}>
            <Text color={index === selectedIndex ? "cyan" : undefined}>
              {index === selectedIndex ? ">" : " "}
            </Text>
            <Text> </Text>
            <Text color={index === selectedIndex ? "white" : "gray"} bold={index === selectedIndex}>
              {agent.name}
            </Text>
          </Box>
        ))}
        <Box>
          <Text color={selectedIndex === agents.length ? "cyan" : undefined}>
            {selectedIndex === agents.length ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text color={selectedIndex === agents.length ? "white" : "gray"} bold={selectedIndex === agents.length}>
            (No agent - use default Claude)
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

async function loadAgents(): Promise<Agent[]> {
  try {
    const repoRoot = await findGitRoot(process.cwd());
    const agentsDir = join(repoRoot, ".claude", "agents");

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
