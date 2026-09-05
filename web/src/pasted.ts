/**
 * Large pastes, folded away.
 *
 * Dropping a stack trace into the box buries the instruction you came to write
 * under two hundred lines of someone else's text, so a paste past a certain
 * size becomes a chip you can open rather than a wall you have to scroll. The
 * prompt that runs is unchanged — this is only about what is on screen.
 *
 * The awkward part is the second time. Once a prompt has been queued it is one
 * string, and nothing in that string says which blank line separated two of
 * your own paragraphs and which one preceded the log. Re-deriving it is a
 * guess, and a wrong guess here unfolds the wall again at exactly the moment
 * someone is trying to edit around it — so the boundaries are remembered with
 * the job (`promptBlocks`) and only re-derived when there is nothing to
 * remember, which is what happens to a prompt queued from the CLI.
 *
 * Relative imports carry .ts here so the module can also be read by `npm test`,
 * which runs on Node's type stripping and resolves nothing implicitly.
 */

/**
 * Past this, a paste is a document rather than a sentence.
 *
 * Either threshold alone misses a case — a minified line is one line and
 * enormous, a short diff is twelve tiny ones — so both count.
 */
export const PASTE_CHARS = 500;
export const PASTE_LINES = 8;

export interface Pasted {
  id: string;
  text: string;
  lines: number;
}

/** A prompt as it is edited: some folded blocks, and the part you type. */
export interface Draft {
  pasted: Pasted[];
  typed: string;
  /** True when what you typed came before the pastes rather than after them. */
  typedLeads: boolean;
}

export function looksPasted(text: string): boolean {
  return text.length >= PASTE_CHARS || text.split('\n').length > PASTE_LINES;
}

let counter = 0;
export function asPasted(text: string): Pasted {
  counter += 1;
  return { id: `p${counter}`, text, lines: text.split('\n').length };
}

/** What actually gets queued. Blank lines between the parts, nothing else added. */
export function toPrompt(draft: Draft): string {
  const blocks = draft.pasted.map((p) => p.text);
  const typed = draft.typed.trim();
  const ordered = draft.typedLeads ? [typed, ...blocks] : [...blocks, typed];
  return ordered.filter(Boolean).join('\n\n');
}

export const emptyDraft = (): Draft => ({ pasted: [], typed: '', typedLeads: false });

/**
 * Where the remembered blocks sit inside the prompt, or null if any of them has
 * drifted out of it. All or nothing: folding away half of a set would hide text
 * the prompt no longer contains.
 */
function locate(prompt: string, blocks: string[]): [number, number][] | null {
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (!block) return null;
    const at = prompt.indexOf(block, cursor);
    if (at === -1) return null;
    spans.push([at, at + block.length]);
    cursor = at + block.length;
  }
  return spans;
}

/** Everything outside the folded blocks, which is what you get to type in. */
function textOutside(prompt: string, spans: [number, number][]): string {
  const gaps: string[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    gaps.push(prompt.slice(cursor, start));
    cursor = end;
  }
  gaps.push(prompt.slice(cursor));
  return gaps.map((g) => g.trim()).filter(Boolean).join('\n\n');
}

/**
 * Re-open a queued prompt for editing.
 *
 * With `blocks` this is exact: the folds are the ones that were there when it
 * was written. Without them — a prompt queued from the CLI, or from a version
 * of tokio that did not record them — the blank lines are all there is to go
 * on, and a paragraph long enough to look like a paste will be folded. That is
 * the failure this can have, and it is a recoverable one: the chip opens.
 */
export function draftOf(prompt: string, blocks: string[] | null | undefined): Draft {
  const parts = split(prompt, blocks);
  return { ...parts, pasted: parts.pasted.map(asPasted) };
}

/** The same reading of a prompt, before anything is given an identity to render by. */
function split(prompt: string, blocks: string[] | null | undefined): { pasted: string[]; typed: string; typedLeads: boolean } {
  const spans = blocks?.length ? locate(prompt, blocks) : null;
  if (spans && blocks) {
    return { pasted: blocks, typed: textOutside(prompt, spans), typedLeads: spans[0]![0] > 0 };
  }

  const parts = prompt.split(/\n{2,}/);
  if (!parts.some(looksPasted)) return { pasted: [], typed: prompt, typedLeads: false };
  return {
    pasted: parts.filter(looksPasted),
    typed: parts.filter((p) => !looksPasted(p)).join('\n\n'),
    typedLeads: !looksPasted(parts[0] ?? ''),
  };
}

/**
 * One line for a queued job, which should be the thing you asked for.
 *
 * A prompt that is mostly a pasted log reads, in a list, as a pasted log: the
 * row fills with the first eighty characters of somebody else's stack trace and
 * the sentence that says what to do with it never appears. Where the folds are
 * known, the sentence is what shows.
 */
export function summarize(prompt: string, blocks: string[] | null | undefined): string {
  const { typed } = split(prompt, blocks);
  return (typed || prompt).replace(/\s+/g, ' ').trim();
}
