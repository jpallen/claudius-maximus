/**
 * Format task thread for injection into Claude prompts
 */

import type { TaskThread, ThreadEntry } from "./types";

/** Maximum characters for thread context before truncation */
const MAX_CONTEXT_CHARACTERS = 50000;

/** Options for formatting thread context */
export interface FormatOptions {
  /** Maximum total characters (default: 50000) */
  maxCharacters?: number;
  /** Only include entries for specific step name */
  stepFilter?: string;
  /** Maximum number of entries to include */
  maxEntries?: number;
}

/**
 * Format a single thread entry as XML
 */
function formatEntry(entry: ThreadEntry): string {
  switch (entry.type) {
    case "task_description":
      return `<task-description>${escapeXml(entry.content)}</task-description>`;
    case "step_prompt":
      return `<prompt>${escapeXml(entry.content)}</prompt>`;
    case "claude_response":
      return `<response>${escapeXml(entry.content)}</response>`;
    case "user_question":
      return `<user-question>${escapeXml(entry.content)}</user-question>`;
    case "user_answer":
      return `<user-answer>${escapeXml(entry.content)}</user-answer>`;
    case "resume_prompt":
      return `<resume-prompt>${escapeXml(entry.content)}</resume-prompt>`;
    case "orchestrator_decision": {
      const metadata = entry.metadata as { type?: string; stepName?: string; question?: string; summary?: string; reason?: string } | undefined;
      const decisionType = metadata?.type || "unknown";
      return `<orchestrator-decision type="${escapeXml(decisionType)}">${escapeXml(entry.content)}</orchestrator-decision>`;
    }
    case "step_result": {
      const metadata = entry.metadata as { success?: boolean } | undefined;
      const status = metadata?.success ? "success" : "failure";
      return `<step-result step="${escapeXml(entry.stepName)}" status="${status}">${escapeXml(entry.content)}</step-result>`;
    }
    default:
      return `<entry type="${entry.type}">${escapeXml(entry.content)}</entry>`;
  }
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Group entries by step and attempt
 */
interface StepGroup {
  stepName: string;
  attempt: number;
  entries: ThreadEntry[];
}

function groupEntriesByStep(entries: ThreadEntry[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let currentGroup: StepGroup | null = null;

  for (const entry of entries) {
    // Start a new group if step/attempt changes
    if (
      !currentGroup ||
      currentGroup.stepName !== entry.stepName ||
      currentGroup.attempt !== entry.attemptNumber
    ) {
      currentGroup = {
        stepName: entry.stepName,
        attempt: entry.attemptNumber,
        entries: [],
      };
      groups.push(currentGroup);
    }
    currentGroup.entries.push(entry);
  }

  return groups;
}

/**
 * Format thread entries for injection into Claude context
 */
export function formatThreadForContext(
  thread: TaskThread,
  options: FormatOptions = {}
): string | null {
  const { maxCharacters = MAX_CONTEXT_CHARACTERS, stepFilter, maxEntries } = options;

  if (thread.entries.length === 0) {
    return null;
  }

  // Filter entries if needed
  let entries = thread.entries;
  if (stepFilter) {
    entries = entries.filter((e) => e.stepName === stepFilter);
  }
  if (maxEntries && entries.length > maxEntries) {
    entries = entries.slice(-maxEntries);
  }

  // Group by step/attempt
  const groups = groupEntriesByStep(entries);

  // Build formatted output
  const lines: string[] = [
    "<previous-steps>",
    "This is the conversation history from previous steps of this task.",
    "",
  ];

  for (const group of groups) {
    lines.push(`<step name="${escapeXml(group.stepName)}" attempt="${group.attempt}">`);
    for (const entry of group.entries) {
      lines.push(formatEntry(entry));
    }
    lines.push("</step>");
    lines.push("");
  }

  lines.push("</previous-steps>");

  let result = lines.join("\n");

  // Truncate if exceeds max length (keep most recent content)
  if (result.length > maxCharacters) {
    // Find groups to include from the end
    const truncatedGroups: StepGroup[] = [];
    let currentLength = "<previous-steps>\n[Earlier context truncated...]\n\n</previous-steps>".length;

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const groupLines: string[] = [
        `<step name="${escapeXml(group.stepName)}" attempt="${group.attempt}">`,
      ];
      for (const entry of group.entries) {
        groupLines.push(formatEntry(entry));
      }
      groupLines.push("</step>");
      groupLines.push("");

      const groupText = groupLines.join("\n");
      if (currentLength + groupText.length > maxCharacters) {
        break;
      }
      truncatedGroups.unshift(group);
      currentLength += groupText.length;
    }

    // Rebuild with truncation notice
    const truncatedLines: string[] = [
      "<previous-steps>",
      "[Earlier context truncated...]",
      "",
    ];

    for (const group of truncatedGroups) {
      truncatedLines.push(`<step name="${escapeXml(group.stepName)}" attempt="${group.attempt}">`);
      for (const entry of group.entries) {
        truncatedLines.push(formatEntry(entry));
      }
      truncatedLines.push("</step>");
      truncatedLines.push("");
    }

    truncatedLines.push("</previous-steps>");
    result = truncatedLines.join("\n");
  }

  return result;
}

/**
 * Format thread entries for display in CLI (human readable)
 */
export function formatThreadForDisplay(
  thread: TaskThread,
  options: { stepFilter?: string; lastN?: number; json?: boolean } = {}
): string {
  const { stepFilter, lastN, json } = options;

  if (thread.entries.length === 0) {
    return "No thread entries.";
  }

  // Filter entries if needed
  let entries = thread.entries;
  if (stepFilter) {
    entries = entries.filter((e) => e.stepName === stepFilter);
  }
  if (lastN && entries.length > lastN) {
    entries = entries.slice(-lastN);
  }

  if (json) {
    return JSON.stringify({ entries, metadata: thread.metadata }, null, 2);
  }

  // Human-readable format
  const lines: string[] = [];
  const groups = groupEntriesByStep(entries);

  for (const group of groups) {
    const attemptInfo = group.attempt > 1 ? ` (attempt ${group.attempt})` : "";
    lines.push(`\n${"─".repeat(50)}`);
    lines.push(`Step: ${group.stepName}${attemptInfo}`);
    lines.push(`${"─".repeat(50)}`);

    for (const entry of group.entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const typeLabel = formatTypeLabel(entry.type);
      const truncatedContent = truncateForDisplay(entry.content, 500);
      lines.push(`\n[${time}] ${typeLabel}:`);
      lines.push(truncatedContent);
    }
  }

  lines.push(`\n${"─".repeat(50)}`);
  lines.push(`Total entries: ${thread.entries.length}`);
  lines.push(`Total characters: ${thread.metadata.totalCharacters}`);

  return lines.join("\n");
}

/**
 * Format entry type as human-readable label
 */
function formatTypeLabel(type: string): string {
  switch (type) {
    case "task_description":
      return "Task";
    case "step_prompt":
      return "Prompt";
    case "claude_response":
      return "Response";
    case "user_question":
      return "Question";
    case "user_answer":
      return "Answer";
    case "resume_prompt":
      return "Resume";
    case "orchestrator_decision":
      return "Decision";
    case "step_result":
      return "Result";
    default:
      return type;
  }
}

/**
 * Truncate content for display
 */
function truncateForDisplay(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + "... [truncated]";
}
