/**
 * Typed error classes for cm-cli
 */

/** Base error class for all cm errors */
export class CmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmError";
  }
}

/** Error when a task is not found */
export class TaskNotFoundError extends CmError {
  constructor(taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
  }
}

/** Error when trying to operate on a task in an invalid state */
export class InvalidTaskStateError extends CmError {
  constructor(taskId: string, currentState: string, expectedState: string) {
    super(
      `Task "${taskId}" is in state "${currentState}", expected "${expectedState}"`
    );
    this.name = "InvalidTaskStateError";
  }
}

/** Error when git worktree operation fails */
export class WorktreeError extends CmError {
  constructor(operation: string, message: string) {
    super(`Git worktree ${operation} failed: ${message}`);
    this.name = "WorktreeError";
  }
}

/** Error when not in a git repository */
export class NotInGitRepoError extends CmError {
  constructor() {
    super("Not in a git repository");
    this.name = "NotInGitRepoError";
  }
}

/** Error when a branch does not exist */
export class InvalidBranchError extends CmError {
  branchName: string;

  constructor(branchName: string) {
    super(`Branch "${branchName}" does not exist`);
    this.name = "InvalidBranchError";
    this.branchName = branchName;
  }
}

/** Error when tmux is not available */
export class TmuxNotAvailableError extends CmError {
  constructor() {
    super("tmux is not installed or not available in PATH");
    this.name = "TmuxNotAvailableError";
  }
}

/** Error when a workflow is not found */
export class WorkflowNotFoundError extends CmError {
  constructor(workflowName: string) {
    super(`Workflow "${workflowName}" not found in .claudius-maximus/workflows/`);
    this.name = "WorkflowNotFoundError";
  }
}

/** Error when there are uncommitted changes that block an operation */
export class UncommittedChangesError extends CmError {
  staged: string[];
  unstaged: string[];
  untracked: string[];

  constructor(
    staged: string[],
    unstaged: string[],
    untracked: string[]
  ) {
    const message = formatUncommittedChangesMessage(staged, unstaged, untracked);
    super(message);
    this.name = "UncommittedChangesError";
    this.staged = staged;
    this.unstaged = unstaged;
    this.untracked = untracked;
  }
}

/**
 * Format a clear, actionable message for Claude about uncommitted changes
 */
export function formatUncommittedChangesMessage(
  staged: string[],
  unstaged: string[],
  untracked: string[]
): string {
  const lines: string[] = [
    "Cannot stop: there are uncommitted changes in this task worktree.",
    "",
    "You must handle these files before stopping:",
  ];

  if (staged.length > 0) {
    lines.push("");
    lines.push("Staged files (commit these):");
    staged.forEach(f => lines.push(`  - ${f}`));
  }

  if (unstaged.length > 0) {
    lines.push("");
    lines.push("Modified files (commit or discard changes):");
    unstaged.forEach(f => lines.push(`  - ${f}`));
  }

  if (untracked.length > 0) {
    lines.push("");
    lines.push("Untracked files (commit, delete, or add to .gitignore):");
    untracked.forEach(f => lines.push(`  - ${f}`));
  }

  lines.push("");
  lines.push("Actions to take:");
  lines.push("  1. Commit all intended changes: git add <files> && git commit -m 'message'");
  lines.push("  2. Delete any temporary/generated files you don't need");
  lines.push("  3. Add any files that should be ignored to .gitignore");

  return lines.join("\n");
}
