/**
 * Status bar showing keyboard hints
 */

import React from "react";
import { Box, Text } from "ink";

export type AppView = "list" | "create" | "agent";

interface StatusBarProps {
  view: AppView;
}

export function StatusBar({ view }: StatusBarProps): React.ReactElement {
  const hints = getHintsForView(view);

  return (
    <Box marginTop={1} flexDirection="row" gap={2}>
      {hints.map((hint, index) => (
        <Box key={index}>
          <Text color="cyan" bold>{hint.key}</Text>
          <Text color="gray"> {hint.description}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface KeyHint {
  key: string;
  description: string;
}

function getHintsForView(view: AppView): KeyHint[] {
  switch (view) {
    case "list":
      return [
        { key: "n", description: "New task" },
        { key: "Enter", description: "Focus task" },
        { key: "r", description: "Refresh" },
        { key: "q", description: "Quit" },
      ];
    case "create":
      return [
        { key: "Enter", description: "Submit" },
        { key: "Esc", description: "Cancel" },
      ];
    case "agent":
      return [
        { key: "Enter", description: "Select" },
        { key: "Esc", description: "Skip" },
      ];
    default:
      return [];
  }
}
