import { Command } from "commander";
import { resolve } from "path";
import {
  getDevVersionPath,
  setDevVersionPath,
  clearDevVersionPath,
  getConfigPath,
} from "../lib/config";
import { CLI_NAME } from "../lib/constants";

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

        // Check if the file exists
        const file = Bun.file(devPath);
        if (await file.exists()) {
          console.log("Status: File exists");
        } else {
          console.log("Status: File NOT FOUND (will use self)");
        }
      } else {
        console.log("No dev version configured (using self)");
      }
      console.log(`\nConfig file: ${getConfigPath()}`);
    });

  dev
    .command("set <path>")
    .description("Set the path to a dev version binary")
    .action(async (path: string) => {
      const resolvedPath = resolve(path);

      // Check if file exists
      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) {
        console.warn(`Warning: File does not exist at ${resolvedPath}`);
        console.warn("Setting anyway - make sure the path is correct.");
      }

      await setDevVersionPath(resolvedPath);
      console.log(`Dev version set to: ${resolvedPath}`);
      console.log(`\nCommands will now proxy to this binary.`);
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
    .description("Show dev mode status and test the configured binary")
    .action(async () => {
      const devPath = await getDevVersionPath();

      if (!devPath) {
        console.log("Dev mode: DISABLED (using self)");
        return;
      }

      console.log("Dev mode: ENABLED");
      console.log(`Binary path: ${devPath}`);

      const file = Bun.file(devPath);
      if (!(await file.exists())) {
        console.log("Status: ERROR - Binary not found!");
        return;
      }

      // Try to get version from the dev binary
      try {
        const proc = Bun.spawn([devPath, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode === 0) {
          console.log(`Dev binary version: ${output.trim()}`);
        } else {
          console.log("Status: Binary exists but --version failed");
        }
      } catch (error) {
        console.log("Status: Could not execute binary");
      }
    });

  return dev;
}

/**
 * Check if we should proxy to a dev version and do so if needed.
 * Returns true if we proxied (and should exit), false otherwise.
 */
export async function maybeProxyToDevVersion(args: string[]): Promise<boolean> {
  // Don't proxy dev commands themselves to avoid infinite loops
  if (args.length >= 1 && args[0] === "dev") {
    return false;
  }

  const devPath = await getDevVersionPath();
  if (!devPath) {
    return false;
  }

  const file = Bun.file(devPath);
  if (!(await file.exists())) {
    console.error(`Warning: Dev binary not found at ${devPath}`);
    console.error("Falling back to self. Use 'cm dev clear' to reset.\n");
    return false;
  }

  // Proxy to the dev version
  const proc = Bun.spawn([devPath, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
