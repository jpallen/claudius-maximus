#!/usr/bin/env bun
import { Command } from "commander";
import { APP_NAME, CLI_NAME, VERSION } from "./lib/constants";
import { createDevCommand, maybeProxyToDevVersion } from "./commands/dev";

async function main() {
  // Get args without the binary path
  const args = process.argv.slice(2);

  // Check if we should proxy to a dev version
  // This happens for all commands EXCEPT 'dev' subcommands
  const proxied = await maybeProxyToDevVersion(args);
  if (proxied) {
    return; // We proxied, so we're done
  }

  // Create the main program
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`${APP_NAME} - Your CLI companion`)
    .version(VERSION, "-v, --version", "Display version number");

  // Add dev command
  program.addCommand(createDevCommand());

  // Add a placeholder command to show the structure works
  program
    .command("hello [name]")
    .description("Say hello (placeholder command)")
    .action((name?: string) => {
      console.log(`Hello, ${name ?? "world"}! I am ${APP_NAME}.`);
    });

  // Parse and execute
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
