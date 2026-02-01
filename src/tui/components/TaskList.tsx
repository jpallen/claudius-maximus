/**
 * Task list component showing all tasks with status indicators
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { TaskSummary } from "../../lib/task/types";

interface TaskListProps {
  tasks: TaskSummary[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onFocus: (taskId: string) => void;
}

export function TaskList({
  tasks,
  selectedIndex,
  onSelect,
  onFocus,
}: TaskListProps): React.ReactElement {
  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      onSelect(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow || input === "j") {
      onSelect(Math.min(tasks.length - 1, selectedIndex + 1));
    } else if (key.return && tasks.length > 0) {
      onFocus(tasks[selectedIndex].id);
    }
  });

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="gray">No tasks yet. Press </Text>
        <Text color="cyan" bold>n</Text>
        <Text color="gray"> to create one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          isSelected={index === selectedIndex}
        />
      ))}
    </Box>
  );
}

interface TaskRowProps {
  task: TaskSummary;
  isSelected: boolean;
}

function TaskRow({ task, isSelected }: TaskRowProps): React.ReactElement {
  const statusIcon = getStatusIcon(task.status);
  const statusColor = getStatusColor(task.status);

  return (
    <Box>
      <Text color={isSelected ? "cyan" : undefined}>
        {isSelected ? ">" : " "}
      </Text>
      <Text> </Text>
      <Text color={statusColor}>{statusIcon}</Text>
      <Text> </Text>
      <Text color={isSelected ? "white" : "gray"} bold={isSelected}>
        {task.id}
      </Text>
      <Text color="gray"> - </Text>
      <Text color={isSelected ? "white" : "gray"}>
        {truncate(task.prompt, 50)}
      </Text>
      {task.agent && (
        <Text color="magenta"> [{getAgentName(task.agent)}]</Text>
      )}
      {task.workflow && (
        <Text color="cyan"> [{task.workflow}]</Text>
      )}
    </Box>
  );
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "active":
      return "\u25cf"; // ●
    case "completed":
      return "\u2713"; // ✓
    case "merged":
      return "\u2714"; // ✔
    case "abandoned":
      return "\u25cb"; // ○
    default:
      return "?";
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case "active":
      return "green";
    case "completed":
      return "blue";
    case "merged":
      return "magenta";
    case "abandoned":
      return "gray";
    default:
      return "white";
  }
}

function truncate(str: string | undefined, maxLength: number): string {
  if (!str) {
    return "";
  }
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + "...";
}

function getAgentName(agentPath: string): string {
  // Extract just the filename without extension
  const parts = agentPath.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.md$/, "");
}
