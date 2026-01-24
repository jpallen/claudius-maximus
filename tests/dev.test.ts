import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, createMockVersion, type TestContext } from "./helpers";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

describe("dev mode", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("dev list", () => {
    it("shows no dev version when not configured", async () => {
      const result = await ctx.run("dev", "list");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No dev version configured");
      expect(result.stdout).toContain("using self");
    });

    it("shows dev version path when configured", async () => {
      await ctx.run("dev", "set", "/some/path");
      const result = await ctx.run("dev", "list");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/some/path");
    });

    it("supports ls alias", async () => {
      const result = await ctx.run("dev", "ls");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No dev version configured");
    });
  });

  describe("dev set", () => {
    it("sets a dev version path", async () => {
      const result = await ctx.run("dev", "set", "/path/to/dev");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dev version set to:");
      expect(result.stdout).toContain("/path/to/dev");
    });

    it("warns when path does not exist", async () => {
      const result = await ctx.run("dev", "set", "/nonexistent/path");

      expect(result.exitCode).toBe(0);
      // Warning goes to stderr via console.warn
      expect(result.stderr).toContain("Warning");
      expect(result.stderr).toContain("Could not resolve dev target");
    });

    it("detects directory type", async () => {
      // Use the actual cm-cli directory as a test
      const result = await ctx.run("dev", "set", process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Detected type: directory");
      expect(result.stdout).toContain("Entry point:");
    });
  });

  describe("dev clear", () => {
    it("clears the dev version", async () => {
      await ctx.run("dev", "set", "/some/path");
      const result = await ctx.run("dev", "clear");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dev version cleared");

      // Verify it's actually cleared
      const listResult = await ctx.run("dev", "list");
      expect(listResult.stdout).toContain("No dev version configured");
    });

    it("succeeds even when no dev version is set", async () => {
      const result = await ctx.run("dev", "clear");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dev version cleared");
    });
  });

  describe("dev status", () => {
    it("shows disabled when not configured", async () => {
      const result = await ctx.run("dev", "status");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dev mode: DISABLED");
    });

    it("shows enabled when configured", async () => {
      // Set to the actual cm-cli directory
      await ctx.run("dev", "set", process.cwd());
      const result = await ctx.run("dev", "status");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Dev mode: ENABLED");
      expect(result.stdout).toContain("Type: directory");
    });
  });
});

describe("dev mode proxying", () => {
  let ctx: TestContext;
  let mockDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    mockDir = await mkdtemp(join(tmpdir(), "cm-mock-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(mockDir, { recursive: true, force: true });
  });

  it("proxies commands to dev version", async () => {
    // Create a mock version
    const mockVersionDir = await createMockVersion(mockDir, "9.9.9", "[MOCK]");

    // Set dev version to the mock
    await ctx.run("dev", "set", mockVersionDir);

    // Run hello - should proxy to mock
    const result = await ctx.run("hello", "Test");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mock v9.9.9");
    expect(result.stdout).toContain("[MOCK]");
  });

  it("proxies --version to dev version", async () => {
    const mockVersionDir = await createMockVersion(mockDir, "1.2.3");

    await ctx.run("dev", "set", mockVersionDir);
    const result = await ctx.run("--version");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1.2.3");
  });

  it("does not proxy dev commands themselves", async () => {
    const mockVersionDir = await createMockVersion(mockDir, "9.9.9");

    await ctx.run("dev", "set", mockVersionDir);

    // dev list should still work from the main CLI
    const result = await ctx.run("dev", "list");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(mockVersionDir);
  });

  it("falls back to self when dev target not found", async () => {
    await ctx.run("dev", "set", "/nonexistent/path");
    const result = await ctx.run("hello", "Fallback");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Warning");
    expect(result.stderr).toContain("Falling back to self");
    // Should still execute using self
    expect(result.stdout).toContain("Hello, Fallback!");
  });
});
