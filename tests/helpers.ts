import { mkdtemp, rm } from "fs/promises";
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
