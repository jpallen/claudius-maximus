/**
 * Simplified task types for TUI-based architecture
 */

/** Task execution status */
export type TaskStatus = "active" | "completed" | "merged" | "abandoned";

/** Complete task state */
export interface Task {
  /** Unique task ID (semantic branch name) */
  id: string;
  /** User's task description/prompt */
  prompt: string;
  /** Current task status */
  status: TaskStatus;
  /** Path to the git worktree for this task */
  worktreePath: string;
  /** Path to the original repository */
  repoPath: string;
  /** Base branch this task was created from (for merge-back) */
  baseBranch: string;
  /** Tmux window name when active */
  tmuxWindow?: string;
  /** Optional agent path (from .claude/agents/) */
  agent?: string;
  /** Optional workflow name (from .claudius-maximus/workflows/) */
  workflow?: string;
  /** When the task was created */
  createdAt: string;
}

/** Summary of a task for listing */
export interface TaskSummary {
  id: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  tmuxWindow?: string;
  agent?: string;
  workflow?: string;
}

/** Index file structure for quick task listing */
export interface TaskIndex {
  tasks: TaskSummary[];
}

/** Options for creating a new task */
export interface CreateTaskOptions {
  /** Task prompt/description */
  prompt: string;
  /** Optional agent path */
  agent?: string;
  /** Optional workflow name */
  workflow?: string;
  /** Base branch to create task from (default: current branch) */
  baseBranch?: string;
}
