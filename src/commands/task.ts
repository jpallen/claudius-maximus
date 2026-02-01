/**
 * Task management commands for standalone CLI usage
 */

import { Command } from "commander";
import { createTask, loadTask, listTasks } from "../lib/task/manager";
import {
  mergeTaskBranch,
  getTaskCommitSummary,
  getUncommittedChanges,
  detectTaskFromCwd,
  findGitRoot,
  removeWorktree,
} from "../lib/task/worktree";
import { loadWorkflow, generateWorkflowSystemPrompt } from "../lib/workflow";

export function createTaskCommand(): Command {
  const task = new Command("task").description("Manage tasks");

  // cm task create <prompt>
  task
    .command("create <prompt>")
    .description("Create a task and start Claude session")
    .option("--agent <path>", "Agent configuration file")
    .option("--workflow <name>", "Workflow to execute (from .claudius-maximus/workflows/)")
    .option("--base <branch>", "Base branch (default: current)")
    .action(async (prompt: string, options: { agent?: string; workflow?: string; base?: string }) => {
      // Validate mutually exclusive options
      if (options.agent && options.workflow) {
        console.error("Error: Cannot specify both --agent and --workflow");
        process.exit(1);
      }

      const repoPath = await findGitRoot(process.cwd());

      // Load workflow and generate system prompt if specified
      let workflowSystemPrompt: string | undefined;
      if (options.workflow) {
        const workflow = await loadWorkflow(repoPath, options.workflow);
        workflowSystemPrompt = generateWorkflowSystemPrompt(workflow);
      }

      const newTask = await createTask(
        { prompt, agent: options.agent, workflow: options.workflow, baseBranch: options.base },
        repoPath
      );

      console.log(`Created task: ${newTask.id}`);
      console.log(`Worktree: ${newTask.worktreePath}`);
      console.log(`Branch: cm-task/${newTask.id}`);
      if (options.workflow) {
        console.log(`Workflow: ${options.workflow}`);
      }
      console.log(`\nStarting Claude...\n`);

      // Build Claude command args
      const claudeCmd = process.env.CM_CLAUDE_COMMAND || "claude";
      const args: string[] = [];

      if (options.agent) {
        args.push("--agent", options.agent);
      }

      if (workflowSystemPrompt) {
        args.push("--append-system-prompt", workflowSystemPrompt);
      }

      args.push(prompt);

      const proc = Bun.spawn([claudeCmd, ...args], {
        cwd: newTask.worktreePath,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });

      process.exit(await proc.exited);
    });

  // cm task merge [taskId]
  task
    .command("merge [taskId]")
    .description("Merge task branch into base branch")
    .option("--no-cleanup", "Keep worktree and branch after merge")
    .action(async (taskId: string | undefined, options: { cleanup: boolean }) => {
      let resolvedTaskId = taskId;
      let repoPath: string;

      if (!taskId) {
        // Try to detect from current directory
        const detected = await detectTaskFromCwd(process.cwd());
        if (!detected) {
          console.error("Error: Not in a task worktree. Please specify a task ID.");
          process.exit(1);
        }
        resolvedTaskId = detected.taskId;
        repoPath = detected.repoPath;
      } else {
        repoPath = await findGitRoot(process.cwd());
      }

      const taskData = await loadTask(resolvedTaskId!);

      // Check for uncommitted changes in worktree
      const changes = await getUncommittedChanges(taskData.worktreePath);
      if (changes.hasChanges) {
        console.error("Error: Worktree has uncommitted changes.");
        if (changes.staged.length) {
          console.error(`  Staged: ${changes.staged.join(", ")}`);
        }
        if (changes.unstaged.length) {
          console.error(`  Modified: ${changes.unstaged.join(", ")}`);
        }
        if (changes.untracked.length) {
          console.error(`  Untracked: ${changes.untracked.join(", ")}`);
        }
        process.exit(1);
      }

      // Show commits to merge
      const commits = await getTaskCommitSummary(
        repoPath,
        taskData.id,
        taskData.baseBranch
      );
      if (commits.length === 0) {
        console.log("No commits to merge.");
        process.exit(0);
      }

      console.log(
        `Merging ${commits.length} commit(s) from cm-task/${taskData.id} into ${taskData.baseBranch}:\n`
      );
      for (const c of commits) {
        console.log(`  ${c.hash} ${c.subject}`);
      }
      console.log();

      // Perform merge
      const result = await mergeTaskBranch(repoPath, taskData.id, taskData.baseBranch);

      if (!result.success) {
        if (result.conflicted) {
          console.error("Error: Merge conflicts detected. Resolve manually:");
          console.error(`  cd ${repoPath}`);
          console.error(`  git merge cm-task/${taskData.id}`);
        } else {
          console.error(`Error: ${result.error}`);
        }
        process.exit(1);
      }

      console.log("Merge successful.");

      // Cleanup unless --no-cleanup
      if (options.cleanup !== false) {
        await removeWorktree(repoPath, taskData.id, true);
        console.log("Cleaned up worktree and branch.");
      }
    });

  // cm task list (useful utility)
  task
    .command("list")
    .alias("ls")
    .description("List all tasks")
    .action(async () => {
      const tasks = await listTasks();
      if (tasks.length === 0) {
        console.log("No tasks.");
        return;
      }
      for (const t of tasks) {
        const status =
          t.status === "active" ? "●" : t.status === "completed" ? "✓" : "○";
        console.log(
          `${status} ${t.id} - ${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? "..." : ""}`
        );
      }
    });

  return task;
}
