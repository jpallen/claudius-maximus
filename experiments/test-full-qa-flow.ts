#!/usr/bin/env bun
/**
 * Full Q&A flow demonstration
 *
 * This shows how to:
 * 1. Run Claude until it asks a question
 * 2. Detect the question was asked (check for permission_denials with AskUserQuestion)
 * 3. Extract the question details
 * 4. Get user input (simulated here)
 * 5. Resume the session with the answer
 */

interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  permission_denials?: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input: AskUserQuestionInput;
  }>;
}

interface QuestionResult {
  sessionId: string;
  result: string;
  questionAsked: boolean;
  questionDetails?: {
    toolUseId: string;
    questions: AskUserQuestionInput["questions"];
  };
}

async function runClaude(args: string[]): Promise<QuestionResult> {
  const proc = Bun.spawn(["claude", ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  let sessionId = "";
  let result = "";
  let questionAsked = false;
  let questionDetails: QuestionResult["questionDetails"];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event: ClaudeEvent = JSON.parse(line);

      if (event.session_id && !sessionId) {
        sessionId = event.session_id;
      }

      // Check for AskUserQuestion tool_use
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion" && block.id) {
            const input = block.input as AskUserQuestionInput;
            if (input?.questions) {
              questionDetails = {
                toolUseId: block.id,
                questions: input.questions
              };
            }
          }
        }
      }

      // Check for permission denials (confirms question was denied)
      if (event.type === "result") {
        result = event.result || "";
        if (event.permission_denials?.some(d => d.tool_name === "AskUserQuestion")) {
          questionAsked = true;
          // Get question details from denial if not already captured
          if (!questionDetails) {
            const denial = event.permission_denials.find(d => d.tool_name === "AskUserQuestion");
            if (denial) {
              questionDetails = {
                toolUseId: denial.tool_use_id,
                questions: denial.tool_input.questions
              };
            }
          }
        }
      }
    } catch {}
  }

  return { sessionId, result, questionAsked, questionDetails };
}

async function main() {
  console.log("=== Full Q&A Flow Demo ===\n");

  const PROMPT = "I want to help you pick a good programming language. Ask me what kind of project I'm working on using the AskUserQuestion tool, then recommend a language based on my answer.";

  // Step 1: Initial run
  console.log("Step 1: Running Claude...\n");

  const result1 = await runClaude([
    "-p", PROMPT,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ]);

  console.log(`Session: ${result1.sessionId}`);
  console.log(`Question asked: ${result1.questionAsked}`);

  if (!result1.questionAsked || !result1.questionDetails) {
    console.log("No question was asked - unexpected behavior");
    return;
  }

  // Step 2: Display question to user
  console.log("\n--- Question from Claude ---");
  for (const q of result1.questionDetails.questions) {
    console.log(`\nQ: ${q.question}`);
    if (q.options) {
      console.log("Options:");
      for (const opt of q.options) {
        console.log(`  - ${opt.label}: ${opt.description || ""}`);
      }
    }
  }
  console.log("---\n");

  // Step 3: Simulate user selecting an answer
  const userAnswer = "I'm building a CLI tool that needs to be fast and have good developer experience";
  console.log(`User answer: "${userAnswer}"\n`);

  // Step 4: Resume with the answer
  console.log("Step 2: Resuming with answer...\n");

  const result2 = await runClaude([
    "--resume", result1.sessionId,
    "-p", `The user answered: "${userAnswer}"`,
    "--output-format", "stream-json",
    "--verbose",
    "--model", "haiku",
    "--dangerously-skip-permissions"
  ]);

  console.log("=== Claude's Response ===");
  console.log(result2.result);
  console.log("=========================\n");

  // Check if more questions were asked
  if (result2.questionAsked) {
    console.log("Note: Claude asked another question (would need another resume)");
  }

  console.log("=== Demo Complete ===");
}

main().catch(console.error);
