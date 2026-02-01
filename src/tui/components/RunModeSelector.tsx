/**
 * Run mode selector - choose between agents, workflows, or default Claude
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { findGitRoot } from "../../lib/task/worktree";
import { listAgents, type Agent } from "../../lib/agents";
import { listWorkflows, type WorkflowSummary } from "../../lib/workflow";

/** Result of run mode selection */
export type RunModeSelection =
  | { type: "agent"; path: string }
  | { type: "workflow"; name: string }
  | { type: "default" };

interface RunModeSelectorProps {
  onSelect: (selection: RunModeSelection) => void;
  onCancel: () => void;
}

interface SelectableItem {
  type: "agent" | "workflow" | "default";
  name: string;
  value: string;
}

export function RunModeSelector({ onSelect, onCancel }: RunModeSelectorProps): React.ReactElement {
  const [items, setItems] = useState<SelectableItem[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadOptions().then(({ agents, workflows }) => {
      setAgents(agents);
      setWorkflows(workflows);

      // Build flat list of selectable items
      const items: SelectableItem[] = [];

      // Add agents
      for (const agent of agents) {
        items.push({ type: "agent", name: agent.name, value: agent.path });
      }

      // Add workflows
      for (const workflow of workflows) {
        items.push({ type: "workflow", name: workflow.name, value: workflow.name });
      }

      // Add default option at the end
      items.push({ type: "default", name: "Default Claude", value: "" });

      setItems(items);
      setLoading(false);
    });
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    } else if (key.return) {
      const item = items[selectedIndex];
      if (item.type === "agent") {
        onSelect({ type: "agent", path: item.value });
      } else if (item.type === "workflow") {
        onSelect({ type: "workflow", name: item.value });
      } else {
        onSelect({ type: "default" });
      }
    }
  });

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">Loading options...</Text>
      </Box>
    );
  }

  // Find section boundaries for visual grouping
  const agentCount = agents.length;
  const workflowCount = workflows.length;

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="cyan" bold>Select Run Mode</Text>
      <Box marginTop={1} flexDirection="column">
        {/* Agents section */}
        {agentCount > 0 && (
          <>
            <Text color="gray" dimColor>Agents:</Text>
            {agents.map((agent, index) => (
              <Box key={`agent-${agent.path}`}>
                <Text color={index === selectedIndex ? "cyan" : undefined}>
                  {index === selectedIndex ? ">" : " "}
                </Text>
                <Text> </Text>
                <Text color={index === selectedIndex ? "white" : "gray"} bold={index === selectedIndex}>
                  {agent.name}
                </Text>
              </Box>
            ))}
          </>
        )}

        {/* Workflows section */}
        {workflowCount > 0 && (
          <>
            <Box marginTop={agentCount > 0 ? 1 : 0}>
              <Text color="gray" dimColor>Workflows:</Text>
            </Box>
            {workflows.map((workflow, index) => {
              const itemIndex = agentCount + index;
              return (
                <Box key={`workflow-${workflow.name}`}>
                  <Text color={itemIndex === selectedIndex ? "magenta" : undefined}>
                    {itemIndex === selectedIndex ? ">" : " "}
                  </Text>
                  <Text> </Text>
                  <Text color={itemIndex === selectedIndex ? "white" : "gray"} bold={itemIndex === selectedIndex}>
                    {workflow.name}
                  </Text>
                  <Text color="gray" dimColor> - {workflow.description}</Text>
                </Box>
              );
            })}
          </>
        )}

        {/* Default option */}
        <Box marginTop={1}>
          <Text color="gray" dimColor>Other:</Text>
        </Box>
        {(() => {
          const defaultIndex = agentCount + workflowCount;
          return (
            <Box>
              <Text color={defaultIndex === selectedIndex ? "green" : undefined}>
                {defaultIndex === selectedIndex ? ">" : " "}
              </Text>
              <Text> </Text>
              <Text color={defaultIndex === selectedIndex ? "white" : "gray"} bold={defaultIndex === selectedIndex}>
                Default Claude (no agent or workflow)
              </Text>
            </Box>
          );
        })()}
      </Box>
    </Box>
  );
}

async function loadOptions(): Promise<{ agents: Agent[]; workflows: WorkflowSummary[] }> {
  try {
    const repoRoot = await findGitRoot(process.cwd());
    const [agents, workflows] = await Promise.all([
      listAgents(repoRoot),
      listWorkflows(repoRoot),
    ]);
    return { agents, workflows };
  } catch {
    return { agents: [], workflows: [] };
  }
}
