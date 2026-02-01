/**
 * React hook for task data management
 */

import { useState, useEffect, useCallback } from "react";
import type { TaskSummary, Task, CreateTaskOptions } from "../../lib/task/types";
import {
  listTasks,
  createTask as createTaskManager,
  getTask,
  completeTask as completeTaskManager,
  abandonTask as abandonTaskManager,
  deleteTask as deleteTaskManager,
  markTaskMerged,
  setTaskTmuxWindow,
} from "../../lib/task/manager";
import {
  createClaudeWindow,
  focusWindow,
  windowExists,
} from "../../lib/tmux/window-manager";
import {
  findGitRoot,
  mergeTaskBranch,
  removeWorktree,
} from "../../lib/task/worktree";
import { loadWorkflow, generateWorkflowSystemPrompt } from "../../lib/workflow";

export interface MergeResult {
  success: boolean;
  error?: string;
}

export interface UseTasksResult {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createTask: (options: CreateTaskOptions) => Promise<Task>;
  focusTask: (taskId: string) => Promise<void>;
  completeTask: (taskId: string) => Promise<void>;
  abandonTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  mergeTask: (taskId: string, cleanup: boolean) => Promise<MergeResult>;
}

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const taskList = await listTasks();
      setTasks(taskList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTask = useCallback(async (options: CreateTaskOptions): Promise<Task> => {
    // Load workflow system prompt if workflow specified
    let workflowSystemPrompt: string | undefined;
    if (options.workflow) {
      const repoPath = await findGitRoot(process.cwd());
      const workflow = await loadWorkflow(repoPath, options.workflow);
      workflowSystemPrompt = generateWorkflowSystemPrompt(workflow);
    }

    const task = await createTaskManager(options);

    // Create tmux window for Claude (prompt is passed directly to claude command)
    const windowName = await createClaudeWindow(task, workflowSystemPrompt);

    // Update task with window name
    await setTaskTmuxWindow(task.id, windowName);
    task.tmuxWindow = windowName;

    // Refresh the task list
    await refresh();

    return task;
  }, [refresh]);

  const focusTask = useCallback(async (taskId: string) => {
    const task = await getTask(taskId);
    if (task.tmuxWindow && await windowExists(task.tmuxWindow)) {
      await focusWindow(task.tmuxWindow);
    }
  }, []);

  const completeTask = useCallback(async (taskId: string) => {
    await completeTaskManager(taskId);
    await refresh();
  }, [refresh]);

  const abandonTask = useCallback(async (taskId: string) => {
    await abandonTaskManager(taskId);
    await refresh();
  }, [refresh]);

  const deleteTask = useCallback(async (taskId: string) => {
    await deleteTaskManager(taskId);
    await refresh();
  }, [refresh]);

  const mergeTask = useCallback(async (taskId: string, cleanup: boolean): Promise<MergeResult> => {
    try {
      const task = await getTask(taskId);

      // Perform the merge
      const result = await mergeTaskBranch(task.repoPath, taskId, task.baseBranch);

      if (!result.success) {
        return {
          success: false,
          error: result.conflicted
            ? "Merge conflicts detected. Resolve manually."
            : result.error || "Merge failed",
        };
      }

      // Mark task as merged
      await markTaskMerged(taskId);

      // Cleanup if requested
      if (cleanup) {
        await removeWorktree(task.repoPath, taskId, true);
      }

      await refresh();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Merge failed",
      };
    }
  }, [refresh]);

  return {
    tasks,
    loading,
    error,
    refresh,
    createTask,
    focusTask,
    completeTask,
    abandonTask,
    deleteTask,
    mergeTask,
  };
}
