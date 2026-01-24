/**
 * Claude Code hooks setup for task completion tracking
 */

import { join } from "path";
import { mkdir } from "fs/promises";

/** The command to run when Claude tries to stop */
const CM_STOP_HOOK_COMMAND = "cm system stop-hook";

/**
 * Setup the Claude Stop hook in a worktree
 *
 * This configures Claude Code to call `cm system stop-hook` before exiting,
 * which verifies that the step has been explicitly marked complete or failed.
 */
export async function setupStopHook(worktreePath: string): Promise<void> {
  const claudeDir = join(worktreePath, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  const file = Bun.file(settingsPath);

  // Load existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      settings = JSON.parse(await file.text());
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Ensure hooks.Stop array exists
  if (!settings.hooks) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Stop) {
    hooks.Stop = [];
  }

  // Check if CM stop hook already registered
  const hasCmHook = hooks.Stop.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const entryObj = entry as Record<string, unknown>;
    const entryHooks = entryObj.hooks;
    if (!Array.isArray(entryHooks)) return false;
    return entryHooks.some((h: unknown) => {
      if (typeof h !== "object" || h === null) return false;
      return (h as Record<string, unknown>).command === CM_STOP_HOOK_COMMAND;
    });
  });

  if (!hasCmHook) {
    // Append our hook
    hooks.Stop.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: CM_STOP_HOOK_COMMAND,
        },
      ],
    });

    await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
  }
}
