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

defaults:
  allowedTools:
    - Read
    - Write
    - Edit
    - Bash
    - Glob
    - Grep

workflows:
  # Default workflow: plan -> review -> execute -> review
  default:
    steps:
      - name: plan
        agent: sonnet
        prompt: |
          Read the task description and create a detailed implementation plan.

          Task: {description}

          Follow the planning agent guidelines in .claude/agents/planning-agent.md

          Output a structured plan that the execution agent can follow.

      - name: plan-review
        agent: sonnet
        prompt: |
          Review the implementation plan created in the previous step.

          Read .claude/agents/review-agent.md for review guidelines.

          If the plan needs changes, clearly specify what needs to be fixed.
          If the plan is good, approve it and summarize the key points.

      - name: execute
        agent: sonnet
        prompt: |
          Implement the approved plan from the planning phase.

          Read .claude/agents/execution-agent.md for execution guidelines.

          Follow the plan step by step. Write clean, tested code.

      - name: review
        agent: sonnet
        prompt: |
          Review the implementation completed in the previous step.

          Read .claude/agents/review-agent.md for review guidelines.

          Verify:
          - All planned steps were completed
          - Code quality meets standards
          - Tests pass and cover the changes
          - No obvious bugs or issues

  # Quick workflow for simple tasks
  quick:
    steps:
      - name: execute
        agent: sonnet
        prompt: |
          Complete the following task:

          {description}

          This is a simple task - implement it directly without extensive planning.

  # Plan-only workflow for complex analysis
  plan-only:
    steps:
      - name: plan
        agent: opus
        prompt: |
          Analyze the following task and create a comprehensive implementation plan:

          {description}

          Follow the planning agent guidelines in .claude/agents/planning-agent.md

          Be thorough - this plan will be reviewed and executed later.

      - name: plan-review
        agent: opus
        prompt: |
          Critically review the implementation plan.

          Read .claude/agents/review-agent.md for review guidelines.

          Identify any gaps, risks, or improvements needed.
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

        // Check if cm.yml already exists
        const cmYmlFile = Bun.file(cmYmlPath);
        if (await cmYmlFile.exists()) {
          if (!options.force) {
            console.log("cm.yml already exists. Use --force to overwrite.");
            return;
          }
          console.log("Overwriting existing cm.yml...");
        }

        // Create directories
        await mkdir(agentsDir, { recursive: true });

        // Write agent configuration files
        await Bun.write(
          join(agentsDir, "planning-agent.md"),
          PLANNING_AGENT_PROMPT
        );
        await Bun.write(
          join(agentsDir, "review-agent.md"),
          REVIEW_AGENT_PROMPT
        );
        await Bun.write(
          join(agentsDir, "execution-agent.md"),
          EXECUTION_AGENT_PROMPT
        );

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
