import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, mergeByRanks, type WikiPage } from '../src/lib/wiki.js';
import { matchGuess, normalize, startsWithLetters } from '../src/lib/match.js';
import { builtinHint } from '../src/lib/game.js';

const page = (id: number, title: string, description = '', matched: string | null = null): WikiPage => ({
  id, key: title.replace(/ /g, '_'), title, matched, description, thumb: null, url: `https://en.wikipedia.org/wiki/${id}`,
});

test('dedupe drops disambiguation pages and merges variants', () => {
  const pages = [
    page(1, 'Us', 'Topics referred to by the same term'),
    page(2, 'USB'),
    page(3, 'Usain Bolt'),
    page(4, 'USB-C'),
    page(5, 'US Open (tennis)'),
    page(6, 'Us (2019 film)'),
    page(7, 'USB 3.0'),
    page(2, 'USB', '', 'Universal Serial Bus'),
    page(8, 'Usher (musician)'),
    page(9, 'USB hardware'),
  ];
  const out = dedupe(pages, 'basic');
  assert.deepEqual(out.map((e) => e.title), ['USB', 'Usain Bolt', 'US Open (tennis)', 'Us (2019 film)', 'Usher (musician)', 'USB hardware']);
  assert.deepEqual(out[0].members, ['USB', 'USB-C', 'USB 3.0']);
  assert.ok(out[0].aliases.includes('Universal Serial Bus'));
  assert.deepEqual(out.map((e) => e.rank), [1, 2, 3, 4, 5, 6]);
});

test('aggressive dedupe merges word prefixes', () => {
  const out = dedupe([page(1, 'Abu Ghraib torture and prisoner abuse'), page(2, 'Abu Ghraib')], 'aggressive');
  assert.equal(out.length, 1);
  assert.equal(dedupe([page(1, 'Abraham Lincoln'), page(2, 'Abraham')], 'basic').length, 2);
});

test('mergeByRanks folds later ranks into the leader', () => {
  const entries = dedupe([page(1, 'Windows 10'), page(2, 'Wikipedia'), page(3, 'Windows 10 version history')], 'off');
  const merged = mergeByRanks(entries, [[3, 1]]);
  assert.deepEqual(merged.map((e) => [e.rank, e.title]), [[1, 'Windows 10'], [2, 'Wikipedia']]);
  assert.ok(merged[0].members.includes('Windows 10 version history'));
});

test('matchGuess handles case, accents, typos, qualifiers and partial titles', () => {
  const entries = dedupe(
    [page(1, 'Abraham Lincoln'), page(2, 'Marina Abramović'), page(3, 'Abu Ghraib torture and prisoner abuse'), page(4, 'Abraham'), page(5, 'Usher (musician)'), page(6, 'The Beatles')],
    'basic',
  );
  assert.equal(matchGuess('abraham lincoln', entries)?.entry.rank, 1);
  assert.equal(matchGuess('Abraham Lincon', entries)?.strength, 'close');
  assert.equal(matchGuess('marina abramovic', entries)?.entry.rank, 2);
  assert.equal(matchGuess('Abu Ghraib', entries)?.entry.rank, 3);
  assert.equal(matchGuess('Abraham', entries)?.entry.rank, 4, 'exact beats partial');
  assert.equal(matchGuess('Usher', entries)?.entry.rank, 5);
  assert.equal(matchGuess('Beatles', entries)?.entry.rank, 6);
  assert.equal(matchGuess('Abu', entries), null);
  assert.equal(matchGuess('Absinthe', entries), null);
});

test('normalize and startsWithLetters', () => {
  assert.equal(normalize('The Lord of the Rings (film series)'), 'lord of the rings');
  assert.ok(startsWithLetters('The Beatles', 'th'));
  assert.ok(startsWithLetters('Beatles', 'be'));
  assert.ok(!startsWithLetters('Lincoln', 'ab'));
});

test('builtinHint never leaks the title words', () => {
  const [e] = dedupe([page(1, 'Abraham Lincoln', 'President of the United States; Lincoln was assassinated')], 'off');
  const h0 = builtinHint(e, 0);
  assert.ok(!/lincoln/i.test(h0), h0);
  assert.match(builtinHint(e, 1), /2 words: A _ _ _ _ _ _ {3}L _ _ _ _ _ _/);
});
