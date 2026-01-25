import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

/**
 * Run CLI in a specific directory
 */
async function runCli(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Create a test git repository
 */
async function createTestRepo(): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "cm-init-test-"));

  await Bun.spawn(["git", "init"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "Test"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  }).exited;

  return repoDir;
}

describe("cm init", () => {
  let testRepoDir: string;

  beforeEach(async () => {
    testRepoDir = await createTestRepo();
  });

  afterEach(async () => {
    await rm(testRepoDir, { recursive: true, force: true });
  });

  it("creates cm.yml and agent files", async () => {
    const result = await runCli(testRepoDir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Initialized Claudius Maximus");
    expect(result.stdout).toContain("cm.yml");
    expect(result.stdout).toContain("planning-agent.md");
    expect(result.stdout).toContain("execution-agent.md");
    expect(result.stdout).toContain("review-agent.md");

    // Verify files exist
    expect(await Bun.file(join(testRepoDir, "cm.yml")).exists()).toBe(true);
    expect(
      await Bun.file(
        join(testRepoDir, ".claude", "agents", "planning-agent.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(testRepoDir, ".claude", "agents", "execution-agent.md")
      ).exists()
    ).toBe(true);
    expect(
      await Bun.file(
        join(testRepoDir, ".claude", "agents", "review-agent.md")
      ).exists()
    ).toBe(true);
  });

  it("creates valid cm.yml with default workflow", async () => {
    await runCli(testRepoDir, ["init"]);

    const cmYml = await Bun.file(join(testRepoDir, "cm.yml")).text();

    expect(cmYml).toContain('version: "1"');
    expect(cmYml).toContain("workflows:");
    expect(cmYml).toContain("default:");
    expect(cmYml).toContain("prompt:");  // Orchestrator prompt
    expect(cmYml).toContain("name: plan");
    expect(cmYml).toContain("name: execute");
    expect(cmYml).toContain("name: review");
  });

  it("creates quick workflow", async () => {
    await runCli(testRepoDir, ["init"]);

    const cmYml = await Bun.file(join(testRepoDir, "cm.yml")).text();

    expect(cmYml).toContain("quick:");
  });

  it("creates plan-only workflow", async () => {
    await runCli(testRepoDir, ["init"]);

    const cmYml = await Bun.file(join(testRepoDir, "cm.yml")).text();

    expect(cmYml).toContain("plan-only:");
  });

  it("does not overwrite existing cm.yml without --force", async () => {
    // Create existing cm.yml
    await Bun.write(join(testRepoDir, "cm.yml"), "existing content");

    const result = await runCli(testRepoDir, ["init"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already exist");
    expect(result.stdout).toContain("--force");

    // Verify file was not overwritten
    const content = await Bun.file(join(testRepoDir, "cm.yml")).text();
    expect(content).toBe("existing content");
  });

  it("overwrites existing cm.yml with --force", async () => {
    // Create existing cm.yml
    await Bun.write(join(testRepoDir, "cm.yml"), "existing content");

    const result = await runCli(testRepoDir, ["init", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Overwriting");

    // Verify file was overwritten
    const content = await Bun.file(join(testRepoDir, "cm.yml")).text();
    expect(content).toContain('version: "1"');
  });

  it("fails when not in a git repository", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "cm-non-git-"));

    try {
      const result = await runCli(nonGitDir, ["init"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not in a git repository");
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("creates agent files with proper content", async () => {
    await runCli(testRepoDir, ["init"]);

    const planningAgent = await Bun.file(
      join(testRepoDir, ".claude", "agents", "planning-agent.md")
    ).text();
    expect(planningAgent).toContain("Planning Agent");
    expect(planningAgent).toContain("implementation plan");

    const executionAgent = await Bun.file(
      join(testRepoDir, ".claude", "agents", "execution-agent.md")
    ).text();
    expect(executionAgent).toContain("Execution Agent");
    expect(executionAgent).toContain("implementing plans");

    const reviewAgent = await Bun.file(
      join(testRepoDir, ".claude", "agents", "review-agent.md")
    ).text();
    expect(reviewAgent).toContain("Review Agent");
    expect(reviewAgent).toContain("APPROVED");
    expect(reviewAgent).toContain("NEEDS CHANGES");
  });

  it("shows available workflows in output", async () => {
    const result = await runCli(testRepoDir, ["init"]);

    expect(result.stdout).toContain("Available workflows:");
    expect(result.stdout).toContain("default");
    expect(result.stdout).toContain("quick");
    expect(result.stdout).toContain("plan-only");
  });

  it("shows getting started instructions", async () => {
    const result = await runCli(testRepoDir, ["init"]);

    expect(result.stdout).toContain("Get started:");
    expect(result.stdout).toContain("cm task create");
  });
});
