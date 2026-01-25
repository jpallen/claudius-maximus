import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveEditor, stripComments, openEditorForInput } from "../src/lib/editor";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveEditor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment
    process.env.VISUAL = originalEnv.VISUAL;
    process.env.EDITOR = originalEnv.EDITOR;
  });

  it("returns $VISUAL when set", () => {
    process.env.VISUAL = "code --wait";
    process.env.EDITOR = "vim";

    expect(resolveEditor()).toBe("code --wait");
  });

  it("returns $EDITOR when $VISUAL is not set", () => {
    delete process.env.VISUAL;
    process.env.EDITOR = "vim";

    expect(resolveEditor()).toBe("vim");
  });

  it("falls back to nano when neither is set", () => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;

    expect(resolveEditor()).toBe("nano");
  });
});

describe("stripComments", () => {
  it("removes lines starting with #", () => {
    const input = `# This is a comment
Hello world
# Another comment
Goodbye`;

    expect(stripComments(input)).toBe("Hello world\nGoodbye");
  });

  it("preserves non-comment lines", () => {
    const input = `Line 1
Line 2
Line 3`;

    expect(stripComments(input)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles mixed content", () => {
    const input = `# Comment at start
First line
  # Indented comment
Second line
# Comment at end`;

    expect(stripComments(input)).toBe("First line\nSecond line");
  });

  it("handles empty input", () => {
    expect(stripComments("")).toBe("");
  });

  it("handles only comments", () => {
    const input = `# Comment 1
# Comment 2
# Comment 3`;

    expect(stripComments(input)).toBe("");
  });

  it("handles lines with # in the middle", () => {
    const input = `This has a # in it
# This is a comment
Another line with # symbol`;

    expect(stripComments(input)).toBe("This has a # in it\nAnother line with # symbol");
  });

  it("trims leading and trailing whitespace", () => {
    const input = `

# Comment
Hello

# Another comment

World

`;

    expect(stripComments(input)).toBe("Hello\n\n\nWorld");
  });
});

describe("openEditorForInput", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "editor-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    // Restore original environment
    process.env.EDITOR = originalEnv.EDITOR;
    process.env.VISUAL = originalEnv.VISUAL;
  });

  it("returns content from editor (mock editor that writes content)", async () => {
    // Create a mock editor script that writes content to the file
    const mockEditorPath = join(tempDir, "mock-editor.sh");
    await Bun.write(
      mockEditorPath,
      `#!/bin/bash
# Write content to the file (first argument)
cat > "$1" << 'EOF'
My task description

This is a multiline description.
# This comment should be stripped
EOF
`
    );
    await Bun.$`chmod +x ${mockEditorPath}`;

    process.env.EDITOR = mockEditorPath;
    delete process.env.VISUAL;

    const result = await openEditorForInput();

    expect(result).toBe("My task description\n\nThis is a multiline description.");
  });

  it("returns empty string when editor leaves only comments", async () => {
    // Create a mock editor that leaves the template unchanged
    const mockEditorPath = join(tempDir, "mock-editor-noop.sh");
    await Bun.write(
      mockEditorPath,
      `#!/bin/bash
# Don't modify the file - leave it with template
exit 0
`
    );
    await Bun.$`chmod +x ${mockEditorPath}`;

    process.env.EDITOR = mockEditorPath;
    delete process.env.VISUAL;

    const result = await openEditorForInput();

    expect(result).toBe("");
  });

  it("throws EditorError when editor exits with non-zero code", async () => {
    // Create a mock editor that fails
    const mockEditorPath = join(tempDir, "mock-editor-fail.sh");
    await Bun.write(
      mockEditorPath,
      `#!/bin/bash
exit 1
`
    );
    await Bun.$`chmod +x ${mockEditorPath}`;

    process.env.EDITOR = mockEditorPath;
    delete process.env.VISUAL;

    await expect(openEditorForInput()).rejects.toThrow("Editor exited with code 1");
  });

  it("uses custom template when provided", async () => {
    // Create a mock editor that appends to the file
    const mockEditorPath = join(tempDir, "mock-editor-custom.sh");
    await Bun.write(
      mockEditorPath,
      `#!/bin/bash
# Prepend content to the file
echo "User input here" | cat - "$1" > "$1.tmp" && mv "$1.tmp" "$1"
`
    );
    await Bun.$`chmod +x ${mockEditorPath}`;

    process.env.EDITOR = mockEditorPath;
    delete process.env.VISUAL;

    const result = await openEditorForInput({
      template: "# Custom template\n# With comments only",
    });

    expect(result).toBe("User input here");
  });
});
