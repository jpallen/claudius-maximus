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
export function stripComments(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}
