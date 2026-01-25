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

/** Error when cm.yml file is not found */
export class ConfigNotFoundError extends CmError {
  constructor(searchPath: string) {
    super(`No cm.yml found in ${searchPath} or parent directories`);
    this.name = "ConfigNotFoundError";
  }
}

/** Error when cm.yml has invalid format or schema */
export class ConfigValidationError extends CmError {
  constructor(message: string) {
    super(`Invalid cm.yml: ${message}`);
    this.name = "ConfigValidationError";
  }
}

/** Error when a workflow is not found */
export class WorkflowNotFoundError extends CmError {
  constructor(workflowName: string) {
    super(`Workflow "${workflowName}" not found in cm.yml`);
    this.name = "WorkflowNotFoundError";
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

/** Error when Claude CLI execution fails */
export class ClaudeExecutionError extends CmError {
  exitCode: number;
  stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`Claude CLI exited with code ${exitCode}: ${stderr}`);
    this.name = "ClaudeExecutionError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Error when a step times out */
export class StepTimeoutError extends CmError {
  stepName: string;
  timeoutMs: number;

  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
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

/** Error when editor operations fail */
export class EditorError extends CmError {
  constructor(message: string) {
    super(`Editor error: ${message}`);
    this.name = "EditorError";
  }
}
