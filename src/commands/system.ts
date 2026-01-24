/**
 * System commands (internal use)
 */

import { Command } from "commander";
import { loadAttempt } from "../lib/task/manager";

export function createSystemCommand(): Command {
  const system = new Command("system").description("Internal system commands");

  // cm system stop-hook
  system
    .command("stop-hook")
    .description("Called by Claude Stop hook to verify step completion")
    .action(async () => {
      const taskId = process.env.CM_TASK_ID;
      const stepName = process.env.CM_STEP_NAME;
      const attemptStr = process.env.CM_STEP_ATTEMPT;

      // Not a managed task session - allow exit
      if (!taskId || !stepName || !attemptStr) {
        process.exit(0);
      }

      const attempt = parseInt(attemptStr, 10);
      if (isNaN(attempt) || attempt < 1) {
        // Invalid attempt - allow exit (shouldn't happen)
        process.exit(0);
      }

      try {
        // Load the attempt file
        const attemptData = await loadAttempt(taskId, stepName, attempt);

        // Attempt already marked - allow exit
        if (attemptData.explicitlyCompleted || attemptData.explicitlyFailed) {
          process.exit(0);
        }

        // Not marked - block exit with instructions
        // Output JSON to block Claude from stopping
        console.log(
          JSON.stringify({
            decision: "block",
            reason: `Step "${stepName}" not marked complete. Run one of:\n  cm task complete --message "summary"\n  cm task fail --reason "what went wrong"`,
          })
        );

        process.exit(2); // Non-zero to indicate blocking
      } catch (error) {
        // If we can't load the attempt file, block exit as a safety measure
        console.log(
          JSON.stringify({
            decision: "block",
            reason: `Cannot verify step completion: ${(error as Error).message}. Run one of:\n  cm task complete --message "summary"\n  cm task fail --reason "what went wrong"`,
          })
        );

        process.exit(2);
      }
    });

  return system;
}
