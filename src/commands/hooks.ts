/**
 * Hooks commands for Claude Code integration
 */

import { Command } from "commander";
import {
  getUncommittedChanges,
  detectTaskFromCwd,
} from "../lib/task/worktree";
import { UncommittedChangesError } from "../lib/errors";

export function createHooksCommand(): Command {
  const hooks = new Command("hooks")
    .description("Claude Code hook commands");

  // cm hooks stop
  hooks
    .command("stop")
    .description("Stop hook - verify clean git state before Claude stops")
    .action(async () => {
      await handleStopHook();
    });

  return hooks;
}

/**
 * Handle the stop hook logic
 *
 * This is called by Claude Code's stop hook mechanism.
 * - If not in a task worktree: exit 0 (not relevant)
 * - If git state is clean: exit 0 (allow stop)
 * - If git state is dirty: exit 2 with error message to stderr
 *
 * IMPORTANT: This command implements fail-open behavior. If any detection
 * or checking fails for any reason, we exit 0 to allow Claude to stop.
 * We never want internal errors to block Claude from stopping.
 */
async function handleStopHook(): Promise<void> {
  const cwd = process.cwd();

  // Wrap the entire detection and checking logic in try-catch for fail-open behavior
  try {
    // Check if we're in a task worktree
    const taskInfo = await detectTaskFromCwd(cwd);

    if (!taskInfo) {
      // Not in a CM task worktree - this hook doesn't apply
      // Exit silently with success
      process.exit(0);
    }

    // Check for uncommitted changes
    const changes = await getUncommittedChanges(cwd);

    if (!changes.hasChanges) {
      // Clean state - allow Claude to stop
      process.exit(0);
    }

    // Dirty state - block Claude from stopping
    const error = new UncommittedChangesError(
      changes.staged,
      changes.unstaged,
      changes.untracked
    );

    // Write error message to stderr (Claude receives this as feedback)
    console.error(error.message);
    process.exit(2);
  } catch (error) {
    // If detection fails for any reason, allow stop
    // (don't block Claude due to internal errors)
    console.error(`Warning: Could not detect task context: ${error}`);
    process.exit(0);
  }
}
