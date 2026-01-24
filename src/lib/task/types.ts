/**
 * TypeScript interfaces for task state and management
 */

import type { Model } from "../workflow/types";

/** Task execution status */
export type TaskStatus =
  | "pending" // Created but not started
  | "running" // Currently executing
  | "paused" // Waiting for user input
  | "completed" // Successfully finished
  | "failed" // Failed with error
  | "cancelled"; // Cancelled by user

/** Step execution status */
export type StepStatus =
  | "pending" // Not yet started
  | "running" // Currently executing
  | "completed" // Successfully finished
  | "failed" // Failed with error
  | "skipped"; // Skipped (e.g., after cancellation)

/** Record of a step execution (lightweight pointer in task.json) */
export interface StepExecution {
  /** Step name from workflow */
  name: string;
  /** Current status */
  status: StepStatus;
  /** Model used */
  model?: Model;
  /** Agent used (path in .claude/agents/) */
  agent?: string;
  /** Prompt sent to Claude */
  prompt?: string;
  /** Current attempt number (1-based) */
  currentAttempt?: number;
  /** When step started */
  startedAt?: string;
  /** When step completed */
  completedAt?: string;
  /** Claude CLI output (if completed) */
  output?: string;
  /** Error message (if failed) */
  error?: string;
}

/** Full execution record for a step attempt (stored in attempt-N.json) */
export interface StepAttempt {
  /** Attempt number (1-based) */
  attemptNumber: number;
  /** Current status */
  status: StepStatus;
  /** When attempt started */
  startedAt: string;
  /** When attempt completed */
  completedAt?: string;
  /** Claude CLI output */
  output?: string;
  /** Error message (if failed) */
  error?: string;
  /** Whether Claude explicitly marked step complete via cm task complete */
  explicitlyCompleted?: boolean;
  /** Whether Claude explicitly marked step failed via cm task fail */
  explicitlyFailed?: boolean;
  /** Message provided with cm task complete */
  completionMessage?: string;
}

/** Complete task state */
export interface Task {
  /** Unique task ID (e.g., "swift-falcon") */
  id: string;
  /** Task description from user */
  description: string;
  /** Workflow name being executed */
  workflow: string;
  /** Current task status */
  status: TaskStatus;
  /** Path to the git worktree for this task */
  worktreePath: string;
  /** Path to the original repository */
  repoPath: string;
  /** Index of the current step (0-based) */
  currentStep: number;
  /** Record of all step executions */
  steps: StepExecution[];
  /** When the task was created */
  createdAt: string;
  /** When the task started running */
  startedAt?: string;
  /** When the task completed/failed/cancelled */
  endedAt?: string;
  /** Error message if failed */
  error?: string;
  /** User-provided prompt for resume */
  resumePrompt?: string;
}

/** Summary of a task for listing */
export interface TaskSummary {
  id: string;
  description: string;
  workflow: string;
  status: TaskStatus;
  currentStep: number;
  totalSteps: number;
  createdAt: string;
}

/** Index file structure for quick task listing */
export interface TaskIndex {
  tasks: TaskSummary[];
}

/** Options for creating a new task */
export interface CreateTaskOptions {
  /** Task description */
  description: string;
  /** Workflow name to use (default: "default") */
  workflow?: string;
  /** Whether to start execution immediately (default: true) */
  start?: boolean;
}
