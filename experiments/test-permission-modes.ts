#!/usr/bin/env bun
/**
 * Test different permission modes to see if any allow AskUserQuestion
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const PROMPT = "Ask the user what their favourite colour is using the AskUserQuestion tool.";

const permissionModes = ["default", "acceptEdits", "bypassPermissions", "delegate", "dontAsk"];

async function testMode(mode: string): Promise<boolean> {
  console.log(`\n=== Testing permission-mode: ${mode} ===`);

  const claude = spawn("claude", [
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--permission-mode", mode,
    "-p",
    PROMPT
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const rl = createInterface({ input: claude.stdout });
  let hadDenial = false;
  let result = "";

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);

      if (event.type === "user" && event.tool_use_result?.includes("Error")) {
        hadDenial = true;
        console.log(`  Denial: ${event.tool_use_result}`);
      }

      if (event.type === "result") {
        result = event.result || "";
        if (event.permission_denials?.length) {
          console.log(`  Permission denials: ${event.permission_denials.length}`);
          hadDenial = true;
        }
      }
    } catch {
      // ignore
    }
  }

  await new Promise<number>((resolve) => claude.on("close", resolve));

  console.log(`  Result: ${result.slice(0, 100)}...`);
  console.log(`  Had denial: ${hadDenial}`);

  return !hadDenial;
}

async function main() {
  console.log("=== Testing all permission modes for AskUserQuestion ===");

  for (const mode of permissionModes) {
    try {
      const success = await testMode(mode);
      if (success) {
        console.log(`\n>>> ${mode} worked without denial!`);
      }
    } catch (e) {
      console.log(`  Error: ${e}`);
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
