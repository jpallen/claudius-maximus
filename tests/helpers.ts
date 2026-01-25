import { mkdtemp, rm, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TestContext {
  configDir: string;
  run: (...args: string[]) => Promise<RunResult>;
  cleanup: () => Promise<void>;
}

/**
 * Run the CLI with given arguments
 */
export async function runCli(
  args: string[],
  options: {
    configDir?: string;
    env?: Record<string, string>;
  } = {}
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...options.env,
      ...(options.configDir ? { CM_CONFIG_DIR: options.configDir } : {}),
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
 * Create an isolated test context with its own config directory
 */
export async function createTestContext(): Promise<TestContext> {
  const configDir = await mkdtemp(join(tmpdir(), "cm-test-"));

  const run = (...args: string[]) => runCli(args, { configDir });

  const cleanup = async () => {
    await rm(configDir, { recursive: true, force: true });
  };

  return { configDir, run, cleanup };
}

/**
 * Create a mock "other version" of the CLI for dev mode testing
 */
export async function createMockVersion(
  baseDir: string,
  version: string,
  extraOutput?: string
): Promise<string> {
  const versionDir = join(baseDir, `mock-v${version}`);
  const srcDir = join(versionDir, "src");

  await Bun.write(
    join(srcDir, "index.ts"),
    `#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();
program
  .name("cm")
  .version("${version}")
  .description("Mock CM version ${version}");

program
  .command("hello [name]")
  .action((name) => {
    console.log(\`Hello from mock v${version}: \${name ?? "world"}${extraOutput ? ` ${extraOutput}` : ""}\`);
  });

program.parse();
`
  );

  // Copy package.json for dependencies
  const originalPkg = await Bun.file(join(import.meta.dir, "..", "package.json")).text();
  await Bun.write(join(versionDir, "package.json"), originalPkg);

  return versionDir;
}

/**
 * Create a simple mock Claude script that returns a fixed output
 * Lighter weight than createMockClaude() for branch name generation tests
 *
 * Uses a file-based output approach to avoid shell escaping issues with
 * complex strings containing quotes, newlines, or special characters.
 */
export async function createSimpleMockClaude(
  baseDir: string,
  options: {
    /** Output to return in the JSON result field */
    output: string;
    /** Exit code to return (default: 0) */
    exitCode?: number;
    /** Track invocations by touching a flag file (default: false) */
    trackInvocations?: boolean;
  }
): Promise<{ scriptPath: string; invocationFlagPath?: string }> {
  const scriptPath = join(baseDir, "simple-mock-claude");
  const outputPath = join(baseDir, "mock-claude-output.json");
  const invocationFlagPath = join(baseDir, "claude-was-called");

  const { output, exitCode = 0, trackInvocations = false } = options;

  // Write the JSON output to a file (avoids shell escaping issues)
  const jsonOutput = JSON.stringify({ result: output });
  await Bun.write(outputPath, jsonOutput);

  // Script reads from file instead of echoing escaped string
  // Optionally touches a flag file to track invocations
  const script = `#!/bin/bash
# Simple mock Claude CLI for testing
# Reads output from a file to avoid shell escaping issues
${trackInvocations ? `\ntouch "${invocationFlagPath}"` : ""}

cat "${outputPath}"
exit ${exitCode}
`;

  await Bun.write(scriptPath, script);
  await chmod(scriptPath, 0o755);

  return {
    scriptPath,
    ...(trackInvocations ? { invocationFlagPath } : {}),
  };
}
