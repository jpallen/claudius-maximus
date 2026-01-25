/**
 * Generate semantic branch names from task descriptions using Claude
 */

import { runClaude, parseClaudeOutput } from "../workflow/claude-runner";

/** Prompt for Claude to generate branch names */
const BRANCH_NAME_PROMPT = `Generate a short, descriptive git branch name for this task.

Requirements:
- Use kebab-case (lowercase words separated by hyphens)
- 2-5 words maximum
- Describe the main action/change (e.g., "implement-auth", "fix-pagination-bug", "add-user-settings")
- Start with a verb when possible (implement, add, fix, update, refactor, remove)
- No special characters except hyphens
- No spaces

Task description:
{description}

Return ONLY the branch name, nothing else. No explanation, no quotes, just the branch name.`;

/**
 * Generate a branch name from a task description using Claude
 *
 * @param description - The task description to generate a branch name from
 * @param cwd - Working directory for Claude CLI invocation. This is typically the
 *              repository root path. Required because Claude CLI needs to run in
 *              a valid directory context, even though this function doesn't use
 *              any files from the directory.
 * @returns Generated branch name, or null if generation fails
 */
export async function generateBranchName(
  description: string,
  cwd: string
): Promise<string | null> {
  // Handle empty or whitespace-only descriptions
  if (!description || !description.trim()) {
    return null;
  }

  try {
    const prompt = BRANCH_NAME_PROMPT.replace("{description}", description.trim());

    const result = await runClaude({
      prompt,
      model: "haiku", // Fast and cheap
      cwd,
      timeout: 10000, // 10 second timeout
      stream: false,
      // No tools needed - pure text generation
      allowedTools: [],
    });

    if (!result.success) {
      return null;
    }

    const parsed = parseClaudeOutput(result.stdout);
    if (!parsed.result) {
      return null;
    }

    // Clean and validate the result
    const branchName = cleanBranchName(parsed.result);

    if (!isValidBranchName(branchName)) {
      return null;
    }

    return branchName;
  } catch {
    // Fail silently - caller will use fallback
    return null;
  }
}

/**
 * Clean up Claude's response to get a valid branch name
 */
export function cleanBranchName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // Remove any quotes Claude might have added
    .replace(/^["'`]+|["'`]+$/g, "")
    // Remove any leading/trailing whitespace and newlines
    .trim()
    // Replace any remaining spaces with hyphens
    .replace(/\s+/g, "-")
    // Remove invalid characters (keep only alphanumeric and hyphens)
    .replace(/[^a-z0-9-]/g, "")
    // Collapse multiple hyphens
    .replace(/-+/g, "-")
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate that a string is a valid branch name
 */
export function isValidBranchName(name: string): boolean {
  // Must be non-empty
  if (!name || name.length === 0) return false;

  // Must be reasonable length (2-60 chars)
  if (name.length < 2 || name.length > 60) return false;

  // Must match expected format
  const pattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  return pattern.test(name);
}

/**
 * Ensure a branch name is unique by appending a suffix if needed
 */
export function ensureUniqueBranchName(
  name: string,
  existingIds: Set<string>
): string {
  if (!existingIds.has(name)) {
    return name;
  }

  // Try adding numeric suffixes
  let suffix = 2;
  while (true) {
    const candidate = `${name}-${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
    suffix++;

    // Safety limit
    if (suffix > 1000) {
      break;
    }
  }

  // This shouldn't happen, but fallback to timestamp
  return `${name}-${Date.now()}`;
}
