#!/usr/bin/env bun
/**
 * Test injecting a tool_result for AskUserQuestion through stream-json input
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const PROMPT = "Ask the user what their favourite colour is using the AskUserQuestion tool. Once you get their answer, respond with a message mentioning their colour.";

async function main() {
  console.log("=== Testing tool_result injection for AskUserQuestion ===\n");

  const claude = spawn("claude", [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "-p"
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  // Track pending tool uses that need answers
  let pendingToolUseId: string | null = null;

  // Send initial prompt
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
      console.log(`Event: ${event.type}${event.subtype ? "/" + event.subtype : ""}`);

      // Check for tool_use events
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            console.log(`\n>>> AskUserQuestion tool_use detected!`);
            console.log(`    tool_use_id: ${block.id}`);
            console.log(`    Question: ${JSON.stringify(block.input?.questions)}\n`);

            pendingToolUseId = block.id;

            // Try to inject our answer immediately
            const toolResult = {
              type: "user",
              message: {
                role: "user",
                content: [{
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: 'User has answered your questions: "What is your favourite colour?"="Blue". You can now continue with the conversation.'
                }]
              }
            };

            console.log(">>> Injecting tool_result with answer: Blue");
            claude.stdin.write(JSON.stringify(toolResult) + "\n");
          }

          if (block.type === "text") {
            console.log(`    Text: ${block.text}`);
          }
        }
      }

      // Check for existing tool_result errors (permission denials)
      if (event.type === "user" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_result" && block.is_error) {
            console.log(`    Tool result (error): ${block.content}`);
          }
        }
      }

      // Check for final result
      if (event.type === "result") {
        console.log(`\n>>> Final result:`);
        console.log(`    Success: ${!event.is_error}`);
        console.log(`    Result: ${event.result}`);
        if (event.permission_denials?.length) {
          console.log(`    Permission denials: ${event.permission_denials.length}`);
        }
        break;
      }
    } catch (e) {
      console.log(`Raw: ${line.slice(0, 100)}...`);
    }
  }

  claude.stdin.end();

  const exitCode = await new Promise<number>((resolve) => {
    claude.on("close", resolve);
  });

  console.log(`\n=== Exit code: ${exitCode} ===`);
}

main().catch(console.error);
