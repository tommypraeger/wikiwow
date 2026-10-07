import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, type WikiPage } from '../src/lib/wiki.js';
import { leaksAnswer } from '../src/lib/game.js';
import { take } from '../src/lib/ratelimit.js';

const page = (id: number, title: string): WikiPage => ({ id, key: title, title, matched: null, description: '', thumb: null, url: '' });

test('leaksAnswer catches titles and distinctive title words', () => {
  const hidden = dedupe([page(1, 'Abraham Lincoln'), page(2, 'ABBA'), page(3, 'Usher (musician)')], 'off');
  assert.ok(leaksAnswer('Yes — Abraham Lincoln was a president!', hidden));
  assert.ok(leaksAnswer('Think Lincoln.', hidden));
  assert.ok(leaksAnswer('abba is a band', hidden));
  assert.ok(leaksAnswer('Usher sings', hidden));
  assert.ok(!leaksAnswer('Yes, one of them is a person.', hidden));
  assert.ok(!leaksAnswer('Abracadabra, no.', hidden));
});

test('token bucket allows a burst then throttles', () => {
  const limit = { capacity: 3, perSecond: 1 };
  const key = `t:${Math.random()}`;
  assert.equal(take(key, limit), 0);
  assert.equal(take(key, limit), 0);
  assert.equal(take(key, limit), 0);
  assert.ok(take(key, limit) > 0);
});
