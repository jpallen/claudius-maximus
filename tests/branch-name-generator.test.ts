import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, createSimpleMockClaude, type TestContext } from "./helpers";
import { join } from "path";
import { mkdtemp, rm, chmod } from "fs/promises";
import { tmpdir } from "os";
import {
  cleanBranchName,
  isValidBranchName,
  ensureUniqueBranchName,
} from "../src/lib/task/branch-name-generator";

/** CLI entry point for running cm commands */
const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/**
 * Create a test git repository with a cm.yml file
 */
async function createTestRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "cm-branch-test-repo-"));

  // Initialize git repo
  await Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

  // Create a simple cm.yml
  const cmYml = `version: "1"

workflows:
  default:
    prompt: Execute the task.
    steps:
      - name: execute
        model: sonnet
        prompt: "Execute the task."
`;

  await Bun.write(join(repoDir, "cm.yml"), cmYml);
  await Bun.write(join(repoDir, "README.md"), "# Test Repo\n");

  // Make initial commit
  await Bun.spawn(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;
  await Bun.spawn(["git", "commit", "-m", "Initial commit"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" }).exited;

  return repoDir;
}

/**
 * Run CLI in a specific directory with optional extra environment variables
 */
async function runCli(
  ctx: TestContext,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CM_CONFIG_DIR: ctx.configDir,
      ...extraEnv,
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Get list of git branches in the repo
 */
async function getGitBranches(repoDir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "branch", "-l"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // Parse branch list (lines like "* main" or "  feature-branch" or "+ worktree-branch")
  // The + prefix indicates a branch checked out in a linked worktree
  return stdout
    .split("\n")
    .map((line) => line.replace(/^[\*\+]?\s*/, "").trim())
    .filter(Boolean);
}

describe("Branch Name Generator", () => {
  // E2E/Integration Tests
  describe("E2E Tests", () => {
    let ctx: TestContext;
    let testRepoDir: string;
    let tempDir: string;

    beforeEach(async () => {
      ctx = await createTestContext();
      testRepoDir = await createTestRepo();
      tempDir = await mkdtemp(join(tmpdir(), "cm-branch-mock-"));
    });

    afterEach(async () => {
      await ctx.cleanup();
      await rm(testRepoDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    });

    it("uses Claude-generated branch name when available", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "implement-user-authentication",
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Add user authentication with OAuth2", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("implement-user-authentication");

      // Verify git branch was created
      const branches = await getGitBranches(testRepoDir);
      expect(branches).toContain("cm-task/implement-user-authentication");
    });

    it("falls back to random ID when Claude fails (non-zero exit)", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "",
        exitCode: 1,
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task description", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);
    });

    it("falls back to random ID for whitespace-only description without calling Claude", async () => {
      const { scriptPath, invocationFlagPath } = await createSimpleMockClaude(tempDir, {
        output: "should-not-be-used",
        trackInvocations: true,
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "   ", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);

      // Claude should NOT have been called
      const flagExists = await Bun.file(invocationFlagPath!).exists();
      expect(flagExists).toBe(false);
    });

    it("falls back to random ID for unusable output (cleans to empty)", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "!!!",  // Cleans to empty string
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);
    });

    it("falls back to random ID for too-short generated names", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "a",  // Single char is too short
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);
    });

    it("falls back to random ID for too-long generated names", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "a".repeat(100),  // >60 chars is too long
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);
    });

    it("appends suffix for duplicate names", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: "implement-feature",
      });

      // Create first task
      const result1 = await runCli(ctx, testRepoDir, [
        "task", "create", "Implement feature X", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result1.exitCode).toBe(0);
      expect(result1.stdout).toContain("implement-feature");

      // Create second task with same generated name
      const result2 = await runCli(ctx, testRepoDir, [
        "task", "create", "Implement feature Y", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result2.exitCode).toBe(0);
      expect(result2.stdout).toContain("implement-feature-2");
    });

    it("cleans messy Claude output", async () => {
      const { scriptPath } = await createSimpleMockClaude(tempDir, {
        output: '"implement-auth"\n\nThis is a good branch name.',
      });

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Add authentication", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should extract clean name from messy output
      expect(result.stdout).toContain("implement-auth");
    });

    it("falls back to random ID on timeout", async () => {
      // Create a mock that sleeps longer than the 10s timeout
      const scriptPath = join(tempDir, "slow-mock-claude");
      const script = `#!/bin/bash
sleep 15
echo '{"result":"should-not-reach"}'
`;
      await Bun.write(scriptPath, script);
      await chmod(scriptPath, 0o755);

      const result = await runCli(ctx, testRepoDir, [
        "task", "create", "Test task", "--no-start",
      ], {
        CM_CLAUDE_COMMAND: scriptPath,
      });

      expect(result.exitCode).toBe(0);
      // Should fall back to adjective-noun pattern (timeout kicks in at 10s)
      expect(result.stdout).toMatch(/Task created:\s+[a-z]+-[a-z]+/);
    }, 20000);  // Allow up to 20 seconds for this test (10s timeout + buffer)
  });

  // Unit Tests
  describe("cleanBranchName()", () => {
    it("removes double quotes", () => {
      expect(cleanBranchName('"implement-auth"')).toBe("implement-auth");
    });

    it("removes single quotes", () => {
      expect(cleanBranchName("'implement-auth'")).toBe("implement-auth");
    });

    it("removes backticks", () => {
      expect(cleanBranchName("`implement-auth`")).toBe("implement-auth");
    });

    it("lowercases input", () => {
      expect(cleanBranchName("Implement-Auth")).toBe("implement-auth");
    });

    it("replaces spaces with hyphens", () => {
      expect(cleanBranchName("implement auth")).toBe("implement-auth");
    });

    it("removes invalid characters", () => {
      expect(cleanBranchName("implement@auth!")).toBe("implementauth");
    });

    it("collapses multiple hyphens", () => {
      expect(cleanBranchName("implement--auth")).toBe("implement-auth");
    });

    it("removes leading hyphens", () => {
      expect(cleanBranchName("-implement-auth")).toBe("implement-auth");
    });

    it("removes trailing hyphens", () => {
      expect(cleanBranchName("implement-auth-")).toBe("implement-auth");
    });

    it("handles mixed messy input", () => {
      expect(cleanBranchName('  "Implement--Auth!" \n')).toBe("implement-auth");
    });
  });

  describe("isValidBranchName()", () => {
    it("accepts valid multi-word names", () => {
      expect(isValidBranchName("implement-auth")).toBe(true);
      expect(isValidBranchName("fix-bug")).toBe(true);
      expect(isValidBranchName("add-user-settings-page")).toBe(true);
    });

    it("accepts valid single-word names (min 2 chars)", () => {
      expect(isValidBranchName("ab")).toBe(true);
      expect(isValidBranchName("auth")).toBe(true);
    });

    it("accepts names with numbers", () => {
      expect(isValidBranchName("fix-bug-123")).toBe(true);
      expect(isValidBranchName("feature2")).toBe(true);
    });

    it("accepts names at exactly 2 chars (minimum)", () => {
      expect(isValidBranchName("ab")).toBe(true);
    });

    it("accepts names at exactly 60 chars (maximum)", () => {
      // Build a 60-char valid name: starts with letter, contains hyphens
      const name = "a-" + "b".repeat(58);  // 60 chars: "a-" + 58 b's
      expect(name.length).toBe(60);
      expect(isValidBranchName(name)).toBe(true);
    });

    it("rejects empty string", () => {
      expect(isValidBranchName("")).toBe(false);
    });

    it("rejects too short (1 char)", () => {
      expect(isValidBranchName("a")).toBe(false);
    });

    it("rejects too long (>60 chars)", () => {
      expect(isValidBranchName("a".repeat(61))).toBe(false);
    });

    it("rejects names with special characters", () => {
      expect(isValidBranchName("implement@auth")).toBe(false);
      expect(isValidBranchName("fix!bug")).toBe(false);
    });

    it("rejects leading numbers", () => {
      expect(isValidBranchName("1-fix-bug")).toBe(false);
    });

    it("rejects leading hyphens", () => {
      expect(isValidBranchName("-fix-bug")).toBe(false);
    });

    it("rejects uppercase letters", () => {
      expect(isValidBranchName("Fix-Bug")).toBe(false);
    });
  });

  describe("ensureUniqueBranchName()", () => {
    it("returns name unchanged if not in set", () => {
      const existing = new Set<string>();
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth");
    });

    it("appends -2 for first conflict", () => {
      const existing = new Set(["implement-auth"]);
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth-2");
    });

    it("appends -3 for second conflict", () => {
      const existing = new Set(["implement-auth", "implement-auth-2"]);
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth-3");
    });

    it("handles name that already ends with suffix", () => {
      // If "foo-2" exists, should try "foo-2-2"
      const existing = new Set(["foo-2"]);
      expect(ensureUniqueBranchName("foo-2", existing)).toBe("foo-2-2");
    });

    it("finds correct suffix when multiple conflicts exist", () => {
      const existing = new Set(["foo", "foo-2", "foo-3"]);
      expect(ensureUniqueBranchName("foo", existing)).toBe("foo-4");
    });

    it("skips taken suffixes", () => {
      const existing = new Set(["foo", "foo-2", "foo-4"]);
      expect(ensureUniqueBranchName("foo", existing)).toBe("foo-3");
    });
  });
});
