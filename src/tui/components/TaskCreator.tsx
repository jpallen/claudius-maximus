/**
 * Task creator component - text input for new task prompt
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface TaskCreatorProps {
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}

export function TaskCreator({ onSubmit, onCancel }: TaskCreatorProps): React.ReactElement {
  const [prompt, setPrompt] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text color="cyan" bold>New Task</Text>
      <Box marginTop={1}>
        <Text color="gray">What would you like Claude to work on?</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="green">&gt; </Text>
        <TextInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleSubmit}
          placeholder="Describe your task..."
        />
      </Box>
    </Box>
  );
}
