/**
 * Git worktree management for task isolation
 */

import { join, dirname } from "path";
import { mkdir, rm } from "fs/promises";
import { NotInGitRepoError, WorktreeError } from "../errors";

/** Directory name for worktrees within the project */
const WORKTREES_DIR = ".cm-worktrees";

/**
 * Find the root of the git repository
 */
export async function findGitRoot(startPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: startPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new NotInGitRepoError();
  }

  return stdout.trim();
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new WorktreeError("get branch", "Failed to get current branch");
  }

  return stdout.trim();
}

/**
 * Get the path where worktrees are stored for a repo
 */
export function getWorktreesDir(repoPath: string): string {
  return join(repoPath, WORKTREES_DIR);
}

/**
 * Get the path for a specific task's worktree
 */
export function getWorktreePath(repoPath: string, taskId: string): string {
  return join(getWorktreesDir(repoPath), taskId);
}

/**
 * Ensure the worktrees directory exists and is in .gitignore
 */
async function ensureWorktreesDir(repoPath: string): Promise<void> {
  const worktreesDir = getWorktreesDir(repoPath);

  // Create directory
  await mkdir(worktreesDir, { recursive: true });

  // Ensure it's in .gitignore
  const gitignorePath = join(repoPath, ".gitignore");
  const gitignoreFile = Bun.file(gitignorePath);

  let gitignoreContent = "";
  if (await gitignoreFile.exists()) {
    gitignoreContent = await gitignoreFile.text();
  }

  const ignoreEntry = `/${WORKTREES_DIR}/`;
  if (!gitignoreContent.includes(ignoreEntry)) {
    // Add to gitignore
    const newContent = gitignoreContent
      ? `${gitignoreContent.trimEnd()}\n\n# CM CLI worktrees\n${ignoreEntry}\n`
      : `# CM CLI worktrees\n${ignoreEntry}\n`;
    await Bun.write(gitignorePath, newContent);
  }
}

/**
 * Create a new git worktree for a task
 */
export async function createWorktree(
  repoPath: string,
  taskId: string,
  branchName?: string
): Promise<string> {
  await ensureWorktreesDir(repoPath);

  const worktreePath = getWorktreePath(repoPath, taskId);

  // Use a new branch based on the current branch
  const baseBranch = branchName || (await getCurrentBranch(repoPath));
  const newBranch = `cm-task/${taskId}`;

  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", newBranch, worktreePath, baseBranch],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new WorktreeError("create", stderr.trim());
  }

  return worktreePath;
}

/**
 * Remove a git worktree for a task
 */
export async function removeWorktree(
  repoPath: string,
  taskId: string,
  deleteBranch: boolean = true
): Promise<void> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  const branchName = `cm-task/${taskId}`;

  // Remove the worktree
  const proc = Bun.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Try to force remove the directory if worktree remove fails
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }

    // Prune worktree references
    await Bun.spawn(["git", "worktree", "prune"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  }

  // Delete the branch if requested
  if (deleteBranch) {
    await Bun.spawn(["git", "branch", "-D", branchName], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    // Ignore errors - branch might not exist
  }
}

/**
 * Check if a worktree exists
 */
export async function worktreeExists(
  repoPath: string,
  taskId: string
): Promise<boolean> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  const file = Bun.file(worktreePath);
  return file.exists();
}

/**
 * List all existing worktrees
 */
export async function listWorktrees(
  repoPath: string
): Promise<{ path: string; branch: string }[]> {
  const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return [];
  }

  const worktrees: { path: string; branch: string }[] = [];
  let currentWorktree: { path?: string; branch?: string } = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree.path = line.slice(9);
    } else if (line.startsWith("branch ")) {
      currentWorktree.branch = line.slice(7);
    } else if (line === "") {
      if (currentWorktree.path && currentWorktree.branch) {
        worktrees.push({
          path: currentWorktree.path,
          branch: currentWorktree.branch,
        });
      }
      currentWorktree = {};
    }
  }

  return worktrees;
}

/**
 * Check if a branch exists
 */
export async function branchExists(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const proc = Bun.spawn(
    ["git", "rev-parse", "--verify", "--quiet", branchName],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;
  return exitCode === 0;
}

/**
 * Git uncommitted changes info
 */
export interface UncommittedChanges {
  hasChanges: boolean;
  staged: string[];     // Files staged for commit
  unstaged: string[];   // Modified but not staged
  untracked: string[];  // New untracked files
}

/**
 * Check for uncommitted git changes in a directory
 * @throws WorktreeError if git command fails
 */
export async function getUncommittedChanges(cwd: string): Promise<UncommittedChanges> {
  // Get status in porcelain format
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new WorktreeError("git status", stderr.trim() || `Exit code ${exitCode}`);
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3);

    // Index status (staged changes)
    if (indexStatus !== " " && indexStatus !== "?") {
      staged.push(filePath);
    }

    // Work tree status (unstaged changes)
    if (workTreeStatus !== " " && workTreeStatus !== "?") {
      unstaged.push(filePath);
    }

    // Untracked files
    if (indexStatus === "?" && workTreeStatus === "?") {
      untracked.push(filePath);
    }
  }

  return {
    hasChanges: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
    staged,
    unstaged,
    untracked,
  };
}

/** Commit info for merge summary */
export interface CommitInfo {
  hash: string;
  subject: string;
}

/**
 * Check if task branch has commits ahead of base branch
 * @throws WorktreeError if git command fails
 */
export async function hasCommitsToMerge(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<boolean> {
  const taskBranch = `cm-task/${taskId}`;

  const proc = Bun.spawn(
    ["git", "rev-list", "--count", `${baseBranch}..${taskBranch}`],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new WorktreeError("check commits", stderr.trim() || `Exit code ${exitCode}`);
  }

  const count = parseInt(stdout.trim(), 10);
  return count > 0;
}

/**
 * Get list of commits to merge from task branch to base branch
 * @throws WorktreeError if git command fails
 */
export async function getTaskCommitSummary(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<CommitInfo[]> {
  const taskBranch = `cm-task/${taskId}`;

  const proc = Bun.spawn(
    ["git", "log", "--oneline", `${baseBranch}..${taskBranch}`],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new WorktreeError("get commit summary", stderr.trim() || `Exit code ${exitCode}`);
  }

  const commits: CommitInfo[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line) {
      const spaceIndex = line.indexOf(" ");
      if (spaceIndex > 0) {
        commits.push({
          hash: line.slice(0, spaceIndex),
          subject: line.slice(spaceIndex + 1),
        });
      }
    }
  }

  return commits;
}

/** Result of a merge operation */
export interface MergeResult {
  success: boolean;
  conflicted: boolean;
  error?: string;
}

/**
 * Detect if current directory is inside a task worktree
 * Returns task info if in a worktree, null otherwise
 */
export async function detectTaskFromCwd(
  cwd: string
): Promise<{ taskId: string; repoPath: string } | null> {
  // Check if path contains .cm-worktrees/<taskId>
  const match = cwd.match(/\.cm-worktrees\/([^\/]+)/);
  if (!match) return null;

  const taskId = match[1];
  const repoPath = cwd.substring(0, cwd.indexOf(".cm-worktrees")).replace(/\/$/, "");

  // Verify by checking branch name
  try {
    const branch = await getCurrentBranch(cwd);
    if (branch !== `cm-task/${taskId}`) return null;
  } catch {
    return null;
  }

  return { taskId, repoPath };
}

/**
 * Merge task branch into base branch
 */
export async function mergeTaskBranch(
  repoPath: string,
  taskId: string,
  baseBranch: string
): Promise<MergeResult> {
  const taskBranch = `cm-task/${taskId}`;

  // First, checkout the base branch
  const checkoutProc = Bun.spawn(["git", "checkout", baseBranch], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const checkoutStderr = await new Response(checkoutProc.stderr).text();
  const checkoutExit = await checkoutProc.exited;

  if (checkoutExit !== 0) {
    return {
      success: false,
      conflicted: false,
      error: `Failed to checkout ${baseBranch}: ${checkoutStderr.trim()}`,
    };
  }

  // Perform the merge
  const mergeProc = Bun.spawn(
    ["git", "merge", taskBranch, "--no-edit"],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const mergeStdout = await new Response(mergeProc.stdout).text();
  const mergeStderr = await new Response(mergeProc.stderr).text();
  const mergeExit = await mergeProc.exited;

  if (mergeExit !== 0) {
    // Check if it's a conflict
    const isConflict =
      mergeStdout.includes("CONFLICT") ||
      mergeStderr.includes("CONFLICT") ||
      mergeStdout.includes("Automatic merge failed");

    if (isConflict) {
      // Abort the merge
      await Bun.spawn(["git", "merge", "--abort"], {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      return {
        success: false,
        conflicted: true,
        error: "Merge conflicts detected. Please resolve manually.",
      };
    }

    return {
      success: false,
      conflicted: false,
      error: mergeStderr.trim() || mergeStdout.trim(),
    };
  }

  return {
    success: true,
    conflicted: false,
  };
}
