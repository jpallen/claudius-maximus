/**
 * Human-readable task ID generator using adjective-noun pattern
 */

const ADJECTIVES = [
  "swift",
  "brave",
  "calm",
  "eager",
  "fair",
  "glad",
  "keen",
  "bold",
  "wise",
  "true",
  "warm",
  "cool",
  "fast",
  "firm",
  "kind",
  "neat",
  "pure",
  "safe",
  "tall",
  "vast",
  "wild",
  "zesty",
  "agile",
  "crisp",
  "fresh",
  "light",
  "prime",
  "quick",
  "sharp",
  "vivid",
];

const NOUNS = [
  "falcon",
  "tiger",
  "eagle",
  "wolf",
  "hawk",
  "bear",
  "lion",
  "fox",
  "owl",
  "deer",
  "swan",
  "crane",
  "dove",
  "crow",
  "finch",
  "heron",
  "robin",
  "spark",
  "storm",
  "flame",
  "river",
  "stone",
  "cedar",
  "maple",
  "oak",
  "pine",
  "birch",
  "star",
  "moon",
  "sun",
];

/**
 * Generate a random ID in adjective-noun format
 */
function generateRandomId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

/**
 * Generate a unique task ID that doesn't conflict with existing IDs
 * @param existingIds Set of IDs that already exist
 * @param maxAttempts Maximum number of attempts before adding a suffix
 */
export function generateTaskId(
  existingIds: Set<string>,
  maxAttempts = 100
): string {
  // Try to find a unique adjective-noun combo
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId();
    if (!existingIds.has(id)) {
      return id;
    }
  }

  // If we've exhausted attempts, add a numeric suffix
  let suffix = 1;
  while (true) {
    const id = `${generateRandomId()}-${suffix}`;
    if (!existingIds.has(id)) {
      return id;
    }
    suffix++;
  }
}

/**
 * Validate that a string is a valid task ID format
 */
export function isValidTaskId(id: string): boolean {
  // Allow adjective-noun or adjective-noun-number patterns
  const pattern = /^[a-z]+-[a-z]+(-\d+)?$/;
  return pattern.test(id);
}
