/**
 * Tmux window management for Claude sessions
 */

import type { Task } from "../task/types";

/**
 * Create a new tmux window for a Claude session
 * @param task - The task to create a window for
 * @param workflowSystemPrompt - Optional system prompt for workflow mode
 * @returns The window name
 */
export async function createClaudeWindow(
  task: Task,
  workflowSystemPrompt?: string
): Promise<string> {
  const windowName = `claude-${task.id}`;
  const claudeCommand = process.env.CM_CLAUDE_COMMAND || "claude";

  // Build the claude command with prompt and optional agent
  // Escape the prompt for shell
  const escapedPrompt = task.prompt.replace(/'/g, "'\\''");

  let claudeCmd = `${claudeCommand}`;
  if (task.agent) {
    claudeCmd += ` --agent '${task.agent}'`;
  }

  // Handle workflow system prompt - write to temp file to avoid shell escaping issues
  let tempPromptPath: string | undefined;
  if (workflowSystemPrompt) {
    tempPromptPath = `/tmp/cm-workflow-${task.id}.txt`;
    await Bun.write(tempPromptPath, workflowSystemPrompt);
    claudeCmd += ` --append-system-prompt "$(cat '${tempPromptPath}')"`;
  }

  // Pass the prompt as a positional argument
  claudeCmd += ` '${escapedPrompt}'`;

  // Create new window, cd to worktree, then run claude with prompt
  const shellCommand = `cd "${task.worktreePath}" && ${claudeCmd}`;

  const proc = Bun.spawn([
    "tmux",
    "new-window",
    "-n", windowName,
    "-d", // Don't switch to it yet
    "bash", "-c", shellCommand,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create tmux window: ${stderr}`);
  }

  return windowName;
}

/**
 * Send the initial prompt to a Claude window
 * @param windowName - The tmux window name
 * @param prompt - The initial prompt to send
 */
export async function sendPromptToWindow(windowName: string, prompt: string): Promise<void> {
  // Wait for Claude to start up - it needs time to initialize
  await Bun.sleep(2000);

  // Send the prompt text literally (without interpreting special chars)
  const textProc = Bun.spawn([
    "tmux",
    "send-keys",
    "-t", windowName,
    "-l", // Literal mode - don't interpret special characters
    prompt,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let exitCode = await textProc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(textProc.stderr).text();
    throw new Error(`Failed to send prompt text to window: ${stderr}`);
  }

  // Small delay between text and Enter
  await Bun.sleep(100);

  // Send Enter key separately (not in literal mode)
  const enterProc = Bun.spawn([
    "tmux",
    "send-keys",
    "-t", windowName,
    "Enter",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  exitCode = await enterProc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(enterProc.stderr).text();
    throw new Error(`Failed to send Enter key to window: ${stderr}`);
  }
}

/**
 * Focus (select) a tmux window
 * @param windowName - The tmux window name to focus
 */
export async function focusWindow(windowName: string): Promise<void> {
  const proc = Bun.spawn([
    "tmux",
    "select-window",
    "-t", windowName,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to focus window: ${stderr}`);
  }
}

/**
 * Check if a tmux window exists
 * @param windowName - The tmux window name to check
 */
export async function windowExists(windowName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      "tmux",
      "list-windows",
      "-F", "#W",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return false;
    }

    const stdout = await new Response(proc.stdout).text();
    const windows = stdout.trim().split("\n");
    return windows.includes(windowName);
  } catch {
    return false;
  }
}

/**
 * Kill a tmux window
 * @param windowName - The tmux window name to kill
 */
export async function killWindow(windowName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      "tmux",
      "kill-window",
      "-t", windowName,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * List all Claude windows (windows starting with "claude-")
 */
export async function listClaudeWindows(): Promise<string[]> {
  try {
    const proc = Bun.spawn([
      "tmux",
      "list-windows",
      "-F", "#W",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return [];
    }

    const stdout = await new Response(proc.stdout).text();
    const windows = stdout.trim().split("\n").filter(Boolean);
    return windows.filter(w => w.startsWith("claude-"));
  } catch {
    return [];
  }
}
