/**
 * System commands (internal use)
 */

import { Command } from "commander";
import { loadAttempt, saveOrchestratorDecision, loadOrchestratorDecision } from "../lib/task/manager";
import type { OrchestratorDecision } from "../lib/task/types";

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

  // cm system orchestrator-decision - Called by Claude orchestrator to specify next action
  system
    .command("orchestrator-decision")
    .description("Called by Claude orchestrator to specify next action")
    .option("--step <name>", "Step to execute next")
    .option("--need-input", "Request human input")
    .option("--question <question>", "Question for the human")
    .option("--complete", "Mark workflow as complete")
    .option("--summary <summary>", "Completion summary")
    .option("--fail", "Mark workflow as failed")
    .option("--reason <reason>", "Reason for decision or failure")
    .action(async (options) => {
      const taskId = process.env.CM_TASK_ID;
      if (!taskId) {
        console.error("Error: Not running in orchestrator context (CM_TASK_ID not set)");
        process.exit(1);
      }

      // Build decision based on options
      let decision: OrchestratorDecision;

      if (options.step) {
        decision = {
          type: "run_step",
          stepName: options.step,
          reason: options.reason,
        };
      } else if (options.needInput) {
        if (!options.question) {
          console.error("Error: --need-input requires --question");
          process.exit(1);
        }
        decision = {
          type: "need_input",
          question: options.question,
        };
      } else if (options.complete) {
        decision = {
          type: "complete",
          summary: options.summary || "Workflow completed",
        };
      } else if (options.fail) {
        decision = {
          type: "fail",
          reason: options.reason || "Workflow failed",
        };
      } else {
        console.error("Error: Must specify one of --step, --need-input, --complete, or --fail");
        process.exit(1);
      }

      await saveOrchestratorDecision(taskId, decision);
      console.log(JSON.stringify({ status: "recorded", decision }));
      process.exit(0);
    });

  // cm system orchestrator-stop-hook - Called by Claude Stop hook in orchestrator mode
  system
    .command("orchestrator-stop-hook")
    .description("Called by Claude Stop hook in orchestrator mode")
    .action(async () => {
      const taskId = process.env.CM_TASK_ID;

      // Not a managed orchestrator session - allow exit
      if (!taskId) {
        process.exit(0);
      }

      try {
        const decision = await loadOrchestratorDecision(taskId);

        // Decision was made - allow exit
        if (decision) {
          process.exit(0);
        }

        // No decision - block exit with instructions
        console.log(
          JSON.stringify({
            decision: "block",
            reason: `No orchestrator decision made. Run one of:
  cm system orchestrator-decision --step "<step-name>"
  cm system orchestrator-decision --need-input --question "your question"
  cm system orchestrator-decision --complete --summary "what was accomplished"
  cm system orchestrator-decision --fail --reason "why it cannot proceed"`,
          })
        );

        process.exit(2);
      } catch (error) {
        // Error loading decision - block exit as safety measure
        console.log(
          JSON.stringify({
            decision: "block",
            reason: `Cannot verify orchestrator decision: ${(error as Error).message}`,
          })
        );

        process.exit(2);
      }
    });

  return system;
}
