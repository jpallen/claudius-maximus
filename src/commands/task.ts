/**
 * Task command with all subcommands for workflow orchestration
 */

import { Command } from "commander";
import * as readline from "readline";
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
import {
  executeWorkflow,
  executeNextStep,
  type ExecutionOptions,
} from "../lib/workflow/executor";
import {
  findGitRoot,
  hasCommitsToMerge,
  getTaskCommitSummary,
  mergeTaskBranch,
  removeWorktree,
} from "../lib/task/worktree";
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

/** Prompt user for input */
async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

/** Check if running in interactive mode */
function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/** Handle merge prompt after task completion */
async function handleMergePrompt(
  taskId: string,
  repoPath: string,
  baseBranch: string
): Promise<void> {
  // Check if there are commits to merge
  const hasCommits = await hasCommitsToMerge(repoPath, taskId, baseBranch);
  if (!hasCommits) {
    console.log(`\nNo commits to merge to ${baseBranch}.`);
    return;
  }

  // Get commit summary
  const commits = await getTaskCommitSummary(repoPath, taskId, baseBranch);
  console.log(`\nTask completed with ${commits.length} commit(s):`);
  for (const commit of commits) {
    console.log(`  ${commit.hash} ${commit.subject}`);
  }

  // Skip prompt if not interactive
  if (!isInteractive()) {
    console.log(`\nRun 'cm task merge ${taskId}' to merge to ${baseBranch}.`);
    return;
  }

  console.log(`\nWhat would you like to do?`);
  console.log(`  [m] Merge to ${baseBranch}`);
  console.log(`  [s] Skip (keep branch for later)`);

  const answer = await promptUser("Choice [m/s]: ");

  if (answer === "m") {
    const result = await mergeTaskBranch(repoPath, taskId, baseBranch);
    if (result.success) {
      console.log(`\nMerged to ${baseBranch} successfully.`);
      console.log(`You can now delete the task with: cm task delete ${taskId}`);
    } else if (result.conflicted) {
      console.log(`\n${result.error}`);
      console.log(`Resolve conflicts manually and then delete the task.`);
    } else {
      console.log(`\nMerge failed: ${result.error}`);
    }
  } else {
    console.log(`\nSkipped. Merge later with: cm task merge ${taskId}`);
  }
}

export function createTaskCommand(): Command {
  const task = new Command("task").description(
    "Manage workflow tasks with git worktrees"
  );

  // cm task create "description" [--workflow <name>] [--branch <name>] [--no-start] [--quiet]
  task
    .command("create <description>")
    .description("Create a new task and optionally run it")
    .option("-w, --workflow <name>", "Workflow to use", "default")
    .option("-b, --branch <name>", "Base branch to create task from")
    .option("--no-start", "Create task without starting execution")
    .option("-q, --quiet", "Suppress streaming output")
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
          { description, baseBranch: options.branch },
          repoPath
        );

        console.log(`Task created: ${newTask.id}`);
        console.log(`Worktree: ${newTask.worktreePath}`);
        console.log(`Base branch: ${newTask.baseBranch}`);

        // Start execution if requested
        if (options.start !== false) {
          await startTask(newTask.id);
          const updatedTask = await getTask(newTask.id);

          const execOptions: ExecutionOptions = {
            stream: !options.quiet,
            verbose: true,
          };

          const result = await executeWorkflow(
            updatedTask,
            workflow,
            config,
            execOptions
          );

          if (result.status === "paused") {
            console.log(
              `\nTask is paused. Resume with: cm task resume ${newTask.id} --prompt "..."`
            );
          } else if (result.status === "failed") {
            console.log(`\nWorkflow failed: ${result.error}`);
          } else if (result.status === "completed") {
            // Prompt for merge
            await handleMergePrompt(newTask.id, repoPath, newTask.baseBranch);
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
        console.log(`Base branch: ${t.baseBranch}`);
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
          const modelInfo = step.model ? ` [${step.model}]` : "";
          const agentInfo = step.agent ? ` (agent: ${step.agent})` : "";

          console.log(`  ${indicator} ${i + 1}. ${step.name}${modelInfo}${agentInfo}`);

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
    .option("-q, --quiet", "Suppress streaming output")
    .action(async (taskId: string, options) => {
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

        const execOptions: ExecutionOptions = {
          stream: !options.quiet,
          verbose: true,
        };

        const result = await executeWorkflow(t, workflow, config, execOptions);

        if (result.status === "paused") {
          console.log(
            `\nTask is paused. Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.status === "failed") {
          console.log(`\nWorkflow failed: ${result.error}`);
        } else if (result.status === "completed") {
          // Reload task to get baseBranch
          const completedTask = await getTask(taskId);
          await handleMergePrompt(taskId, completedTask.repoPath, completedTask.baseBranch);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // cm task step <id>
  task
    .command("step <id>")
    .description("Run just the next step of a task")
    .option("-q, --quiet", "Suppress streaming output")
    .action(async (taskId: string, options) => {
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

        const execOptions: ExecutionOptions = {
          stream: !options.quiet,
          verbose: true,
        };

        const result = await executeNextStep(t, workflow, config, execOptions);

        if (result.shouldPause) {
          console.log(`\nStep requires user input.`);
          console.log(
            `Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.success) {
          // Check if there are more steps
          const updatedTask = await getTask(taskId);
          if (updatedTask.currentStep >= workflow.steps.length) {
            console.log(`\nTask completed!`);
          } else {
            console.log(
              `\nNext step: ${workflow.steps[updatedTask.currentStep].name}`
            );
          }
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
    .option("-q, --quiet", "Suppress streaming output")
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

        const execOptions: ExecutionOptions = {
          stream: !options.quiet,
          verbose: true,
        };

        const result = await executeWorkflow(t, workflow, config, execOptions);

        if (result.status === "paused") {
          console.log(
            `\nTask is paused again. Resume with: cm task resume ${taskId} --prompt "..."`
          );
        } else if (result.status === "failed") {
          console.log(`\nWorkflow failed: ${result.error}`);
        } else if (result.status === "completed") {
          // Reload task to get baseBranch
          const completedTask = await getTask(taskId);
          await handleMergePrompt(taskId, completedTask.repoPath, completedTask.baseBranch);
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

  // cm task merge <id>
  task
    .command("merge <id>")
    .description("Merge a completed task's branch into its base branch")
    .option("-d, --delete", "Delete the task after successful merge")
    .action(async (taskId: string, options) => {
      try {
        const t = await getTask(taskId);

        if (t.status !== "completed") {
          console.log(
            `Task ${taskId} is not completed (status: ${t.status}).`
          );
          console.log(`Only completed tasks can be merged.`);
          return;
        }

        // Check if there are commits to merge
        const hasCommits = await hasCommitsToMerge(t.repoPath, taskId, t.baseBranch);
        if (!hasCommits) {
          console.log(`No commits to merge to ${t.baseBranch}.`);
          if (options.delete) {
            await deleteTask(taskId);
            console.log(`Task ${taskId} deleted.`);
          }
          return;
        }

        // Get commit summary
        const commits = await getTaskCommitSummary(t.repoPath, taskId, t.baseBranch);
        console.log(`Merging ${commits.length} commit(s) to ${t.baseBranch}:`);
        for (const commit of commits) {
          console.log(`  ${commit.hash} ${commit.subject}`);
        }

        // Perform the merge
        const result = await mergeTaskBranch(t.repoPath, taskId, t.baseBranch);

        if (result.success) {
          console.log(`\nMerged to ${t.baseBranch} successfully.`);
          if (options.delete) {
            await deleteTask(taskId);
            console.log(`Task ${taskId} deleted.`);
          } else {
            console.log(`Delete the task with: cm task delete ${taskId}`);
          }
        } else if (result.conflicted) {
          console.log(`\n${result.error}`);
          console.log(`To resolve manually:`);
          console.log(`  cd ${t.repoPath}`);
          console.log(`  git checkout ${t.baseBranch}`);
          console.log(`  git merge cm-task/${taskId}`);
          console.log(`  # resolve conflicts`);
          console.log(`  git commit`);
        } else {
          console.log(`\nMerge failed: ${result.error}`);
        }
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
