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
 * Format tool input for display (tool-specific formatting)
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": {
      const desc = input.description ? `# ${input.description}\n` : "";
      return `\n${desc}$ ${input.command}\n`;
    }

    case "Read":
      return `\nRead: ${input.file_path}\n`;

    case "Glob":
      return `\nGlob: ${input.pattern}${input.path ? ` in ${input.path}` : ""}\n`;

    case "Grep":
      return `\nGrep: "${input.pattern}"${input.path ? ` in ${input.path}` : ""}\n`;

    case "Edit":
      return `\nEdit: ${input.file_path}\n`;

    case "Write":
      return `\nWrite: ${input.file_path}\n`;

    case "Task":
      return `\nTask: ${input.description || "agent"}\n`;

    case "AskUserQuestion": {
      const questions = input.questions as Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>;
      if (!questions?.length) return "\n? (asking user)\n";

      let output = "\n";
      for (const q of questions) {
        output += `? ${q.question}\n`;
        if (q.options?.length) {
          for (const opt of q.options) {
            output += `  - ${opt.label}\n`;
          }
        }
      }
      return output;
    }

    default:
      return `\n-- ${toolName} --\n`;
  }
}

/**
 * Format generic result content (fallback for unhandled tools)
 */
function formatGenericResult(content: unknown): string {
  if (typeof content === "string") {
    const maxLen = 500;
    const truncated = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
    return `${truncated}\n`;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === "text") return block.text;
        return `[${block.type}]`;
      })
      .join("\n") + "\n";
  }
  return "";
}

/**
 * Format tool output for display (tool-specific formatting)
 */
function formatToolOutput(
  toolName: string,
  content: unknown,
  toolUseResult?: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      // Use rich metadata if available
      if (toolUseResult) {
        let output = "";
        if (toolUseResult.stdout) output += toolUseResult.stdout;
        if (toolUseResult.stderr) output += toolUseResult.stderr;
        return output ? `${String(output).trimEnd()}\n` : "";
      }
      return formatGenericResult(content);

    case "Read":
      // Don't show file contents, just acknowledge
      if (toolUseResult && typeof toolUseResult.numLines === "number") {
        return `(${toolUseResult.numLines} lines)\n`;
      }
      return "(file read)\n";

    case "Glob":
      if (toolUseResult && typeof toolUseResult.numFiles === "number") {
        return `Found ${toolUseResult.numFiles} files\n`;
      }
      return formatGenericResult(content);

    case "Grep":
      // Show match count
      if (typeof content === "string") {
        const lines = content.split("\n").filter(Boolean);
        return `Found ${lines.length} matches\n`;
      }
      return formatGenericResult(content);

    case "Edit":
    case "Write":
      return "done\n";

    case "Task":
      return "(agent completed)\n";

    case "AskUserQuestion": {
      // Parse the answer from content like:
      // 'User has answered your questions: "question"="answer". You can now continue...'
      if (typeof content === "string") {
        // Extract answer(s) from the format: "question"="answer"
        const matches = content.matchAll(/"[^"]+?"="([^"]+?)"/g);
        const answers = [...matches].map((m) => m[1]);
        if (answers.length > 0) {
          return `> ${answers.join(", ")}\n`;
        }
        // Fallback: show abbreviated content
        const maxLen = 100;
        const truncated = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;
        return `> ${truncated}\n`;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            return `> ${block.text}\n`;
          }
        }
      }
      return "(answered)\n";
    }

    default:
      return formatGenericResult(content);
  }
}

/**
 * Process streaming JSON output from Claude CLI
 * Logs all events including tool usage with tool-specific formatting
 */
async function processStreamingOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onStream?: StreamCallback
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";

  // Track tool names by their ID to match results with their tool
  const toolNames = new Map<string, string>();

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
              // Track tool name by ID for later result matching
              if (block.id) {
                toolNames.set(block.id, block.name);
              }
              const formatted = formatToolInput(block.name, block.input || {});
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
              // Look up tool name by ID
              const toolName = block.tool_use_id ? toolNames.get(block.tool_use_id) : undefined;
              const formatted = formatToolOutput(
                toolName || "unknown",
                block.content,
                block.tool_use_result as Record<string, unknown> | undefined
              );
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
