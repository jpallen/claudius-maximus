import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { VERSION, APP_NAME } from "../src/lib/constants";

describe("CLI basics", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("shows help with --help", async () => {
    const result = await ctx.run("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: cm");
    expect(result.stdout).toContain(APP_NAME);
    expect(result.stdout).toContain("dev");
    expect(result.stdout).toContain("hello");
  });

  it("shows version with --version", async () => {
    const result = await ctx.run("--version");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it("shows version with -v", async () => {
    const result = await ctx.run("-v");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it("runs hello command without name", async () => {
    const result = await ctx.run("hello");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello, world!");
    expect(result.stdout).toContain(APP_NAME);
  });

  it("runs hello command with name", async () => {
    const result = await ctx.run("hello", "Alice");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello, Alice!");
    expect(result.stdout).toContain(APP_NAME);
  });

  it("shows error for unknown command", async () => {
    const result = await ctx.run("nonexistent");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });
});
