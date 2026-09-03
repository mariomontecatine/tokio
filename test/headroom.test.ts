import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { headroom } from '../src/meter/headroom.ts';

const DAY = 24 * 3_600_000;

/** One row per turn, so each `credits` value is a whole prompt's cost. */
function seedTurns(db: ReturnType<typeof openDb>, costs: number[]) {
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,'claude-opus-5','opus',0,0,0,0,0,?,'s','/repo',?, 'transcript')`,
  );
  costs.forEach((c, i) => insert.run(`m${i}`, `r${i}`, Date.now() - DAY, c, `turn-${i}`));
}

test('too little history says nothing rather than guessing', () => {
  const db = openDb(':memory:');
  seedTurns(db, [1, 2, 3]);
  assert.equal(headroom(db, 50), null);
});

test('what is left is expressed in prompts, as a range', () => {
  const db = openDb(':memory:');
  // Ten turns: eight typical at $1, then $5 and $9. With ten samples the 90th
  // percentile is the ninth smallest, which is the $5 one.
  seedTurns(db, [1, 1, 1, 1, 1, 1, 1, 1, 5, 9]);
  const room = headroom(db, 20)!;
  assert.equal(room.turnP50, 1);
  assert.equal(room.turnP90, 5);
  assert.equal(room.few, 4, '$20 at the expensive rate');
  assert.equal(room.many, 20, '$20 at the typical one');
  assert.equal(room.sample, 10);
});

test('an exhausted window has room for nothing', () => {
  const db = openDb(':memory:');
  seedTurns(db, [1, 1, 1, 1, 1, 1, 1, 1, 5, 9]);
  const room = headroom(db, 0.2)!;
  assert.equal(room.few, 0);
  assert.equal(room.many, 0);
});

test('turns older than a fortnight do not set the going rate', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,'claude-opus-5','opus',0,0,0,0,0,?,'s','/repo',?, 'transcript')`,
  );
  for (let i = 0; i < 10; i++) insert.run(`old${i}`, `r${i}`, Date.now() - 30 * DAY, 99, `old-${i}`);
  assert.equal(headroom(db, 50), null, 'only stale turns is the same as no turns');
});

test('calls with no turn attached are not mistaken for turns', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(
    `INSERT INTO events (messageId, requestId, ts, model, family, inputTokens, outputTokens,
      cacheWrite5m, cacheWrite1h, cacheRead, credits, sessionId, project, turnId, source)
     VALUES (?,?,?,'claude-opus-5','opus',0,0,0,0,0,?,'s','/repo','', 'transcript')`,
  );
  for (let i = 0; i < 20; i++) insert.run(`u${i}`, `r${i}`, Date.now() - DAY, 1);
  assert.equal(headroom(db, 50), null);
});
