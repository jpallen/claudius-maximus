/**
 * Generate semantic branch names from task descriptions using Claude
 */

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
 * @param cwd - Working directory for Claude CLI invocation
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
    const claudeCommand = process.env.CM_CLAUDE_COMMAND || "claude";

    const proc = Bun.spawn([claudeCommand, "-p", prompt, "--model", "haiku", "--allowedTools", ""], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Set up timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 10000);
    });

    const resultPromise = (async () => {
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return null;
      }

      const stdout = await new Response(proc.stdout).text();

      // Parse Claude's JSON output
      try {
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            const data = JSON.parse(line);
            if (data.type === "result" && data.result) {
              const branchName = cleanBranchName(data.result);
              if (isValidBranchName(branchName)) {
                return branchName;
              }
            }
          }
        }
      } catch {
        // JSON parse failed, try treating raw output as branch name
        const branchName = cleanBranchName(stdout);
        if (isValidBranchName(branchName)) {
          return branchName;
        }
      }

      return null;
    })();

    return await Promise.race([resultPromise, timeoutPromise]);
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
