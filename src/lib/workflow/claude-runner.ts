/**
 * Claude CLI subprocess runner
 */

import { ClaudeExecutionError, StepTimeoutError } from "../errors";
import type { AgentModel } from "./types";

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Environment variable to override the Claude command (for testing) */
const CLAUDE_COMMAND_ENV = "CM_CLAUDE_COMMAND";

/**
 * Get the Claude command to use (supports override for testing)
 */
function getClaudeCommand(): string {
  return process.env[CLAUDE_COMMAND_ENV] || "claude";
}

/** Result from a Claude CLI invocation */
export interface ClaudeResult {
  /** Exit code from the process */
  exitCode: number;
  /** Stdout output */
  stdout: string;
  /** Stderr output */
  stderr: string;
  /** Whether execution was successful */
  success: boolean;
}

/** Options for running Claude CLI */
export interface ClaudeRunOptions {
  /** The prompt to send */
  prompt: string;
  /** Agent model to use */
  agent?: AgentModel;
  /** Allowed tools */
  allowedTools?: string[];
  /** Working directory */
  cwd: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Step name (for error messages) */
  stepName?: string;
  /** Additional system prompt to append */
  appendSystemPrompt?: string;
  /** Task ID for completion tracking */
  taskId?: string;
  /** Step name for completion tracking */
  taskStepName?: string;
  /** Attempt number for completion tracking */
  taskStepAttempt?: number;
}

/**
 * Map agent model name to Claude CLI model flag
 */
function mapAgentToModel(agent: AgentModel): string {
  switch (agent) {
    case "opus":
      return "opus";
    case "sonnet":
      return "sonnet";
    case "haiku":
      return "haiku";
    default:
      return "sonnet";
  }
}

/**
 * Run Claude CLI with the given options
 */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeResult> {
  const {
    prompt,
    agent,
    allowedTools,
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    stepName = "step",
    appendSystemPrompt,
    taskId,
    taskStepName,
    taskStepAttempt,
  } = options;

  // Build command arguments
  const claudeCmd = getClaudeCommand();
  const args: string[] = [claudeCmd, "-p", prompt, "--output-format", "json"];

  if (agent) {
    args.push("--model", mapAgentToModel(agent));
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  // Build environment with task context
  const env: Record<string, string | undefined> = {
    ...process.env,
    // Ensure non-interactive mode
    CI: "true",
  };

  // Add task context env vars for completion tracking
  if (taskId) {
    env.CM_TASK_ID = taskId;
  }
  if (taskStepName) {
    env.CM_STEP_NAME = taskStepName;
  }
  if (taskStepAttempt !== undefined) {
    env.CM_STEP_ATTEMPT = String(taskStepAttempt);
  }

  // Start the process
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Set up timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new StepTimeoutError(stepName, timeout));
    }, timeout);
  });

  try {
    // Wait for process to complete or timeout
    const [stdout, stderr] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
    ]);

    const exitCode = await proc.exited;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return {
      exitCode,
      stdout,
      stderr,
      success: exitCode === 0,
    };
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (error instanceof StepTimeoutError) {
      throw error;
    }

    throw new ClaudeExecutionError(-1, (error as Error).message);
  }
}

/**
 * Parse JSON output from Claude CLI
 */
export function parseClaudeOutput(stdout: string): {
  result?: string;
  error?: string;
} {
  try {
    // Claude outputs JSON with a "result" field
    const parsed = JSON.parse(stdout);
    return {
      result: parsed.result || parsed.message || stdout,
    };
  } catch {
    // If not valid JSON, return raw output
    return {
      result: stdout,
    };
  }
}
