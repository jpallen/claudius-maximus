#!/usr/bin/env bun
/**
 * Test resuming with answer - simpler version using exec
 */

const INITIAL_PROMPT = "Ask the user what their favourite colour is using the AskUserQuestion tool. Once you get their answer, respond with 'Your favourite colour is X!'";

async function main() {
  console.log("=== Step 1: Run Claude to get a question ===\n");

  // Run first session
  const proc1 = Bun.spawn([
    "claude",
    "-p", INITIAL_PROMPT,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout1 = await new Response(proc1.stdout).text();
  await proc1.exited;

  // Parse output
  let sessionId = "";
  let question = "";

  for (const line of stdout1.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.session_id && !sessionId) {
        sessionId = event.session_id;
      }
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            question = block.input?.questions?.[0]?.question || "";
          }
        }
      }
    } catch {}
  }

  console.log(`Session ID: ${sessionId}`);
  console.log(`Question: ${question}`);

  if (!sessionId || !question) {
    console.log("\nNo session or question found");
    return;
  }

  console.log("\n=== Step 2: Resume with answer ===\n");

  // Resume with answer
  const proc2 = Bun.spawn([
    "claude",
    "--resume", sessionId,
    "-p", "The user answered: Blue. Blue is their favourite colour.",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout2 = await new Response(proc2.stdout).text();
  await proc2.exited;

  console.log("Output from resumed session:\n");

  for (const line of stdout2.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            console.log(`Assistant: ${block.text}`);
          }
        }
      }
      if (event.type === "result") {
        console.log(`\nFinal result: ${event.result}`);
      }
    } catch {}
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
