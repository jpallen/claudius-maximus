#!/usr/bin/env bun
/**
 * Test resuming a session with the user's answer
 *
 * Approach:
 * 1. Run Claude until it asks a question (gets denied)
 * 2. Capture the session ID and the question
 * 3. Resume the session with the answer as the prompt
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const INITIAL_PROMPT = "Ask the user what their favourite colour is using the AskUserQuestion tool. Once you get their answer, respond with 'Your favourite colour is X!'";

interface QuestionInfo {
  toolUseId: string;
  question: string;
  options: string[];
}

async function runClaude(args: string[]): Promise<{ sessionId: string; output: string; question?: QuestionInfo }> {
  const claude = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const rl = createInterface({ input: claude.stdout });
  let sessionId = "";
  let output = "";
  let question: QuestionInfo | undefined;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);

      if (event.session_id) {
        sessionId = event.session_id;
      }

      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            const q = block.input?.questions?.[0];
            if (q) {
              question = {
                toolUseId: block.id,
                question: q.question,
                options: q.options?.map((o: { label: string }) => o.label) || []
              };
            }
          }
          if (block.type === "text") {
            output += block.text;
          }
        }
      }

      if (event.type === "result") {
        output = event.result || output;
      }
    } catch {
      // ignore
    }
  }

  await new Promise<number>((resolve) => claude.on("close", resolve));

  return { sessionId, output, question };
}

async function main() {
  console.log("=== Step 1: Run Claude to get a question ===\n");

  const result1 = await runClaude([
    "-p", INITIAL_PROMPT,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ]);

  console.log(`Session ID: ${result1.sessionId}`);
  console.log(`Output: ${result1.output.slice(0, 100)}...`);

  if (result1.question) {
    console.log(`\nQuestion detected: ${result1.question.question}`);
    console.log(`Options: ${result1.question.options.join(", ")}`);
  } else {
    console.log("\nNo question detected - session may have handled it differently");
    return;
  }

  // Simulate user providing an answer
  const userAnswer = "Blue";
  console.log(`\n=== Step 2: Resume with answer: ${userAnswer} ===\n`);

  const result2 = await runClaude([
    "--resume", result1.sessionId,
    "-p", `The user answered: ${userAnswer}`,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ]);

  console.log(`Session ID: ${result2.sessionId}`);
  console.log(`Output: ${result2.output}`);

  console.log("\n=== Done ===");
}

main().catch(console.error);
