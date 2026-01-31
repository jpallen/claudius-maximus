#!/usr/bin/env bun
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { APP_NAME, CLI_NAME, VERSION } from "./lib/constants";
import { createDevCommand, maybeProxyToDevVersion } from "./commands/dev";
import { isInTmux, isTmuxInstalled } from "./lib/tmux/detector";
import { launchInTmux } from "./lib/tmux/launcher";
import { App } from "./tui/App";

async function main() {
  // Get args without the binary path
  const args = process.argv.slice(2);

  // Check if we should proxy to a dev version
  // This happens for all commands EXCEPT 'dev' subcommands
  const proxied = await maybeProxyToDevVersion(args);
  if (proxied) {
    return; // We proxied, so we're done
  }

  // Handle 'dev' subcommand with Commander.js
  if (args.length >= 1 && args[0] === "dev") {
    const program = new Command();
    program
      .name(CLI_NAME)
      .description(`${APP_NAME} - Your CLI companion`)
      .version(VERSION, "-v, --version", "Display version number");

    program.addCommand(createDevCommand());

    await program.parseAsync(process.argv);
    return;
  }

  // Handle --version and --help flags
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${APP_NAME} v${VERSION}`);
    console.log(`\nUsage: ${CLI_NAME} [command]`);
    console.log(`\nCommands:`);
    console.log(`  dev           Manage dev mode - use a different version for testing`);
    console.log(`  (default)     Open the task manager TUI`);
    console.log(`\nThe TUI will launch inside tmux. If tmux is not running, it will be started automatically.`);
    return;
  }

  // For everything else, launch the TUI
  await launchTui();
}

async function launchTui(): Promise<void> {
  // Check if tmux is installed
  if (!(await isTmuxInstalled())) {
    console.error("Error: tmux is required but not installed.");
    console.error("Please install tmux and try again.");
    console.error("\nOn macOS: brew install tmux");
    console.error("On Ubuntu/Debian: sudo apt install tmux");
    process.exit(1);
  }

  // If not in tmux, launch tmux with cm inside
  if (!isInTmux()) {
    await launchInTmux();
    return; // launchInTmux will exit the process
  }

  // We're in tmux, render the TUI
  const { waitUntilExit } = render(React.createElement(App));
  await waitUntilExit();
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
