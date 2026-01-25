/**
 * Init command - scaffolds cm.yml and agent configurations
 */

import { Command } from "commander";
import { join } from "path";
import { mkdir } from "fs/promises";
import { findGitRoot } from "../lib/task/worktree";
import { CmError, NotInGitRepoError } from "../lib/errors";

/** Planning agent system prompt */
const PLANNING_AGENT_PROMPT = `# Planning Agent

You are a planning agent responsible for analyzing tasks and creating detailed implementation plans.

## Your Role
- Break down complex tasks into clear, actionable steps
- Identify potential challenges and edge cases
- Consider architectural implications
- Define acceptance criteria for each step

## Output Format
Create a structured plan with:
1. **Overview**: Brief summary of the approach
2. **Steps**: Numbered list of implementation steps
3. **Considerations**: Edge cases, risks, or dependencies
4. **Acceptance Criteria**: How to verify the implementation is complete

## Guidelines
- Be specific and actionable
- Consider the existing codebase structure
- Identify files that need to be created or modified
- Note any dependencies or prerequisites
- Keep steps small enough to be completed in one session
`;

/** Review agent system prompt */
const REVIEW_AGENT_PROMPT = `# Review Agent

You are a review agent responsible for critically evaluating plans and implementations.

## Your Role
- Verify completeness and correctness
- Identify gaps, bugs, or potential issues
- Suggest improvements
- Ensure quality standards are met

## Review Checklist
1. **Correctness**: Does it solve the problem correctly?
2. **Completeness**: Are all requirements addressed?
3. **Code Quality**: Is the code clean, readable, and maintainable?
4. **Edge Cases**: Are edge cases handled?
5. **Testing**: Are there adequate tests?
6. **Security**: Are there any security concerns?
7. **Performance**: Are there any performance issues?

## Output Format
Provide a structured review with:
1. **Summary**: Overall assessment (APPROVED / NEEDS CHANGES)
2. **Strengths**: What was done well
3. **Issues**: Problems that must be fixed (if any)
4. **Suggestions**: Optional improvements
5. **Action Items**: Specific changes required (if status is NEEDS CHANGES)
`;

/** Execution agent system prompt */
const EXECUTION_AGENT_PROMPT = `# Execution Agent

You are an execution agent responsible for implementing plans created by the planning agent.

## Your Role
- Follow the plan precisely
- Write clean, well-tested code
- Handle edge cases appropriately
- Document complex logic

## Guidelines
- Read the plan carefully before starting
- Implement one step at a time
- Write tests for new functionality
- Follow existing code patterns and conventions
- Commit logical units of work
- Ask for clarification if the plan is ambiguous

## Quality Standards
- All code must be properly formatted
- New functions should have clear names and documentation
- Error handling should be comprehensive
- Tests should cover happy path and edge cases
`;

/** Default cm.yml content */
const CM_YML_CONTENT = `# Claudius Maximus Workflow Configuration
version: "1"

workflows:
  # Default workflow: Claude orchestrates plan -> review -> execute -> review cycle
  default:
    prompt: |
      Plan first, then have the review agent review the plan.
      Go back and forth with the plan agent until the review agent is happy.
      Then execute, and review the execution.
      Iterate until the review agent is satisfied with the implementation.
      Ask for user input for any ambiguous review feedback.
    steps:
      - name: plan
        agent: planning-agent
        prompt: Create or refine the implementation plan based on feedback.

      - name: execute
        agent: execution-agent
        prompt: Implement based on the approved plan.

      - name: review
        agent: review-agent
        prompt: Critically review the current state and provide actionable feedback.

  # Quick workflow for simple tasks
  quick:
    prompt: |
      This is a simple task. Execute it directly without extensive planning.
      Complete it in one step if possible.
    steps:
      - name: execute
        prompt: Complete the task directly.

  # Plan-only workflow for complex analysis
  plan-only:
    prompt: |
      Create a comprehensive implementation plan. Have the review agent
      review it and iterate until the plan is solid. Do not execute.
    steps:
      - name: plan
        agent: planning-agent
        prompt: Create a thorough implementation plan.

      - name: review
        agent: review-agent
        prompt: Review the plan and provide feedback.
`;

/** Handle errors consistently */
function handleError(error: unknown): never {
  if (error instanceof CmError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${(error as Error).message}`);
  }
  process.exit(1);
}

export function createInitCommand(): Command {
  const init = new Command("init")
    .description("Initialize cm configuration in the current repository")
    .option("-f, --force", "Overwrite existing configuration")
    .action(async (options) => {
      try {
        // Find git root
        let repoPath: string;
        try {
          repoPath = await findGitRoot(process.cwd());
        } catch {
          throw new NotInGitRepoError();
        }

        const cmYmlPath = join(repoPath, "cm.yml");
        const claudeDir = join(repoPath, ".claude");
        const agentsDir = join(claudeDir, "agents");

        // Define agent file paths
        const agentFiles = [
          { path: join(agentsDir, "planning-agent.md"), content: PLANNING_AGENT_PROMPT },
          { path: join(agentsDir, "review-agent.md"), content: REVIEW_AGENT_PROMPT },
          { path: join(agentsDir, "execution-agent.md"), content: EXECUTION_AGENT_PROMPT },
        ];

        // Check for existing files
        const existingFiles: string[] = [];

        const cmYmlFile = Bun.file(cmYmlPath);
        if (await cmYmlFile.exists()) {
          existingFiles.push("cm.yml");
        }

        for (const { path } of agentFiles) {
          const file = Bun.file(path);
          if (await file.exists()) {
            existingFiles.push(path.replace(repoPath + "/", ""));
          }
        }

        if (existingFiles.length > 0 && !options.force) {
          console.log("The following files already exist:");
          for (const file of existingFiles) {
            console.log(`  ${file}`);
          }
          console.log("\nUse --force to overwrite.");
          return;
        }

        if (existingFiles.length > 0) {
          console.log("Overwriting existing files...");
        }

        // Create directories
        await mkdir(agentsDir, { recursive: true });

        // Write agent configuration files
        for (const { path, content } of agentFiles) {
          await Bun.write(path, content);
        }

        // Write cm.yml
        await Bun.write(cmYmlPath, CM_YML_CONTENT);

        console.log("Initialized Claudius Maximus configuration:");
        console.log("");
        console.log("  cm.yml                          - Workflow configuration");
        console.log("  .claude/agents/planning-agent.md  - Planning agent instructions");
        console.log("  .claude/agents/execution-agent.md - Execution agent instructions");
        console.log("  .claude/agents/review-agent.md    - Review agent instructions");
        console.log("");
        console.log("Available workflows:");
        console.log("  default    - Full cycle: plan -> review -> execute -> review");
        console.log("  quick      - Simple tasks: execute only");
        console.log("  plan-only  - Complex analysis: plan -> review");
        console.log("");
        console.log("Get started:");
        console.log('  cm task create "your task description"');
      } catch (error) {
        handleError(error);
      }
    });

  return init;
}
