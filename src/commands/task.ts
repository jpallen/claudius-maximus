/**
 * Task command with all subcommands for workflow orchestration
 */

import { Command } from "commander";
import {
  createTask,
  listTasks,
  getTask,
  deleteTask,
  cancelTask,
  startTask,
  resumeTask,
  markStepComplete,
  markStepFailed,
} from "../lib/task/manager";
import { findAndLoadConfig, getWorkflow } from "../lib/workflow/loader";
import { executeWorkflow, executeNextStep } from "../lib/workflow/executor";
import { findGitRoot } from "../lib/task/worktree";
import {
  CmError,
  ConfigNotFoundError,
  TaskNotFoundError,
  NotInGitRepoError,
} from "../lib/errors";
import type { TaskStatus } from "../lib/task/types";

/** Format a date string for display */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

/** Get a status emoji/indicator */
function statusIndicator(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "running":
      return "●";
    case "paused":
      return "◐";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return "?";
  }
}

/** Handle errors consistently */
function handleError(error: unknown): never {
  if (error instanceof CmError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${(error as Error).message}`);
  }
  process.exit(1);
}

export function createTaskCommand(): Command {
  const task = new Command("task").description(
    "Manage workflow tasks with git worktrees"
  );

  // cm task create "description" [--workflow <name>] [--no-start]
  task
    .command("create <description>")
    .description("Create a new task and optionally run it")
    .option("-w, --workflow <name>", "Workflow to use", "default")
    .option("--no-start", "Create task without starting execution")
    .action(async (description: string, options) => {
      try {
        // Find git root
        const repoPath = await findGitRoot(process.cwd());

        // Load config
        const { config } = await findAndLoadConfig(repoPath);

        // Get workflow
        const workflowName = options.workflow;
        const workflow = getWorkflow(config, workflowName);

        console.log(`Creating task: "${description}"`);
        console.log(`Workflow: ${workflowName} (${workflow.steps.length} steps)`);

        // Create the task
        const newTask = await createTask(
          workflow,
          workflowName,
          { description },
          repoPath
        );

        console.log(`Task created: ${newTask.id}`);
        console.log(`Worktree: ${newTask.worktreePath}`);

        // Start execution if requested
        if (options.start !== false) {
          console.log("\nStarting workflow execution...\n");

          await startTask(newTask.id);
          const updatedTask = await getTask(newTask.id);
          const result = await executeWorkflow(updatedTask, workflow, config);

          console.log(`\nWorkflow ${result.status}`);
          if (result.stepsCompleted > 0) {
            console.log(`Steps completed: ${result.stepsCompleted}`);
          }

          if (result.status === "paused") {
            console.log(
              `\nTask is paused. Resume with: cm task resume ${newTask.id} --prompt "..."`
            );
          } else if (result.status === "failed") {
            console.log(`Error: ${result.error}`);
          }
        } else {
          console.log(`\nTask created but not started.`);
          console.log(`Run with: cm task run ${newTask.id}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task list
  task
    .command("list")
    .alias("ls")
    .description("List all tasks")
    .action(async () => {
      try {
        const tasks = await listTasks();

        if (tasks.length === 0) {
          console.log("No tasks found.");
          return;
        }

        console.log("Tasks:\n");

        for (const t of tasks) {
          const indicator = statusIndicator(t.status);
          const progress = `${t.currentStep}/${t.totalSteps}`;
          console.log(`  ${indicator} ${t.id} [${t.status}] ${progress}`);
          console.log(`    ${t.description}`);
          console.log(`    Created: ${formatDate(t.createdAt)}`);
          console.log("");
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task status [id]
  task
    .command("status [id]")
    .description("Show task status (all tasks if no ID given)")
    .action(async (taskId?: string) => {
      try {
        if (!taskId) {
          // Show summary of all tasks
          const tasks = await listTasks();

          if (tasks.length === 0) {
            console.log("No tasks found.");
            return;
          }

          console.log("Task Status Summary:\n");

          const byStatus = {
            running: tasks.filter((t) => t.status === "running"),
            paused: tasks.filter((t) => t.status === "paused"),
            pending: tasks.filter((t) => t.status === "pending"),
            completed: tasks.filter((t) => t.status === "completed"),
            failed: tasks.filter((t) => t.status === "failed"),
            cancelled: tasks.filter((t) => t.status === "cancelled"),
          };

          for (const [status, statusTasks] of Object.entries(byStatus)) {
            if (statusTasks.length > 0) {
              console.log(
                `${status.toUpperCase()} (${statusTasks.length}):`
              );
              for (const t of statusTasks) {
                console.log(`  - ${t.id}: ${t.description.slice(0, 50)}`);
              }
              console.log("");
            }
          }
          return;
        }

        // Show detailed status for a specific task
        const t = await getTask(taskId);

        console.log(`Task: ${t.id}`);
        console.log(`Status: ${t.status}`);
        console.log(`Description: ${t.description}`);
        console.log(`Workflow: ${t.workflow}`);
        console.log(`Worktree: ${t.worktreePath}`);
        console.log(`Created: ${formatDate(t.createdAt)}`);

        if (t.startedAt) {
          console.log(`Started: ${formatDate(t.startedAt)}`);
        }
        if (t.endedAt) {
          console.log(`Ended: ${formatDate(t.endedAt)}`);
        }
        if (t.error) {
          console.log(`Error: ${t.error}`);
        }

        console.log(`\nSteps (${t.currentStep}/${t.steps.length}):\n`);

        for (let i = 0; i < t.steps.length; i++) {
          const step = t.steps[i];
          const indicator =
            i === t.currentStep && t.status === "running"
              ? "→"
              : statusIndicator(step.status as TaskStatus);
          const agentInfo = step.agent ? ` [${step.agent}]` : "";

          console.log(`  ${indicator} ${i + 1}. ${step.name}${agentInfo}`);

          if (step.error) {
            console.log(`     Error: ${step.error}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task run <id>
  task
    .command("run <id>")
    .description("Run all remaining steps of a task")
    .action(async (taskId: string) => {
      try {
        // Load task
        let t = await getTask(taskId);

        if (t.status === "completed") {
          console.log(`Task ${taskId} is already completed.`);
          return;
        }

        if (t.status === "cancelled") {
          console.log(`Task ${taskId} was cancelled.`);
          return;
        }

        if (t.status === "failed") {
          console.log(`Task ${taskId} has failed. Delete and recreate it.`);
          return;
        }

        // Find git root and load config
        const { config } = await findAndLoadConfig(t.repoPath);
        const workflow = getWorkflow(config, t.workflow);

        // Start or resume the task
        if (t.status === "pending" || t.status === "paused") {
          t = await startTask(taskId);
        }

        console.log(`Running task: ${taskId}`);
        console.log(`Starting from step ${t.currentStep + 1}/${workflow.steps.length}\n`);

        const result = await executeWorkflow(t, workflow, config);

        console.log(`\nWorkflow ${result.status}`);
        if (result.stepsCompleted > 0) {
          console.log(`Steps completed: ${result.stepsCompleted}`);
        }

        if (result.status === "paused") {
          console.log(
            `\nTask is paused. Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.status === "failed") {
          console.log(`Error: ${result.error}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task step <id>
  task
    .command("step <id>")
    .description("Run just the next step of a task")
    .action(async (taskId: string) => {
      try {
        // Load task
        let t = await getTask(taskId);

        if (t.status === "completed") {
          console.log(`Task ${taskId} is already completed.`);
          return;
        }

        if (t.status === "cancelled") {
          console.log(`Task ${taskId} was cancelled.`);
          return;
        }

        if (t.status === "failed") {
          console.log(`Task ${taskId} has failed. Delete and recreate it.`);
          return;
        }

        // Find git root and load config
        const { config } = await findAndLoadConfig(t.repoPath);
        const workflow = getWorkflow(config, t.workflow);

        if (t.currentStep >= workflow.steps.length) {
          console.log(`Task ${taskId} has no more steps to run.`);
          return;
        }

        // Start or resume the task
        if (t.status === "pending" || t.status === "paused") {
          t = await startTask(taskId);
        }

        const currentStep = workflow.steps[t.currentStep];
        console.log(
          `Running step ${t.currentStep + 1}/${workflow.steps.length}: ${currentStep.name}`
        );

        const result = await executeNextStep(t, workflow, config);

        if (result.shouldPause) {
          console.log(`\nStep requires user input.`);
          console.log(
            `Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.success) {
          console.log(`\nStep completed successfully.`);

          // Check if there are more steps
          const updatedTask = await getTask(taskId);
          if (updatedTask.currentStep >= workflow.steps.length) {
            console.log(`Task completed!`);
          } else {
            console.log(
              `Next step: ${workflow.steps[updatedTask.currentStep].name}`
            );
          }
        } else {
          console.log(`\nStep failed: ${result.error}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task resume <id> --prompt "..."
  task
    .command("resume <id>")
    .description("Resume a paused task with user input")
    .option("-p, --prompt <prompt>", "Prompt to provide for the paused step")
    .action(async (taskId: string, options) => {
      try {
        let t = await getTask(taskId);

        if (t.status !== "paused") {
          console.log(
            `Task ${taskId} is not paused (status: ${t.status}).`
          );
          return;
        }

        if (!options.prompt) {
          console.log(`Please provide a prompt with --prompt "..."`);
          return;
        }

        // Resume with prompt
        t = await resumeTask(taskId, options.prompt);

        // Find git root and load config
        const { config } = await findAndLoadConfig(t.repoPath);
        const workflow = getWorkflow(config, t.workflow);

        console.log(`Resuming task: ${taskId}`);
        console.log(
          `Current step: ${t.currentStep + 1}/${workflow.steps.length}\n`
        );

        const result = await executeWorkflow(t, workflow, config);

        console.log(`\nWorkflow ${result.status}`);
        if (result.stepsCompleted > 0) {
          console.log(`Steps completed: ${result.stepsCompleted}`);
        }

        if (result.status === "paused") {
          console.log(
            `\nTask is paused again. Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.status === "failed") {
          console.log(`Error: ${result.error}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task cancel <id>
  task
    .command("cancel <id>")
    .description("Cancel a running or pending task")
    .action(async (taskId: string) => {
      try {
        const t = await cancelTask(taskId);
        console.log(`Task ${taskId} cancelled.`);
        console.log(`Worktree preserved at: ${t.worktreePath}`);
        console.log(`Delete with: cm task delete ${taskId}`);
      } catch (error) {
        handleError(error);
      }
    });

  // cm task delete <id>
  task
    .command("delete <id>")
    .description("Delete a task and its worktree")
    .option("-f, --force", "Force delete without confirmation")
    .action(async (taskId: string, options) => {
      try {
        const t = await getTask(taskId);

        if (t.status === "running" && !options.force) {
          console.log(
            `Task ${taskId} is still running. Use --force to delete anyway.`
          );
          return;
        }

        await deleteTask(taskId);
        console.log(`Task ${taskId} deleted.`);
        console.log(`Worktree and branch removed.`);
      } catch (error) {
        handleError(error);
      }
    });

  // cm task complete --message "..."
  task
    .command("complete")
    .description("Mark current step attempt as successfully completed")
    .option("-m, --message <message>", "Completion summary")
    .action(async (options) => {
      try {
        const taskId = process.env.CM_TASK_ID;
        const stepName = process.env.CM_STEP_NAME;
        const attemptStr = process.env.CM_STEP_ATTEMPT;

        if (!taskId || !stepName || !attemptStr) {
          console.error(
            "Not running in a task context (missing CM_TASK_ID, CM_STEP_NAME, or CM_STEP_ATTEMPT)"
          );
          process.exit(1);
        }

        const attempt = parseInt(attemptStr, 10);
        if (isNaN(attempt) || attempt < 1) {
          console.error(`Invalid attempt number: ${attemptStr}`);
          process.exit(1);
        }

        await markStepComplete(taskId, stepName, attempt, options.message);
        console.log(`Step "${stepName}" attempt ${attempt} marked complete.`);
      } catch (error) {
        handleError(error);
      }
    });

  // cm task fail --reason "..."
  task
    .command("fail")
    .description("Mark current step attempt as failed")
    .requiredOption("-r, --reason <reason>", "Failure reason")
    .action(async (options) => {
      try {
        const taskId = process.env.CM_TASK_ID;
        const stepName = process.env.CM_STEP_NAME;
        const attemptStr = process.env.CM_STEP_ATTEMPT;

        if (!taskId || !stepName || !attemptStr) {
          console.error(
            "Not running in a task context (missing CM_TASK_ID, CM_STEP_NAME, or CM_STEP_ATTEMPT)"
          );
          process.exit(1);
        }

        const attempt = parseInt(attemptStr, 10);
        if (isNaN(attempt) || attempt < 1) {
          console.error(`Invalid attempt number: ${attemptStr}`);
          process.exit(1);
        }

        await markStepFailed(taskId, stepName, attempt, options.reason);
        console.log(`Step "${stepName}" attempt ${attempt} marked failed.`);
      } catch (error) {
        handleError(error);
      }
    });

  return task;
}
