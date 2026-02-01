/**
 * Merge view - shows commits and merge options
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTaskCommitSummary, getUncommittedChanges } from "../../lib/task/worktree";
import type { Task } from "../../lib/task/types";

interface CommitInfo {
  hash: string;
  subject: string;
}

export type MergeOption = "merge-cleanup" | "merge-keep" | "cancel";

interface MergeViewProps {
  task: Task;
  onSelect: (option: MergeOption) => void;
  onCancel: () => void;
}

export function MergeView({ task, onSelect, onCancel }: MergeViewProps): React.ReactElement {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options: { key: MergeOption; label: string }[] = [
    { key: "merge-cleanup", label: "Merge and cleanup (remove worktree)" },
    { key: "merge-keep", label: "Merge and keep branch" },
    { key: "cancel", label: "Cancel" },
  ];

  useEffect(() => {
    loadMergeInfo();
  }, [task]);

  async function loadMergeInfo() {
    try {
      setLoading(true);
      setError(null);

      // Check for uncommitted changes
      const changes = await getUncommittedChanges(task.worktreePath);
      if (changes.hasChanges) {
        const details: string[] = [];
        if (changes.staged.length) details.push(`Staged: ${changes.staged.join(", ")}`);
        if (changes.unstaged.length) details.push(`Modified: ${changes.unstaged.join(", ")}`);
        if (changes.untracked.length) details.push(`Untracked: ${changes.untracked.join(", ")}`);
        setError(`Uncommitted changes in worktree:\n${details.join("\n")}`);
        setLoading(false);
        return;
      }

      // Get commits to merge
      const commitList = await getTaskCommitSummary(task.repoPath, task.id, task.baseBranch);
      setCommits(commitList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load merge info");
    } finally {
      setLoading(false);
    }
  }

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => Math.min(options.length - 1, prev + 1));
    } else if (key.return) {
      onSelect(options[selectedIndex].key);
    }
  });

  if (loading) {
    return (
      <Box paddingY={1}>
        <Text color="gray">Loading merge info...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="red" bold>Cannot merge</Text>
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">Press Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  if (commits.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="yellow" bold>No commits to merge</Text>
        <Box marginTop={1}>
          <Text color="gray">The task branch has no commits ahead of {task.baseBranch}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">Press Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="cyan" bold>Merge Task: {task.id}</Text>
      <Text color="gray">into {task.baseBranch}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>Commits ({commits.length}):</Text>
        {commits.slice(0, 10).map((commit) => (
          <Box key={commit.hash}>
            <Text color="yellow">{commit.hash.slice(0, 7)}</Text>
            <Text color="gray"> {commit.subject}</Text>
          </Box>
        ))}
        {commits.length > 10 && (
          <Text color="gray" dimColor>... and {commits.length - 10} more</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>Options:</Text>
        {options.map((option, index) => (
          <Box key={option.key}>
            <Text color={index === selectedIndex ? "green" : undefined}>
              {index === selectedIndex ? ">" : " "}
            </Text>
            <Text> </Text>
            <Text
              color={index === selectedIndex ? "white" : "gray"}
              bold={index === selectedIndex}
            >
              {option.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
