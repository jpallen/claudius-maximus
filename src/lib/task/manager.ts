/**
 * Task CRUD operations and persistence
 */

import { homedir } from "os";
import { join, dirname } from "path";
import { mkdir, rm } from "fs/promises";
import { CLI_NAME } from "../constants";
import { TaskNotFoundError, InvalidTaskStateError, InvalidBranchError } from "../errors";
import { generateTaskId } from "./id-generator";
import {
  createWorktree,
  removeWorktree,
  findGitRoot,
  getWorktreePath,
  getCurrentBranch,
  branchExists,
} from "./worktree";
import type {
  Task,
  TaskSummary,
  TaskIndex,
  TaskStatus,
  StepExecution,
  StepAttempt,
  CreateTaskOptions,
  TaskThread,
  ThreadEntry,
  ThreadEntryType,
} from "./types";
import type { Workflow } from "../workflow/types";

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

/** Get the steps directory path */
function getStepsDir(taskId: string): string {
  return join(getTaskDir(taskId), "steps");
}

/** Get the step log path (legacy format) */
function getStepPath(taskId: string, stepIndex: number, stepName: string): string {
  const paddedIndex = String(stepIndex + 1).padStart(2, "0");
  return join(getStepsDir(taskId), `${paddedIndex}-${stepName}.json`);
}

/** Get the step directory for a specific step */
function getStepDir(taskId: string, stepName: string): string {
  return join(getStepsDir(taskId), stepName);
}

/** Get the attempt file path */
function getAttemptPath(taskId: string, stepName: string, attempt: number): string {
  return join(getStepDir(taskId, stepName), `attempt-${attempt}.json`);
}

/** Get the thread file path */
function getThreadPath(taskId: string): string {
  return join(getTaskDir(taskId), "thread.json");
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
    description: task.description,
    workflow: task.workflow,
    status: task.status,
    currentStep: task.currentStep,
    totalSteps: task.steps.length,
    createdAt: task.createdAt,
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
  const stepsDir = getStepsDir(task.id);

  await mkdir(taskDir, { recursive: true });
  await mkdir(stepsDir, { recursive: true });

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
  workflow: Workflow,
  workflowName: string,
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

  // Generate unique ID
  const existingIds = await getExistingTaskIds();
  const taskId = generateTaskId(existingIds);

  // Create worktree with base branch
  const worktreePath = await createWorktree(actualRepoPath, taskId, baseBranch);

  // Initialize step executions
  const steps: StepExecution[] = workflow.steps.map((step) => ({
    name: step.name,
    status: "pending",
    model: step.model,
    agent: step.agent,
    prompt: step.prompt,
  }));

  // Create task
  const task: Task = {
    id: taskId,
    description: options.description,
    workflow: workflowName,
    status: "pending",
    worktreePath,
    repoPath: actualRepoPath,
    baseBranch,
    currentStep: 0,
    steps,
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
 * Save step execution log
 */
export async function saveStepLog(
  taskId: string,
  stepIndex: number,
  stepName: string,
  log: object
): Promise<void> {
  const stepPath = getStepPath(taskId, stepIndex, stepName);
  await Bun.write(stepPath, JSON.stringify(log, null, 2));
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
 * Cancel a running or pending task
 */
export async function cancelTask(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);

  if (task.status !== "running" && task.status !== "pending" && task.status !== "paused") {
    throw new InvalidTaskStateError(
      taskId,
      task.status,
      "running, pending, or paused"
    );
  }

  task.status = "cancelled";
  task.endedAt = new Date().toISOString();

  // Mark remaining steps as skipped
  for (let i = task.currentStep; i < task.steps.length; i++) {
    if (task.steps[i].status === "pending" || task.steps[i].status === "running") {
      task.steps[i].status = "skipped";
    }
  }

  await saveTask(task);

  return task;
}

/**
 * Set task status to running
 */
export async function startTask(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);

  if (task.status !== "pending" && task.status !== "paused") {
    throw new InvalidTaskStateError(taskId, task.status, "pending or paused");
  }

  task.status = "running";
  task.startedAt = task.startedAt || new Date().toISOString();

  await saveTask(task);

  return task;
}

/**
 * Pause a task (waiting for user input)
 */
export async function pauseTask(
  taskId: string,
  reason?: string
): Promise<Task> {
  const task = await loadTask(taskId);

  if (task.status !== "running") {
    throw new InvalidTaskStateError(taskId, task.status, "running");
  }

  task.status = "paused";

  await saveTask(task);

  return task;
}

/**
 * Resume a paused task with a user prompt
 */
export async function resumeTask(
  taskId: string,
  prompt?: string
): Promise<Task> {
  const task = await loadTask(taskId);

  if (task.status !== "paused") {
    throw new InvalidTaskStateError(taskId, task.status, "paused");
  }

  task.status = "running";
  if (prompt) {
    task.resumePrompt = prompt;
  }

  await saveTask(task);

  return task;
}

/**
 * Mark a task as completed
 */
export async function completeTask(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);

  task.status = "completed";
  task.endedAt = new Date().toISOString();

  await saveTask(task);

  return task;
}

/**
 * Mark a task as failed
 */
export async function failTask(taskId: string, error: string): Promise<Task> {
  const task = await loadTask(taskId);

  task.status = "failed";
  task.endedAt = new Date().toISOString();
  task.error = error;

  await saveTask(task);

  return task;
}

/**
 * Update step execution status
 */
export async function updateStepStatus(
  taskId: string,
  stepIndex: number,
  updates: Partial<StepExecution>
): Promise<Task> {
  const task = await loadTask(taskId);

  if (stepIndex < 0 || stepIndex >= task.steps.length) {
    throw new Error(`Invalid step index: ${stepIndex}`);
  }

  Object.assign(task.steps[stepIndex], updates);

  await saveTask(task);

  return task;
}

/**
 * Advance to the next step
 */
export async function advanceStep(taskId: string): Promise<Task> {
  const task = await loadTask(taskId);

  task.currentStep++;

  await saveTask(task);

  return task;
}

/**
 * Load a step attempt from disk
 */
export async function loadAttempt(
  taskId: string,
  stepName: string,
  attempt: number
): Promise<StepAttempt> {
  const attemptPath = getAttemptPath(taskId, stepName, attempt);
  const file = Bun.file(attemptPath);

  if (!(await file.exists())) {
    throw new Error(`Attempt ${attempt} for step "${stepName}" not found`);
  }

  const content = await file.text();
  return JSON.parse(content) as StepAttempt;
}

/**
 * Save a step attempt to disk
 */
export async function saveAttempt(
  taskId: string,
  stepName: string,
  attempt: StepAttempt
): Promise<void> {
  const attemptPath = getAttemptPath(taskId, stepName, attempt.attemptNumber);
  const stepDir = getStepDir(taskId, stepName);
  await mkdir(stepDir, { recursive: true });
  await Bun.write(attemptPath, JSON.stringify(attempt, null, 2));
}

/**
 * Mark a step attempt as explicitly completed
 */
export async function markStepComplete(
  taskId: string,
  stepName: string,
  attempt: number,
  message?: string
): Promise<void> {
  const attemptData = await loadAttempt(taskId, stepName, attempt);
  attemptData.explicitlyCompleted = true;
  attemptData.completionMessage = message;
  attemptData.status = "completed";
  attemptData.completedAt = new Date().toISOString();
  await saveAttempt(taskId, stepName, attemptData);

  // Update task.json with latest status
  const task = await loadTask(taskId);
  const stepIndex = task.steps.findIndex((s) => s.name === stepName);
  if (stepIndex >= 0) {
    task.steps[stepIndex].status = "completed";
    await saveTask(task);
  }
}

/**
 * Mark a step attempt as explicitly failed
 */
export async function markStepFailed(
  taskId: string,
  stepName: string,
  attempt: number,
  reason: string
): Promise<void> {
  const attemptData = await loadAttempt(taskId, stepName, attempt);
  attemptData.explicitlyFailed = true;
  attemptData.error = reason;
  attemptData.status = "failed";
  attemptData.completedAt = new Date().toISOString();
  await saveAttempt(taskId, stepName, attemptData);

  // Update task.json with latest status
  const task = await loadTask(taskId);
  const stepIndex = task.steps.findIndex((s) => s.name === stepName);
  if (stepIndex >= 0) {
    task.steps[stepIndex].status = "failed";
    await saveTask(task);
  }
}

/**
 * Create an empty task thread
 */
function createEmptyThread(): TaskThread {
  const now = new Date().toISOString();
  return {
    entries: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      totalCharacters: 0,
    },
  };
}

/**
 * Generate a unique thread entry ID
 */
function generateEntryId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Load a task thread from disk
 */
export async function loadThread(taskId: string): Promise<TaskThread> {
  const threadPath = getThreadPath(taskId);
  const file = Bun.file(threadPath);

  if (await file.exists()) {
    try {
      const content = await file.text();
      return JSON.parse(content) as TaskThread;
    } catch {
      return createEmptyThread();
    }
  }

  return createEmptyThread();
}

/**
 * Save a task thread to disk
 */
export async function saveThread(taskId: string, thread: TaskThread): Promise<void> {
  const taskDir = getTaskDir(taskId);
  await mkdir(taskDir, { recursive: true });

  const threadPath = getThreadPath(taskId);
  await Bun.write(threadPath, JSON.stringify(thread, null, 2));
}

/**
 * Append a thread entry and update metadata
 */
export async function appendThreadEntry(
  taskId: string,
  entry: Omit<ThreadEntry, "id" | "timestamp">
): Promise<ThreadEntry> {
  const thread = await loadThread(taskId);

  const fullEntry: ThreadEntry = {
    ...entry,
    id: generateEntryId(),
    timestamp: new Date().toISOString(),
  };

  thread.entries.push(fullEntry);
  thread.metadata.updatedAt = fullEntry.timestamp;
  thread.metadata.totalCharacters += entry.content.length;

  await saveThread(taskId, thread);

  return fullEntry;
}
