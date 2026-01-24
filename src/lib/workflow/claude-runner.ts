/**
 * Claude CLI subprocess runner
 */

import { ClaudeExecutionError, StepTimeoutError } from "../errors";
import type { Model } from "./types";

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

/** Callback for streaming output */
export type StreamCallback = (chunk: string) => void;

/** Options for running Claude CLI */
export interface ClaudeRunOptions {
  /** The prompt to send */
  prompt: string;
  /** Model to use */
  model?: Model;
  /** Agent to use (path in .claude/agents/, passed via --agent flag) */
  agent?: string;
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
  /** Enable streaming output */
  stream?: boolean;
  /** Callback for streaming output (called with each text chunk) */
  onStream?: StreamCallback;
}

/**
 * Map model name to Claude CLI model flag
 */
function mapModelToCliFlag(model: Model): string {
  switch (model) {
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
 * Format a tool use event for display
 */
function formatToolUse(toolName: string, input: unknown): string {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  // Truncate long inputs
  const maxLen = 500;
  const truncated = inputStr.length > maxLen ? inputStr.slice(0, maxLen) + "..." : inputStr;
  return `\n── ${toolName} ──\n${truncated}\n`;
}

/**
 * Format a tool result event for display
 */
function formatToolResult(content: unknown): string {
  if (typeof content === "string") {
    const maxLen = 1000;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
    return `${truncated}\n────\n`;
  }
  if (Array.isArray(content)) {
    // Handle content blocks (text, images, etc.)
    return content
      .map((block) => {
        if (block.type === "text") return block.text;
        return `[${block.type}]`;
      })
      .join("\n") + "\n────\n";
  }
  return JSON.stringify(content, null, 2) + "\n────\n";
}

/**
 * Process streaming JSON output from Claude CLI
 * Logs all events including tool usage
 */
async function processStreamingOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onStream?: StreamCallback
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Handle different event types
        if (event.type === "assistant" && event.message?.content) {
          // Assistant message with content blocks
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              fullOutput += block.text;
              onStream?.(block.text);
            } else if (block.type === "tool_use") {
              const formatted = formatToolUse(block.name, block.input);
              onStream?.(formatted);
            }
          }
        } else if (event.type === "content_block_delta") {
          // Streaming delta
          if (event.delta?.type === "text_delta" && event.delta?.text) {
            fullOutput += event.delta.text;
            onStream?.(event.delta.text);
          }
        } else if (event.type === "user" && event.message?.content) {
          // Tool results come back as user messages
          for (const block of event.message.content) {
            if (block.type === "tool_result") {
              const formatted = formatToolResult(block.content);
              onStream?.(formatted);
            }
          }
        } else if (event.type === "result") {
          // Final result
          if (event.result) {
            fullOutput = event.result;
          }
        }
      } catch {
        // Not JSON, might be raw output
        fullOutput += line + "\n";
        onStream?.(line + "\n");
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (event.type === "result" && event.result) {
        fullOutput = event.result;
      }
    } catch {
      fullOutput += buffer;
      onStream?.(buffer);
    }
  }

  return fullOutput;
}

/**
 * Run Claude CLI with the given options
 */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeResult> {
  const {
    prompt,
    model,
    agent,
    allowedTools,
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    stepName = "step",
    appendSystemPrompt,
    taskId,
    taskStepName,
    taskStepAttempt,
    stream = false,
    onStream,
  } = options;

  // Build command arguments
  const claudeCmd = getClaudeCommand();
  const outputFormat = stream ? "stream-json" : "json";
  const args: string[] = [claudeCmd, "-p", prompt, "--output-format", outputFormat];

  // stream-json requires --verbose when using -p
  if (stream) {
    args.push("--verbose");
  }

  // Default to opus if no model specified
  args.push("--model", mapModelToCliFlag(model || "opus"));

  if (agent) {
    args.push("--agent", agent);
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
    let stdout: string;
    let stderr: string;

    if (stream && onStream) {
      // Stream stdout while capturing stderr
      const reader = proc.stdout.getReader();
      const [streamedOutput, stderrOutput] = await Promise.race([
        Promise.all([
          processStreamingOutput(reader, onStream),
          new Response(proc.stderr).text(),
        ]),
        timeoutPromise,
      ]);
      stdout = streamedOutput;
      stderr = stderrOutput;
    } else {
      // Buffer all output
      const [stdoutOutput, stderrOutput] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeoutPromise,
      ]);
      stdout = stdoutOutput;
      stderr = stderrOutput;
    }

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
