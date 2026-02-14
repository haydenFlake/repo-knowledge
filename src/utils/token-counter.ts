/**
 * Approximate token count for code text.
 * Uses ~3.5 characters per token for code (conservative estimate).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
