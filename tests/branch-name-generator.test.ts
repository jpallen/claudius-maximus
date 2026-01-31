import { describe, it, expect } from "bun:test";
import {
  cleanBranchName,
  isValidBranchName,
  ensureUniqueBranchName,
} from "../src/lib/task/branch-name-generator";

describe("Branch Name Generator", () => {
  describe("cleanBranchName()", () => {
    it("removes double quotes", () => {
      expect(cleanBranchName('"implement-auth"')).toBe("implement-auth");
    });

    it("removes single quotes", () => {
      expect(cleanBranchName("'implement-auth'")).toBe("implement-auth");
    });

    it("removes backticks", () => {
      expect(cleanBranchName("`implement-auth`")).toBe("implement-auth");
    });

    it("lowercases input", () => {
      expect(cleanBranchName("Implement-Auth")).toBe("implement-auth");
    });

    it("replaces spaces with hyphens", () => {
      expect(cleanBranchName("implement auth")).toBe("implement-auth");
    });

    it("removes invalid characters", () => {
      expect(cleanBranchName("implement@auth!")).toBe("implementauth");
    });

    it("collapses multiple hyphens", () => {
      expect(cleanBranchName("implement--auth")).toBe("implement-auth");
    });

    it("removes leading hyphens", () => {
      expect(cleanBranchName("-implement-auth")).toBe("implement-auth");
    });

    it("removes trailing hyphens", () => {
      expect(cleanBranchName("implement-auth-")).toBe("implement-auth");
    });

    it("handles mixed messy input", () => {
      expect(cleanBranchName('  "Implement--Auth!" \n')).toBe("implement-auth");
    });
  });

  describe("isValidBranchName()", () => {
    it("accepts valid multi-word names", () => {
      expect(isValidBranchName("implement-auth")).toBe(true);
      expect(isValidBranchName("fix-bug")).toBe(true);
      expect(isValidBranchName("add-user-settings-page")).toBe(true);
    });

    it("accepts valid single-word names (min 2 chars)", () => {
      expect(isValidBranchName("ab")).toBe(true);
      expect(isValidBranchName("auth")).toBe(true);
    });

    it("accepts names with numbers", () => {
      expect(isValidBranchName("fix-bug-123")).toBe(true);
      expect(isValidBranchName("feature2")).toBe(true);
    });

    it("accepts names at exactly 2 chars (minimum)", () => {
      expect(isValidBranchName("ab")).toBe(true);
    });

    it("accepts names at exactly 60 chars (maximum)", () => {
      // Build a 60-char valid name: starts with letter, contains hyphens
      const name = "a-" + "b".repeat(58);  // 60 chars: "a-" + 58 b's
      expect(name.length).toBe(60);
      expect(isValidBranchName(name)).toBe(true);
    });

    it("rejects empty string", () => {
      expect(isValidBranchName("")).toBe(false);
    });

    it("rejects too short (1 char)", () => {
      expect(isValidBranchName("a")).toBe(false);
    });

    it("rejects too long (>60 chars)", () => {
      expect(isValidBranchName("a".repeat(61))).toBe(false);
    });

    it("rejects names with special characters", () => {
      expect(isValidBranchName("implement@auth")).toBe(false);
      expect(isValidBranchName("fix!bug")).toBe(false);
    });

    it("rejects leading numbers", () => {
      expect(isValidBranchName("1-fix-bug")).toBe(false);
    });

    it("rejects leading hyphens", () => {
      expect(isValidBranchName("-fix-bug")).toBe(false);
    });

    it("rejects uppercase letters", () => {
      expect(isValidBranchName("Fix-Bug")).toBe(false);
    });
  });

  describe("ensureUniqueBranchName()", () => {
    it("returns name unchanged if not in set", () => {
      const existing = new Set<string>();
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth");
    });

    it("appends -2 for first conflict", () => {
      const existing = new Set(["implement-auth"]);
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth-2");
    });

    it("appends -3 for second conflict", () => {
      const existing = new Set(["implement-auth", "implement-auth-2"]);
      expect(ensureUniqueBranchName("implement-auth", existing)).toBe("implement-auth-3");
    });

    it("handles name that already ends with suffix", () => {
      // If "foo-2" exists, should try "foo-2-2"
      const existing = new Set(["foo-2"]);
      expect(ensureUniqueBranchName("foo-2", existing)).toBe("foo-2-2");
    });

    it("finds correct suffix when multiple conflicts exist", () => {
      const existing = new Set(["foo", "foo-2", "foo-3"]);
      expect(ensureUniqueBranchName("foo", existing)).toBe("foo-4");
    });

    it("skips taken suffixes", () => {
      const existing = new Set(["foo", "foo-2", "foo-4"]);
      expect(ensureUniqueBranchName("foo", existing)).toBe("foo-3");
    });
  });
});
