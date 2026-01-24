import { Command } from "commander";
import { resolve, join } from "path";
import { stat } from "fs/promises";
import {
  getDevVersionPath,
  setDevVersionPath,
  clearDevVersionPath,
  getConfigPath,
} from "../lib/config";
import { CLI_NAME } from "../lib/constants";

/** Environment variable set when running as a proxied dev version */
const DEV_PROXY_ENV = "CM_DEV_PROXY";

/**
 * Determines how to run the dev version based on the path type:
 * - Directory: run `bun run <dir>/src/index.ts`
 * - .ts file: run `bun run <file>`
 * - Binary: run directly
 */
async function resolveDevTarget(devPath: string): Promise<{
  exists: boolean;
  type: "directory" | "typescript" | "binary";
  entrypoint: string;
  runArgs: string[];
} | null> {
  try {
    const stats = await stat(devPath);

    if (stats.isDirectory()) {
      // Look for src/index.ts in the directory
      const entrypoint = join(devPath, "src", "index.ts");
      const entryFile = Bun.file(entrypoint);
      if (await entryFile.exists()) {
        return {
          exists: true,
          type: "directory",
          entrypoint,
          runArgs: ["bun", "run", entrypoint],
        };
      }
      return null;
    }

    if (devPath.endsWith(".ts")) {
      return {
        exists: true,
        type: "typescript",
        entrypoint: devPath,
        runArgs: ["bun", "run", devPath],
      };
    }

    // Assume binary
    return {
      exists: true,
      type: "binary",
      entrypoint: devPath,
      runArgs: [devPath],
    };
  } catch {
    return null;
  }
}

export function createDevCommand(): Command {
  const dev = new Command("dev")
    .description("Manage dev mode - use a different version for testing");

  dev
    .command("list")
    .alias("ls")
    .description("Show the currently configured dev version path")
    .action(async () => {
      const devPath = await getDevVersionPath();
      if (devPath) {
        console.log(`Dev version path: ${devPath}`);

        const target = await resolveDevTarget(devPath);
        if (target) {
          console.log(`Type: ${target.type}`);
          if (target.type === "directory") {
            console.log(`Entry point: ${target.entrypoint}`);
          }
        } else {
          console.log("Status: NOT FOUND (will use self)");
        }
      } else {
        console.log("No dev version configured (using self)");
      }
      console.log(`\nConfig file: ${getConfigPath()}`);
    });

  dev
    .command("set <path>")
    .description("Set the path to a dev version (directory, .ts file, or binary)")
    .action(async (path: string) => {
      const resolvedPath = resolve(path);
      const target = await resolveDevTarget(resolvedPath);

      if (!target) {
        console.warn(`Warning: Could not resolve dev target at ${resolvedPath}`);
        console.warn("For directories, ensure src/index.ts exists.");
        console.warn("Setting anyway - make sure the path is correct.");
      } else {
        console.log(`Detected type: ${target.type}`);
        if (target.type === "directory") {
          console.log(`Entry point: ${target.entrypoint}`);
        }
      }

      await setDevVersionPath(resolvedPath);
      console.log(`\nDev version set to: ${resolvedPath}`);
      console.log(`Commands will now proxy to this version.`);
      console.log(`Use '${CLI_NAME} dev clear' to reset.`);
    });

  dev
    .command("clear")
    .description("Clear the dev version path (use self)")
    .action(async () => {
      await clearDevVersionPath();
      console.log("Dev version cleared. Using self for all commands.");
    });

  dev
    .command("status")
    .description("Show dev mode status and test the configured version")
    .action(async () => {
      const devPath = await getDevVersionPath();

      if (!devPath) {
        console.log("Dev mode: DISABLED (using self)");
        return;
      }

      console.log("Dev mode: ENABLED");
      console.log(`Path: ${devPath}`);

      const target = await resolveDevTarget(devPath);
      if (!target) {
        console.log("Status: ERROR - Target not found!");
        return;
      }

      console.log(`Type: ${target.type}`);
      if (target.type === "directory") {
        console.log(`Entry point: ${target.entrypoint}`);
      }

      // Try to get version from the dev version
      try {
        const proc = Bun.spawn([...target.runArgs, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            [DEV_PROXY_ENV]: "1",
          },
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode === 0) {
          console.log(`Dev version: ${output.trim()}`);
        } else {
          console.log("Status: Target exists but --version failed");
        }
      } catch (error) {
        console.log("Status: Could not execute target");
      }
    });

  return dev;
}

/**
 * Check if we should proxy to a dev version and do so if needed.
 * Returns true if we proxied (and should exit), false otherwise.
 */
export async function maybeProxyToDevVersion(args: string[]): Promise<boolean> {
  // Don't proxy if we're already running as a proxied dev version
  if (process.env[DEV_PROXY_ENV] === "1") {
    return false;
  }

  // Don't proxy dev commands themselves to avoid infinite loops
  if (args.length >= 1 && args[0] === "dev") {
    return false;
  }

  const devPath = await getDevVersionPath();
  if (!devPath) {
    return false;
  }

  const target = await resolveDevTarget(devPath);
  if (!target) {
    console.error(`Warning: Dev target not found at ${devPath}`);
    console.error("Falling back to self. Use 'cm dev clear' to reset.\n");
    return false;
  }

  // Proxy to the dev version with env var to prevent recursion
  const proc = Bun.spawn([...target.runArgs, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...process.env,
      [DEV_PROXY_ENV]: "1",
    },
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
