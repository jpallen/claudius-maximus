/**
 * Main TUI application component
 */

import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { TaskList } from "./components/TaskList";
import { TaskCreator } from "./components/TaskCreator";
import { AgentSelector } from "./components/AgentSelector";
import { StatusBar, type AppView } from "./components/StatusBar";
import { useTasks } from "./hooks/useTasks";

export function App(): React.ReactElement {
  const { exit } = useApp();
  const {
    tasks,
    loading,
    error,
    refresh,
    createTask,
    focusTask,
  } = useTasks();

  const [view, setView] = useState<AppView>("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useInput((input, key) => {
    if (view === "list") {
      if (input === "n") {
        setView("create");
      } else if (input === "r") {
        refresh();
      } else if (input === "q" || key.escape) {
        exit();
      }
    }
  });

  const handlePromptSubmit = (prompt: string) => {
    setPendingPrompt(prompt);
    setView("agent");
  };

  const handleAgentSelect = async (agentPath: string | undefined) => {
    if (!pendingPrompt) return;

    setCreating(true);
    try {
      await createTask({
        prompt: pendingPrompt,
        agent: agentPath,
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

      {!loading && !creating && view === "list" && (
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

      {view === "agent" && (
        <AgentSelector
          onSelect={handleAgentSelect}
          onCancel={() => {
            // Skip agent selection, use no agent
            handleAgentSelect(undefined);
          }}
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
