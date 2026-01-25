# Feature: Editor-based Description Input for `cm task create`

## Overview

When `cm task create` is called without a description argument, open the user's preferred text editor (respecting `$EDITOR` or `$VISUAL` environment variables, with sensible fallbacks) to allow them to write a multiline description. This mirrors the well-established pattern used by `git commit` when no `-m` message is provided.

## Current State Analysis

### Relevant Existing Code

1. **`src/commands/task.ts`** (lines 149-218)
   - Current command definition: `task.command("create <description>")`
   - The `<description>` argument is required - users must provide it
   - Command handles workflow selection, task creation, and optional auto-start

2. **Subprocess patterns** in codebase:
   - `src/lib/task/worktree.ts` uses `Bun.spawn()` extensively for git operations
   - `src/lib/workflow/claude-runner.ts` uses `Bun.spawn()` for Claude CLI invocation
   - Pattern: capture stdout/stderr with `"pipe"`, await `proc.exited`

3. **Error handling patterns**:
   - Custom errors extend `CmError` class in `src/lib/errors.ts`
   - Commands use `handleError()` function for consistent error display

4. **TTY detection**:
   - `isInteractive()` function already exists in `task.ts` (line 92-94)
   - Checks `process.stdin.isTTY === true`

### Integration Points

- The change is isolated to `src/commands/task.ts`
- May add a new utility module `src/lib/editor.ts` for reusability
- Error class addition to `src/lib/errors.ts`

## Requirements

### Functional Requirements

1. When `cm task create` is called without a description:
   - If running in an interactive terminal, open the user's editor
   - The editor should open a temporary file with optional template text
   - After the editor closes, read the file content as the description
   - If the description is empty (or only whitespace/comments), abort with a helpful message

2. If not running interactively (no TTY), show an error asking for a description argument

3. The existing behavior of `cm task create "description"` must remain unchanged

### Non-Functional Requirements

- **Editor resolution**: Check `$VISUAL`, then `$EDITOR`, then fallback to common editors (`nano`, `vim`, `vi`)
- **Cross-platform**: Work on Linux, macOS, and Windows (WSL-aware)
- **Cleanup**: Temporary files should be removed after use
- **Error handling**: Graceful handling of editor failures, missing editors, etc.

## Proposed Implementation

### Architecture

1. **New utility module**: `src/lib/editor.ts`
   - Contains editor resolution and spawning logic
   - Reusable for future features (e.g., editing workflow files)

2. **New error class**: `EditorError` in `src/lib/errors.ts`
   - For editor-related failures

3. **Modified command**: Update `src/commands/task.ts`
   - Change `<description>` to `[description]` (optional argument)
   - Add logic to prompt via editor when description is missing

### Detailed Steps

#### Step 1: Add `EditorError` to `src/lib/errors.ts`

```typescript
/** Error when editor operations fail */
export class EditorError extends CmError {
  constructor(message: string) {
    super(`Editor error: ${message}`);
    this.name = "EditorError";
  }
}
```

#### Step 2: Create `src/lib/editor.ts`

```typescript
/**
 * Text editor utility for interactive input
 */

import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import { EditorError } from "./errors";

/** Template content shown in the editor */
const DESCRIPTION_TEMPLATE = `
# Enter your task description above this line.
# Lines starting with '#' will be ignored.
#
# A good description includes:
#   - What you want to accomplish
#   - Any specific requirements or constraints
#   - Context that might be helpful
#
# Save and close the editor when done.
# Leave empty to abort.
`;

/**
 * Resolve the user's preferred editor
 * Checks $VISUAL, $EDITOR, then common fallbacks
 */
export function resolveEditor(): string | null {
  // Check environment variables first
  const visual = process.env.VISUAL;
  if (visual) return visual;

  const editor = process.env.EDITOR;
  if (editor) return editor;

  // Platform-specific fallbacks
  // On macOS/Linux, try nano, vim, vi in order
  // These are almost always available
  return "nano";
}

/**
 * Open an editor for the user to input text
 * Returns the text entered (stripped of comments and trimmed)
 */
export async function openEditorForInput(options?: {
  /** Template/instructions to show in the file */
  template?: string;
  /** File extension for syntax highlighting */
  extension?: string;
}): Promise<string> {
  const editor = resolveEditor();

  if (!editor) {
    throw new EditorError(
      "No editor found. Set $EDITOR or $VISUAL environment variable."
    );
  }

  const template = options?.template ?? DESCRIPTION_TEMPLATE;
  const extension = options?.extension ?? "md";

  // Create a temporary file
  const tempPath = join(
    tmpdir(),
    `cm-description-${Date.now()}.${extension}`
  );

  try {
    // Write template to temp file
    await Bun.write(tempPath, template);

    // Open editor and wait for it to close
    // Use stdio: "inherit" so the editor can interact with the terminal
    const proc = Bun.spawn(editor.split(/\s+/).concat(tempPath), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new EditorError(
        `Editor exited with code ${exitCode}`
      );
    }

    // Read the file content
    const content = await Bun.file(tempPath).text();

    // Strip comments and trim
    const description = stripComments(content);

    return description;
  } finally {
    // Clean up temp file
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Strip comment lines (starting with #) and trim whitespace
 */
function stripComments(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}
```

#### Step 3: Update `src/commands/task.ts`

Change the command definition from:
```typescript
task
  .command("create <description>")
```

To:
```typescript
task
  .command("create [description]")
```

Update the action handler to handle the optional description:

```typescript
.action(async (description: string | undefined, options) => {
  try {
    // If no description provided, open editor
    if (!description) {
      if (!isInteractive()) {
        console.error(
          "Error: Description required. Provide it as an argument or run interactively."
        );
        console.error('Usage: cm task create "your description"');
        process.exit(1);
      }

      // Import editor utility
      const { openEditorForInput } = await import("../lib/editor");

      description = await openEditorForInput();

      if (!description) {
        console.log("Aborted: empty description.");
        return;
      }
    }

    // ... rest of existing code unchanged ...
  } catch (error) {
    handleError(error);
  }
});
```

#### Step 4: Add import for EditorError

Add `EditorError` to the imports from `../lib/errors` in `task.ts` if needed for specific error handling.

### API/Interface Design

#### New Public Functions in `src/lib/editor.ts`:

```typescript
/**
 * Resolve the user's preferred text editor
 * @returns Editor command string or null if none found
 */
function resolveEditor(): string | null

/**
 * Open an editor for the user to input multiline text
 * @param options.template - Initial content/instructions to show
 * @param options.extension - File extension (default: "md")
 * @returns User's input (comments stripped, trimmed)
 * @throws EditorError if editor fails or cannot be found
 */
async function openEditorForInput(options?: {
  template?: string;
  extension?: string;
}): Promise<string>
```

## Testing Strategy

### Unit Tests (New file: `tests/editor.test.ts`)

1. **`resolveEditor()` tests**:
   - Returns `$VISUAL` when set
   - Returns `$EDITOR` when `$VISUAL` is not set
   - Falls back to `"nano"` when neither is set

2. **`stripComments()` tests** (would need to export for testing):
   - Removes lines starting with `#`
   - Preserves non-comment lines
   - Handles mixed content
   - Handles empty input

### Integration Tests (In `tests/task.test.ts`)

1. **`cm task create` with description argument**:
   - Existing tests should continue to pass
   - Verify description is used as provided

2. **`cm task create` without description (non-interactive)**:
   - Should exit with error code 1
   - Should show helpful error message

3. **`cm task create` without description (interactive with mock editor)**:
   - Create a mock editor script that writes content to the file
   - Set `$EDITOR` to the mock script
   - Verify task is created with the editor content as description

4. **`cm task create` with empty editor content**:
   - Mock editor that leaves file empty/comments-only
   - Verify command aborts gracefully

### Edge Cases to Cover

- Editor command with spaces/arguments (e.g., `code --wait`)
- Very long descriptions
- Descriptions with special characters, newlines
- Editor that doesn't exist (e.g., `$EDITOR` set to invalid path)
- Temp file permission issues (catch and report gracefully)

## Migration/Rollout

### Backward Compatibility

- **Fully backward compatible**: Existing usage with description argument works identically
- The only change for existing users is that the argument is now optional

### No Migration Required

- No config changes
- No data format changes
- No API changes to existing commands

## Open Questions

None - the implementation approach is clear and follows established patterns from `git commit`.

## Appendix

### Reference: How Git Handles This

Git commit checks for the `-m` flag. If not present:
1. Checks `$GIT_EDITOR`, then `core.editor` config, then `$VISUAL`, then `$EDITOR`, then fallback
2. Creates temp file with template (status, etc.)
3. Opens editor and waits
4. Reads file, strips comments (lines starting with `#`)
5. If empty, aborts commit

Our implementation mirrors this proven UX pattern.

### Alternative Approaches Considered

1. **Interactive prompt with readline**: Would work but doesn't support multiline easily
2. **Reading from stdin**: Works for piping but less discoverable UX
3. **Always require argument**: Current behavior - less ergonomic for long descriptions

The editor approach is preferred because:
- Familiar pattern from git
- Supports multiline naturally
- User can use their preferred editor with familiar keybindings
- Template provides guidance
