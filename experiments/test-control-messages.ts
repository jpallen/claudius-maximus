#!/usr/bin/env bun
/**
 * Test using control messages to pre-authorize or respond to AskUserQuestion
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const PROMPT = "Ask the user what their favourite colour is using the AskUserQuestion tool. Once you get their answer, respond with a message mentioning their colour.";

async function main() {
  console.log("=== Testing control messages ===\n");

  const claude = spawn("claude", [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "-p"
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  // Collect stderr for any error messages
  let stderr = "";
  claude.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // Test 1: Try a control message to see what types are supported
  const controlMessages = [
    { type: "control", subtype: "permission_response", tool_use_id: "test", allowed: true },
    { type: "control", action: "approve_tool", tool_name: "AskUserQuestion" },
  ];

  for (const msg of controlMessages) {
    console.log(`Testing: ${JSON.stringify(msg)}`);
    claude.stdin.write(JSON.stringify(msg) + "\n");
  }

  // Now send the actual prompt
  const userMessage = {
    type: "user",
    message: {
      role: "user",
      content: PROMPT
    }
  };
  claude.stdin.write(JSON.stringify(userMessage) + "\n");
  console.log(">>> Sent initial prompt\n");

  // Read stdout line by line
  const rl = createInterface({ input: claude.stdout });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);

      if (event.type === "error") {
        console.log(`ERROR: ${JSON.stringify(event)}`);
      } else if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use") {
            console.log(`Tool use: ${block.name} (${block.id})`);
          }
          if (block.type === "text") {
            console.log(`Assistant: ${block.text}`);
          }
        }
      } else if (event.type === "result") {
        console.log(`Result: ${event.result?.slice(0, 200)}`);
        break;
      } else if (event.type !== "system") {
        console.log(`Event: ${event.type}/${event.subtype || ""}`);
      }
    } catch (e) {
      console.log(`Parse error: ${line.slice(0, 100)}`);
    }
  }

  claude.stdin.end();

  const exitCode = await new Promise<number>((resolve) => {
    claude.on("close", resolve);
  });

  if (stderr) {
    console.log(`\nStderr: ${stderr}`);
  }
  console.log(`Exit code: ${exitCode}`);
}

main().catch(console.error);
