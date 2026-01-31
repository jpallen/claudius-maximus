/**
 * Tmux session launcher - re-launch cm inside tmux
 */

import { CLI_NAME } from "../constants";

/**
 * Launch a new tmux session with cm running inside
 * This replaces the current process with tmux
 */
export async function launchInTmux(): Promise<void> {
  const sessionName = `${CLI_NAME}-main`;

  // Get the path to the current executable
  const cmCommand = process.argv[0];

  // Build the command that will run inside tmux
  // We pass the original args (minus the node/bun path)
  const args = process.argv.slice(1);
  const innerCommand = [cmCommand, ...args].map(arg => {
    // Quote arguments that contain spaces
    if (arg.includes(" ")) {
      return `"${arg}"`;
    }
    return arg;
  }).join(" ");

  // Check if our session already exists
  const checkProc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const sessionExists = (await checkProc.exited) === 0;

  if (sessionExists) {
    // Attach to existing session
    const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  } else {
    // Create new session and run cm inside it
    // Use bash -c to properly execute the command string
    const proc = Bun.spawn([
      "tmux",
      "new-session",
      "-s", sessionName,
      "-n", "cm",
      "bash", "-c", innerCommand,
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
}

/**
 * Kill the cm tmux session
 */
export async function killTmuxSession(): Promise<boolean> {
  const sessionName = `${CLI_NAME}-main`;

  try {
    const proc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
