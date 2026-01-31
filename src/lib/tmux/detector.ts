/**
 * Tmux detection utilities
 */

/**
 * Check if we're currently running inside a tmux session
 */
export function isInTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Check if tmux is installed and available in PATH
 */
export async function isTmuxInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "tmux"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the current tmux session name (if in tmux)
 */
export async function getCurrentTmuxSession(): Promise<string | null> {
  if (!isInTmux()) {
    return null;
  }

  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "#S"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the current tmux window name (if in tmux)
 */
export async function getCurrentTmuxWindow(): Promise<string | null> {
  if (!isInTmux()) {
    return null;
  }

  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "#W"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
