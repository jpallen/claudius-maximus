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
