import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createTestContext, runCli, type TestContext } from "./helpers";
import { formatUncommittedChangesMessage, UncommittedChangesError } from "../src/lib/errors";

/**
 * Helper to create a git repo for testing
 */
async function createTestRepo(baseDir: string): Promise<string> {
  const repoDir = join(baseDir, "repo");
  await Bun.spawn(["git", "init", repoDir]).exited;
  await Bun.spawn(["git", "-C", repoDir, "config", "user.email", "test@test.com"]).exited;
  await Bun.spawn(["git", "-C", repoDir, "config", "user.name", "Test"]).exited;
  await Bun.write(join(repoDir, "README.md"), "# Test");
  await Bun.spawn(["git", "-C", repoDir, "add", "."]).exited;
  await Bun.spawn(["git", "-C", repoDir, "commit", "-m", "Initial"]).exited;
  return repoDir;
}

/**
 * Helper to create a worktree without invoking Claude
 * This creates the worktree directly using git commands, bypassing the task system
 * to allow focused testing of the hooks command.
 */
async function createWorktreeDirectly(
  repoDir: string,
  taskId: string
): Promise<string> {
  const worktreesDir = join(repoDir, ".cm-worktrees");
  const worktreePath = join(worktreesDir, taskId);
  const branchName = `cm-task/${taskId}`;

  // Create the worktrees directory
  await mkdir(worktreesDir, { recursive: true });

  // Get current branch
  const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoDir,
    stdout: "pipe",
  });
  const baseBranch = (await new Response(branchProc.stdout).text()).trim();

  // Create worktree with new branch
  const proc = Bun.spawn(
    ["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  await proc.exited;

  return worktreePath;
}

/**
 * Helper to run cm hooks stop in a specific directory
 */
async function runHooksStop(
  cwd: string,
  configDir: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "hooks", "stop"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CM_CONFIG_DIR: configDir,
      },
    }
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe("cm hooks stop", () => {
  let ctx: TestContext;
  let tempDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    tempDir = await mkdtemp(join(tmpdir(), "cm-hooks-test-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("when not in a task worktree", () => {
    it("exits 0 in a regular git repo", async () => {
      const repoDir = await createTestRepo(tempDir);

      const result = await runHooksStop(repoDir, ctx.configDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("exits 0 in a non-git directory", async () => {
      const nonGitDir = join(tempDir, "non-git");
      await mkdir(nonGitDir, { recursive: true });

      const result = await runHooksStop(nonGitDir, ctx.configDir);

      // Should exit 0 (fail-open behavior)
      expect(result.exitCode).toBe(0);
      // May have a warning message about not being able to detect task context
      // but the exit code should be 0
    });
  });

  describe("when in a clean task worktree", () => {
    it("exits 0 when git state is clean", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-clean");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });

  describe("when in a dirty task worktree", () => {
    it("exits 2 with staged files", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-staged");

      // Create and stage a file
      await Bun.write(join(worktreePath, "new-file.ts"), "export const x = 1;");
      await Bun.spawn(["git", "-C", worktreePath, "add", "new-file.ts"]).exited;

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot stop: there are uncommitted changes");
      expect(result.stderr).toContain("Staged files (commit these):");
      expect(result.stderr).toContain("new-file.ts");
    });

    it("exits 2 with modified files", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-modified");

      // Modify an existing file
      await Bun.write(join(worktreePath, "README.md"), "# Modified");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot stop: there are uncommitted changes");
      expect(result.stderr).toContain("Modified files (commit or discard changes):");
      expect(result.stderr).toContain("README.md");
    });

    it("exits 2 with untracked files", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-untracked");

      // Create an untracked file (not staged)
      await Bun.write(join(worktreePath, "temp.log"), "some log output");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot stop: there are uncommitted changes");
      expect(result.stderr).toContain("Untracked files (commit, delete, or add to .gitignore):");
      expect(result.stderr).toContain("temp.log");
    });

    it("exits 2 with mixed changes and lists all types", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-mixed");

      // Create staged file
      await Bun.write(join(worktreePath, "staged.ts"), "export const s = 1;");
      await Bun.spawn(["git", "-C", worktreePath, "add", "staged.ts"]).exited;

      // Modify existing file (unstaged)
      await Bun.write(join(worktreePath, "README.md"), "# Modified");

      // Create untracked file
      await Bun.write(join(worktreePath, "untracked.log"), "log output");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot stop: there are uncommitted changes");
      expect(result.stderr).toContain("Staged files (commit these):");
      expect(result.stderr).toContain("staged.ts");
      expect(result.stderr).toContain("Modified files (commit or discard changes):");
      expect(result.stderr).toContain("README.md");
      expect(result.stderr).toContain("Untracked files (commit, delete, or add to .gitignore):");
      expect(result.stderr).toContain("untracked.log");
    });

    it("includes actionable instructions in the error message", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-actions");

      await Bun.write(join(worktreePath, "file.ts"), "content");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Actions to take:");
      expect(result.stderr).toContain("git add <files> && git commit -m 'message'");
      expect(result.stderr).toContain("Delete any temporary/generated files");
      expect(result.stderr).toContain(".gitignore");
    });
  });

  describe("edge cases", () => {
    it("handles files with spaces in names", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-spaces");

      await Bun.write(join(worktreePath, "file with spaces.ts"), "content");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("file with spaces.ts");
    });

    it("handles nested directory paths", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-nested");

      await mkdir(join(worktreePath, "src", "lib"), { recursive: true });
      await Bun.write(join(worktreePath, "src", "lib", "feature.ts"), "content");

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(2);
      // Git shows untracked directories (not full paths) when using porcelain format
      expect(result.stderr).toContain("src/");
    });

    it("exits 0 after all changes are committed", async () => {
      const repoDir = await createTestRepo(tempDir);
      const worktreePath = await createWorktreeDirectly(repoDir, "test-task-committed");

      // Create and commit a file
      await Bun.write(join(worktreePath, "feature.ts"), "export const x = 1;");
      await Bun.spawn(["git", "-C", worktreePath, "add", "."]).exited;
      await Bun.spawn(["git", "-C", worktreePath, "commit", "-m", "Add feature"]).exited;

      const result = await runHooksStop(worktreePath, ctx.configDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });
});

describe("formatUncommittedChangesMessage", () => {
  it("formats message with only staged files", () => {
    const message = formatUncommittedChangesMessage(
      ["src/a.ts", "src/b.ts"],
      [],
      []
    );

    expect(message).toContain("Cannot stop: there are uncommitted changes");
    expect(message).toContain("Staged files (commit these):");
    expect(message).toContain("  - src/a.ts");
    expect(message).toContain("  - src/b.ts");
    expect(message).not.toContain("Modified files");
    expect(message).not.toContain("Untracked files");
  });

  it("formats message with only modified files", () => {
    const message = formatUncommittedChangesMessage(
      [],
      ["README.md"],
      []
    );

    expect(message).toContain("Modified files (commit or discard changes):");
    expect(message).toContain("  - README.md");
    expect(message).not.toContain("Staged files");
    expect(message).not.toContain("Untracked files");
  });

  it("formats message with only untracked files", () => {
    const message = formatUncommittedChangesMessage(
      [],
      [],
      ["temp.log", ".DS_Store"]
    );

    expect(message).toContain("Untracked files (commit, delete, or add to .gitignore):");
    expect(message).toContain("  - temp.log");
    expect(message).toContain("  - .DS_Store");
    expect(message).not.toContain("Staged files");
    expect(message).not.toContain("Modified files");
  });

  it("formats message with all three types", () => {
    const message = formatUncommittedChangesMessage(
      ["staged.ts"],
      ["modified.ts"],
      ["untracked.ts"]
    );

    expect(message).toContain("Staged files (commit these):");
    expect(message).toContain("Modified files (commit or discard changes):");
    expect(message).toContain("Untracked files (commit, delete, or add to .gitignore):");
    expect(message).toContain("  - staged.ts");
    expect(message).toContain("  - modified.ts");
    expect(message).toContain("  - untracked.ts");
  });

  it("includes actions section", () => {
    const message = formatUncommittedChangesMessage(["file.ts"], [], []);

    expect(message).toContain("Actions to take:");
    expect(message).toContain("1. Commit all intended changes");
    expect(message).toContain("2. Delete any temporary/generated files");
    expect(message).toContain("3. Add any files that should be ignored to .gitignore");
  });
});

describe("UncommittedChangesError", () => {
  it("creates error with correct properties", () => {
    const error = new UncommittedChangesError(
      ["staged.ts"],
      ["modified.ts"],
      ["untracked.ts"]
    );

    expect(error.name).toBe("UncommittedChangesError");
    expect(error.staged).toEqual(["staged.ts"]);
    expect(error.unstaged).toEqual(["modified.ts"]);
    expect(error.untracked).toEqual(["untracked.ts"]);
    expect(error.message).toContain("Cannot stop: there are uncommitted changes");
  });

  it("is an instance of Error", () => {
    const error = new UncommittedChangesError([], [], ["file.ts"]);
    expect(error instanceof Error).toBe(true);
  });
});
