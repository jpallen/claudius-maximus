/**
 * Main TUI application component
 */

import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { TaskList } from "./components/TaskList";
import { TaskCreator } from "./components/TaskCreator";
import { RunModeSelector, type RunModeSelection } from "./components/RunModeSelector";
import { MergeView, type MergeOption } from "./components/MergeView";
import { StatusBar, type AppView } from "./components/StatusBar";
import { useTasks } from "./hooks/useTasks";
import { getTask } from "../lib/task/manager";
import type { Task } from "../lib/task/types";

export function App(): React.ReactElement {
  const { exit } = useApp();
  const {
    tasks,
    loading,
    error,
    refresh,
    createTask,
    focusTask,
    mergeTask,
  } = useTasks();

  const [view, setView] = useState<AppView>("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingMergeTask, setPendingMergeTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  useInput((input, key) => {
    if (view === "list") {
      if (input === "n") {
        setView("create");
      } else if (input === "r") {
        refresh();
      } else if (input === "m" && tasks.length > 0) {
        // Start merge flow for selected task
        handleStartMerge(tasks[selectedIndex].id);
      } else if (input === "q" || key.escape) {
        exit();
      }
    }
  }, { isActive: !creating && !merging });

  const handleStartMerge = async (taskId: string) => {
    try {
      const task = await getTask(taskId);
      // Only allow merge for active or completed tasks
      if (task.status === "merged") {
        setMergeError("Task is already merged");
        return;
      }
      if (task.status === "abandoned") {
        setMergeError("Cannot merge abandoned task");
        return;
      }
      setPendingMergeTask(task);
      setMergeError(null);
      setView("merge");
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Failed to load task");
    }
  };

  const handleMergeSelect = async (option: MergeOption) => {
    if (!pendingMergeTask) return;

    if (option === "cancel") {
      setPendingMergeTask(null);
      setView("list");
      return;
    }

    setMerging(true);
    try {
      const cleanup = option === "merge-cleanup";
      const result = await mergeTask(pendingMergeTask.id, cleanup);

      if (!result.success) {
        setMergeError(result.error || "Merge failed");
      } else {
        setMergeError(null);
      }

      setPendingMergeTask(null);
      setView("list");
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const handlePromptSubmit = (prompt: string) => {
    setPendingPrompt(prompt);
    setView("mode");
  };

  const handleModeSelect = async (selection: RunModeSelection) => {
    if (!pendingPrompt) return;

    setCreating(true);
    try {
      await createTask({
        prompt: pendingPrompt,
        agent: selection.type === "agent" ? selection.path : undefined,
        workflow: selection.type === "workflow" ? selection.name : undefined,
      });
      setPendingPrompt(null);
      setView("list");
    } catch (err) {
      // Error handling could be improved
      console.error("Failed to create task:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = () => {
    setPendingPrompt(null);
    setPendingMergeTask(null);
    setMergeError(null);
    setView("list");
  };

  const handleFocusTask = async (taskId: string) => {
    await focusTask(taskId);
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header />

      {error && (
        <Box marginY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {mergeError && view === "list" && (
        <Box marginY={1}>
          <Text color="red">Merge error: {mergeError}</Text>
        </Box>
      )}

      {loading && view === "list" && (
        <Box marginY={1}>
          <Text color="gray">Loading tasks...</Text>
        </Box>
      )}

      {creating && (
        <Box marginY={1}>
          <Text color="yellow">Creating task...</Text>
        </Box>
      )}

      {merging && (
        <Box marginY={1}>
          <Text color="yellow">Merging...</Text>
        </Box>
      )}

      {!loading && !creating && !merging && view === "list" && (
        <TaskList
          tasks={tasks}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onFocus={handleFocusTask}
        />
      )}

      {view === "create" && (
        <TaskCreator
          onSubmit={handlePromptSubmit}
          onCancel={handleCancel}
        />
      )}

      {view === "mode" && (
        <RunModeSelector
          onSelect={handleModeSelect}
          onCancel={handleCancel}
          disabled={creating}
        />
      )}

      {view === "merge" && pendingMergeTask && (
        <MergeView
          task={pendingMergeTask}
          onSelect={handleMergeSelect}
          onCancel={handleCancel}
          disabled={merging}
        />
      )}

      <StatusBar view={view} />
    </Box>
  );
}

function Header(): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text color="cyan" bold>Claudius Maximus</Text>
      <Text color="gray"> - Task Manager</Text>
    </Box>
  );
}
