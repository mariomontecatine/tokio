import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asPasted, draftOf, looksPasted, toPrompt } from '../web/src/pasted.ts';
import { checkPromptBlocks } from '../src/queue/blocks.ts';

const LOG = ('Traceback (most recent call last):\n' + '  at frame\n'.repeat(40)).trimEnd();

test('a paste is judged by either of its two dimensions', () => {
  assert.equal(looksPasted('fix the tests'), false);
  assert.equal(looksPasted('a\nb\nc\nd\ne\nf\ng\nh\ni'), true, 'nine short lines is a document');
  assert.equal(looksPasted('x'.repeat(500)), true, 'and so is one very long one');
});

test('a queued prompt reopens with what was pasted still folded away', () => {
  const draft = { pasted: [asPasted(LOG)], typed: 'work out why this happens', typedLeads: false };
  const prompt = toPrompt(draft);
  const blocks = draft.pasted.map((p) => p.text);

  // The round trip is exact: the same fold, the same sentence, the same prompt.
  const reopened = draftOf(prompt, blocks);
  assert.deepEqual(reopened.pasted.map((p) => p.text), blocks);
  assert.equal(reopened.typed, 'work out why this happens');
  assert.equal(toPrompt(reopened), prompt);
});

test('what you typed keeps its place, before the paste or after it', () => {
  const leading = { pasted: [asPasted(LOG)], typed: 'why does this fail?', typedLeads: true };
  const prompt = toPrompt(leading);
  assert.ok(prompt.startsWith('why does this fail?'));

  const reopened = draftOf(prompt, [LOG]);
  assert.equal(reopened.typedLeads, true);
  assert.equal(toPrompt(reopened), prompt);
});

test('an ordinary prompt is never reformatted on the way back in', () => {
  // Nothing here is a paste, so nothing is folded and nothing is rearranged —
  // the text that comes back is the text that went in, to the character.
  const prompt = 'first, run the tests\n\n\nthen tell me what broke';
  const draft = draftOf(prompt, null);
  assert.deepEqual(draft.pasted, []);
  assert.equal(draft.typed, prompt);
  assert.equal(toPrompt(draft), prompt);
});

test('with nothing recorded, a big block is still recognised for what it is', () => {
  // A prompt queued from the CLI carries no record of how it was written, so the
  // blank lines are all there is to go on. Folding on that is a guess, and it is
  // stated as one — but it beats two hundred lines of log in an edit box.
  const prompt = `${LOG}\n\nfix it`;
  const draft = draftOf(prompt, null);
  assert.equal(draft.pasted.length, 1);
  assert.equal(draft.typed, 'fix it');
  assert.equal(toPrompt(draft), prompt);

  // What the guess does cost: without a record of the boundaries, the blank
  // lines are the boundaries, so a run of them comes back as one. Only ever on
  // this path, and only around a block big enough to have been folded.
  assert.equal(toPrompt(draftOf(`${LOG}\n\n\n\nfix it`, null)), prompt);
});

test('a record that no longer matches the prompt is not trusted', () => {
  // Both halves of the same rule: the server refuses to store blocks that are
  // not in the prompt, and the editor refuses to fold on blocks that are not
  // there — otherwise a chip would hide text the job does not contain.
  const prompt = `${LOG}\n\nfix it`;
  assert.equal(checkPromptBlocks(prompt, ['a block from some other prompt']), null);

  const draft = draftOf(prompt, ['a block from some other prompt']);
  assert.equal(draft.pasted.length, 1, 'falls back to reading the prompt itself');
  assert.equal(draft.pasted[0]!.text, LOG);
});
