/**
 * Simplified task CRUD operations and persistence
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir, rm } from "fs/promises";
import { CLI_NAME } from "../constants";
import { TaskNotFoundError, InvalidBranchError } from "../errors";
import { generateTaskId } from "./id-generator";
import { generateBranchName, ensureUniqueBranchName } from "./branch-name-generator";
import {
  createWorktree,
  removeWorktree,
  findGitRoot,
  getCurrentBranch,
  branchExists,
} from "./worktree";
import type {
  Task,
  TaskSummary,
  TaskIndex,
  TaskStatus,
  CreateTaskOptions,
} from "./types";

/** Get the base config directory (respects CM_CONFIG_DIR for testing) */
function getConfigDir(): string {
  return process.env.CM_CONFIG_DIR || join(homedir(), `.${CLI_NAME}`);
}

/** Directory for task storage */
function getTasksDir(): string {
  return join(getConfigDir(), "tasks");
}

/** Get the index file path */
function getIndexPath(): string {
  return join(getTasksDir(), "index.json");
}

/** Get the task directory path */
function getTaskDir(taskId: string): string {
  return join(getTasksDir(), taskId);
}

/** Get the task.json path */
function getTaskPath(taskId: string): string {
  return join(getTaskDir(taskId), "task.json");
}

/**
 * Ensure the tasks directory exists
 */
async function ensureTasksDir(): Promise<void> {
  await mkdir(getTasksDir(), { recursive: true });
}

/**
 * Load the task index
 */
async function loadIndex(): Promise<TaskIndex> {
  const indexPath = getIndexPath();
  const file = Bun.file(indexPath);

  if (await file.exists()) {
    try {
      const content = await file.text();
      return JSON.parse(content) as TaskIndex;
    } catch {
      return { tasks: [] };
    }
  }

  return { tasks: [] };
}

/**
 * Save the task index
 */
async function saveIndex(index: TaskIndex): Promise<void> {
  await ensureTasksDir();
  const indexPath = getIndexPath();
  await Bun.write(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Update the index with a task summary
 */
async function updateIndexEntry(task: Task): Promise<void> {
  const index = await loadIndex();
  const summary: TaskSummary = {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    tmuxWindow: task.tmuxWindow,
    agent: task.agent,
    workflow: task.workflow,
  };

  const existingIndex = index.tasks.findIndex((t) => t.id === task.id);
  if (existingIndex >= 0) {
    index.tasks[existingIndex] = summary;
  } else {
    index.tasks.push(summary);
  }

  await saveIndex(index);
}

/**
 * Remove a task from the index
 */
async function removeFromIndex(taskId: string): Promise<void> {
  const index = await loadIndex();
  index.tasks = index.tasks.filter((t) => t.id !== taskId);
  await saveIndex(index);
}

/**
 * Save a task to disk
 */
async function saveTask(task: Task): Promise<void> {
  const taskDir = getTaskDir(task.id);

  await mkdir(taskDir, { recursive: true });

  const taskPath = getTaskPath(task.id);
  await Bun.write(taskPath, JSON.stringify(task, null, 2));

  await updateIndexEntry(task);
}

/**
 * Load a task from disk
 */
export async function loadTask(taskId: string): Promise<Task> {
  const taskPath = getTaskPath(taskId);
  const file = Bun.file(taskPath);

  if (!(await file.exists())) {
    throw new TaskNotFoundError(taskId);
  }

  const content = await file.text();
  return JSON.parse(content) as Task;
}

/**
 * Get all existing task IDs
 */
async function getExistingTaskIds(): Promise<Set<string>> {
  const index = await loadIndex();
  return new Set(index.tasks.map((t) => t.id));
}

/**
 * Create a new task
 */
export async function createTask(
  options: CreateTaskOptions,
  repoPath?: string
): Promise<Task> {
  await ensureTasksDir();

  // Get repo path
  const actualRepoPath = repoPath || (await findGitRoot(process.cwd()));

  // Determine base branch
  let baseBranch: string;
  if (options.baseBranch) {
    // Validate that the specified branch exists
    if (!(await branchExists(actualRepoPath, options.baseBranch))) {
      throw new InvalidBranchError(options.baseBranch);
    }
    baseBranch = options.baseBranch;
  } else {
    baseBranch = await getCurrentBranch(actualRepoPath);
  }

  // Get existing task IDs for uniqueness check
  const existingIds = await getExistingTaskIds();

  // Generate task ID - try Claude first, fallback to random
  let taskId: string;

  // Try to generate a semantic branch name from the prompt
  const generatedName = await generateBranchName(
    options.prompt,
    actualRepoPath
  );

  if (generatedName) {
    // Ensure uniqueness
    taskId = ensureUniqueBranchName(generatedName, existingIds);
  } else {
    // Fallback to original random ID generation
    taskId = generateTaskId(existingIds);
  }

  // Create worktree with base branch
  const worktreePath = await createWorktree(actualRepoPath, taskId, baseBranch);

  // Create task
  const task: Task = {
    id: taskId,
    prompt: options.prompt,
    status: "active",
    worktreePath,
    repoPath: actualRepoPath,
    baseBranch,
    agent: options.agent,
    workflow: options.workflow,
    createdAt: new Date().toISOString(),
  };

  await saveTask(task);

  return task;
}

/**
 * Update a task
 */
export async function updateTask(task: Task): Promise<void> {
  await saveTask(task);
}

/**
 * List all tasks
 */
export async function listTasks(): Promise<TaskSummary[]> {
  const index = await loadIndex();
  return index.tasks;
}

/**
 * Get a task by ID
 */
export async function getTask(taskId: string): Promise<Task> {
  return loadTask(taskId);
}

/**
 * Delete a task and its worktree
 */
export async function deleteTask(taskId: string): Promise<void> {
  const task = await loadTask(taskId);

  // Remove worktree
  try {
    await removeWorktree(task.repoPath, taskId);
  } catch {
    // Worktree might already be removed
  }

  // Remove task directory
  const taskDir = getTaskDir(taskId);
  await rm(taskDir, { recursive: true, force: true });

  // Remove from index
  await removeFromIndex(taskId);
}

/**
 * Mark a task as completed
 */
export async function completeTask(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);
  task.status = "completed";
  task.tmuxWindow = undefined;
  await saveTask(task);
  return task;
}

/**
 * Mark a task as abandoned
 */
export async function abandonTask(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);
  task.status = "abandoned";
  task.tmuxWindow = undefined;
  await saveTask(task);
  return task;
}

/**
 * Set the tmux window for a task
 */
export async function setTaskTmuxWindow(taskId: string, windowName: string): Promise<Task> {
  const task = await loadTask(taskId);
  task.tmuxWindow = windowName;
  await saveTask(task);
  return task;
}

/**
 * Mark a task as merged
 */
export async function markTaskMerged(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);
  task.status = "merged";
  task.tmuxWindow = undefined;
  await saveTask(task);
  return task;
}
