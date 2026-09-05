/**
 * Which parts of a prompt were pasted rather than typed.
 *
 * The dashboard folds a large paste — a stack trace, a diff, a log — down to a
 * single line so the sentence you actually wrote is still readable next to it.
 * That fold is a fact about how the prompt was written, and there is no way to
 * recover it from the finished text: a blank line looks the same whether it
 * separates two paragraphs or a paragraph from two hundred lines of someone
 * else's output. So it is recorded rather than guessed at, and this is what
 * keeps the record honest.
 *
 * Nothing here affects what runs. `prompt` is the whole of that, always.
 */

/**
 * The blocks that really are stretches of this prompt, in the order they appear.
 *
 * A block that has drifted out of the prompt — because the prompt was edited
 * somewhere else, or because a client sent something arbitrary — takes the
 * whole set with it. Half a fold is worse than none: it would hide text the
 * prompt no longer contains, or show a chip that expands to something that
 * isn't there.
 */
export function checkPromptBlocks(prompt: string, blocks: unknown): string[] | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  const kept: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (typeof block !== 'string' || block === '') return null;
    const at = prompt.indexOf(block, cursor);
    if (at === -1) return null;
    cursor = at + block.length;
    kept.push(block);
  }
  return kept;
}

/** Round-trip through the database, where this lives as one JSON column. */
export function encodeBlocks(blocks: string[] | null): string | null {
  return blocks && blocks.length ? JSON.stringify(blocks) : null;
}

export function decodeBlocks(stored: unknown): string[] | null {
  if (typeof stored !== 'string' || !stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((b) => typeof b === 'string') && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}
