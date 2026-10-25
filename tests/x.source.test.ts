import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XError,
  canonicalPostUrl,
  formatSource,
  isPostUrl,
  parseSource,
  sourceUrl,
  statusIdFromUrl,
} from '../src/x/index.ts';

test('parseSource: every documented form', () => {
  assert.deepEqual(parseSource('home'), { kind: 'home', value: '' });
  assert.deepEqual(parseSource(' HOME '), { kind: 'home', value: '' });
  assert.deepEqual(parseSource('user:elonmusk'), { kind: 'user', value: 'elonmusk' });
  assert.deepEqual(parseSource('user:@elonmusk'), { kind: 'user', value: 'elonmusk' });
  assert.deepEqual(parseSource('USER:ElonMusk'), { kind: 'user', value: 'ElonMusk' });
  assert.deepEqual(parseSource('user:https://x.com/elonmusk'), { kind: 'user', value: 'elonmusk' });
  assert.deepEqual(parseSource('search:ai agents'), { kind: 'search', value: 'ai agents' });
  assert.deepEqual(parseSource('search:  ai    agents '), { kind: 'search', value: 'ai agents' });
  assert.deepEqual(parseSource('list:12345'), { kind: 'list', value: '12345' });
  assert.deepEqual(parseSource('list:https://x.com/i/lists/987'), { kind: 'list', value: '987' });
  assert.deepEqual(parseSource('hashtag:ai'), { kind: 'hashtag', value: 'ai' });
  assert.deepEqual(parseSource('hashtag:#人工智能'), { kind: 'hashtag', value: '人工智能' });
  assert.deepEqual(parseSource('post:https://x.com/foo/status/12345'), {
    kind: 'post',
    value: 'https://x.com/foo/status/12345',
  });
  assert.deepEqual(parseSource('post:  twitter.com/foo/status/12345 '), {
    kind: 'post',
    value: 'https://twitter.com/foo/status/12345',
  });
});

test('parseSource: shortcuts and refusals', () => {
  assert.deepEqual(parseSource('https://x.com/foo/status/12345'), { kind: 'post', value: 'https://x.com/foo/status/12345' });
  assert.deepEqual(parseSource('@elonmusk'), { kind: 'user', value: 'elonmusk' });
  assert.deepEqual(parseSource('home:'), { kind: 'home', value: '' });
  for (const bad of ['', '   ', 'home:x', 'elonmusk', 'user:', 'user:bad handle', 'search:', 'list:abc', 'hashtag:', 'post:nope', 'post:https://x.com/home', 'mentions:me', '/a/status/1']) {
    assert.equal(parseSource(bad), null, 'expected null for ' + JSON.stringify(bad));
  }
  assert.equal(parseSource(undefined as unknown as string), null);
  assert.equal(parseSource(null as unknown as string), null);
});

test('sourceUrl: one URL per kind', () => {
  assert.equal(sourceUrl({ kind: 'home', value: '' }), 'https://x.com/home');
  assert.equal(sourceUrl({ kind: 'user', value: 'elonmusk' }), 'https://x.com/elonmusk');
  assert.equal(sourceUrl({ kind: 'search', value: 'ai agents' }), 'https://x.com/search?q=ai%20agents&f=live');
  assert.equal(sourceUrl({ kind: 'search', value: 'C++ & rust' }), 'https://x.com/search?q=C%2B%2B%20%26%20rust&f=live');
  assert.equal(sourceUrl({ kind: 'list', value: '12345' }), 'https://x.com/i/lists/12345');
  assert.equal(sourceUrl({ kind: 'hashtag', value: 'ai' }), 'https://x.com/hashtag/ai?f=live');
  assert.equal(sourceUrl({ kind: 'hashtag', value: '人工智能' }), 'https://x.com/hashtag/%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD?f=live');
  assert.equal(sourceUrl({ kind: 'post', value: 'https://x.com/a/status/42' }), 'https://x.com/i/status/42');
  assert.equal(sourceUrl({ kind: 'user', value: '' }), '');
  assert.equal(sourceUrl({ kind: 'list', value: 'x' }), '');
  assert.equal(sourceUrl(undefined as unknown as { kind: 'home'; value: string }), '');
});

test('parseSource -> sourceUrl round trip', () => {
  const specs = ['home', 'user:elonmusk', 'search:ai agents', 'list:42', 'hashtag:ai'];
  for (const spec of specs) {
    const parsed = parseSource(spec);
    assert.ok(parsed, 'parseSource(' + spec + ')');
    assert.ok(sourceUrl(parsed).startsWith('https://x.com/'), spec + ' -> ' + sourceUrl(parsed));
  }
});

test('isPostUrl / statusIdFromUrl / canonicalPostUrl', () => {
  assert.ok(isPostUrl('https://x.com/foo/status/12345'));
  assert.ok(isPostUrl('https://twitter.com/foo/status/12345'));
  assert.ok(isPostUrl('http://mobile.x.com/i/web/status/12345?s=20'));
  assert.equal(isPostUrl('https://x.com/home'), false);
  assert.equal(isPostUrl('/foo/status/12345'), false);
  assert.equal(isPostUrl('https://example.com/foo/status/12345'), false);
  assert.equal(isPostUrl(''), false);

  assert.equal(statusIdFromUrl('/paulg/status/1847000000000000003'), '1847000000000000003');
  assert.equal(statusIdFromUrl('https://x.com/i/status/9'), '9');
  assert.equal(statusIdFromUrl('https://x.com/home'), null);
  assert.equal(canonicalPostUrl('https://x.com/paulg/status/7'), 'https://x.com/i/status/7');
  assert.equal(canonicalPostUrl('https://x.com/paulg'), null);
});

test('formatSource is the inverse of parseSource', () => {
  for (const spec of ['home', 'user:elonmusk', 'search:ai agents', 'list:42', 'hashtag:ai']) {
    assert.equal(formatSource(parseSource(spec) as { kind: 'home'; value: string }), spec);
  }
  assert.equal(formatSource(parseSource('post:https://x.com/a/status/5') as { kind: 'home'; value: string }), 'post:https://x.com/a/status/5');
});

test('XError carries a code and a default message', () => {
  const err = new XError('login-required');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'XError');
  assert.equal(err.code, 'login-required');
  assert.ok(err.message.length > 0);

  const custom = new XError('ratelimited', '  slow down  ');
  assert.equal(custom.message, 'slow down');
});
