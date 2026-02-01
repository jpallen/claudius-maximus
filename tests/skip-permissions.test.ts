import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createTestContext, type TestContext } from "./helpers";

describe("--dangerously-skip-permissions flag", () => {
  let ctx: TestContext;
  let tempDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    tempDir = await mkdtemp(join(tmpdir(), "cm-skip-perm-test-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("passes --dangerously-skip-permissions to claude in task create", async () => {
    // Create a mock claude script that records its arguments
    const argsFile = join(tempDir, "claude-args.txt");
    const mockScript = join(tempDir, "mock-claude");

    await Bun.write(mockScript, `#!/bin/bash
# Record all arguments to a file
echo "$@" > "${argsFile}"
# Exit immediately (we don't need to actually run claude)
exit 0
`);
    await chmod(mockScript, 0o755);

    // Create a git repo for the test
    const repoDir = join(tempDir, "repo");
    await Bun.spawn(["git", "init", repoDir]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.email", "test@test.com"]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.name", "Test"]).exited;
    await Bun.write(join(repoDir, "README.md"), "# Test");
    await Bun.spawn(["git", "-C", repoDir, "add", "."]).exited;
    await Bun.spawn(["git", "-C", repoDir, "commit", "-m", "Initial"]).exited;

    // Run cm task create with mock claude
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "task", "create", "Test task"],
      {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CM_CONFIG_DIR: ctx.configDir,
          CM_CLAUDE_COMMAND: mockScript,
        },
      }
    );

    await proc.exited;

    // Check that the flag was passed
    const args = await Bun.file(argsFile).text();
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("passes --dangerously-skip-permissions with --agent flag", async () => {
    // Create a mock claude script that records its arguments
    const argsFile = join(tempDir, "claude-args.txt");
    const mockScript = join(tempDir, "mock-claude");

    await Bun.write(mockScript, `#!/bin/bash
# Record all arguments to a file
echo "$@" > "${argsFile}"
# Exit immediately (we don't need to actually run claude)
exit 0
`);
    await chmod(mockScript, 0o755);

    // Create a git repo for the test
    const repoDir = join(tempDir, "repo");
    await Bun.spawn(["git", "init", repoDir]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.email", "test@test.com"]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.name", "Test"]).exited;
    await Bun.write(join(repoDir, "README.md"), "# Test");
    await Bun.spawn(["git", "-C", repoDir, "add", "."]).exited;
    await Bun.spawn(["git", "-C", repoDir, "commit", "-m", "Initial"]).exited;

    // Run cm task create with mock claude and --agent flag
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "task", "create", "--agent", "test-agent", "Test task with agent"],
      {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CM_CONFIG_DIR: ctx.configDir,
          CM_CLAUDE_COMMAND: mockScript,
        },
      }
    );

    await proc.exited;

    // Check that both flags were passed
    const args = await Bun.file(argsFile).text();
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--agent");
    expect(args).toContain("test-agent");
  });

  it("passes --dangerously-skip-permissions with --workflow flag", async () => {
    // Create a mock claude script that records its arguments
    const argsFile = join(tempDir, "claude-args.txt");
    const mockScript = join(tempDir, "mock-claude");

    await Bun.write(mockScript, `#!/bin/bash
# Record all arguments to a file
echo "$@" > "${argsFile}"
# Exit immediately (we don't need to actually run claude)
exit 0
`);
    await chmod(mockScript, 0o755);

    // Create a git repo for the test
    const repoDir = join(tempDir, "repo");
    await Bun.spawn(["git", "init", repoDir]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.email", "test@test.com"]).exited;
    await Bun.spawn(["git", "-C", repoDir, "config", "user.name", "Test"]).exited;
    await Bun.write(join(repoDir, "README.md"), "# Test");
    await Bun.spawn(["git", "-C", repoDir, "add", "."]).exited;
    await Bun.spawn(["git", "-C", repoDir, "commit", "-m", "Initial"]).exited;

    // Create a workflow file (markdown with frontmatter)
    const workflowDir = join(repoDir, ".claudius-maximus", "workflows");
    await Bun.spawn(["mkdir", "-p", workflowDir]).exited;
    await Bun.write(join(workflowDir, "test-workflow.md"), `---
name: test-workflow
description: A test workflow
---

# Test Workflow

Do something useful.
`);

    // Run cm task create with mock claude and --workflow flag
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "task", "create", "--workflow", "test-workflow", "Test task with workflow"],
      {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CM_CONFIG_DIR: ctx.configDir,
          CM_CLAUDE_COMMAND: mockScript,
        },
      }
    );

    await proc.exited;

    // Check that both the permissions flag and append-system-prompt were passed
    const args = await Bun.file(argsFile).text();
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--append-system-prompt");
  });
});
