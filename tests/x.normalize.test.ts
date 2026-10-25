import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXTRACT_JS, normalizePosts, parseCount, toEnvelope } from '../src/x/index.ts';
import { runInFixture } from './fixtures/support/mini-dom.ts';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

function extract(html: string) {
  return toEnvelope(runInFixture(html, EXTRACT_JS));
}

test('EXTRACT_JS reads three real-shaped articles (fixture x-timeline.html)', () => {
  const env = extract(fixture('x-timeline.html'));
  assert.ok(env, 'envelope');
  assert.equal(env.state.articles, 3);
  assert.equal(env.state.loginWall, false);
  assert.equal(env.state.rateLimited, false);
  assert.equal(env.posts.length, 3);

  const posts = normalizePosts(env.posts);
  assert.deepEqual(posts, [
    {
      id: '1847000000000000001',
      url: 'https://x.com/elonmusk/status/1847000000000000001',
      author: { handle: 'elonmusk', name: 'Elon Musk' },
      text: 'Shipping day. Starship flies again.',
      createdAt: '2026-10-20T08:00:00.000Z',
      metrics: { replies: 12, reposts: 34, likes: 1200 },
    },
    {
      id: '1847000000000000002',
      url: 'https://x.com/NASA/status/1847000000000000002',
      author: { handle: 'NASA', name: 'NASA' },
      text: 'Launch replay 🚀',
      createdAt: '2026-10-20T09:30:00.000Z',
      metrics: { reposts: 2400, likes: 9800, views: 1500000 },
      media: [
        { type: 'image', url: 'https://pbs.twimg.com/media/ABC123?format=jpg&name=large' },
        { type: 'video', url: 'https://pbs.twimg.com/amplify_video_thumb/XYZ/img/poster.jpg?format=jpg&name=large' },
      ],
    },
    {
      id: '1847000000000000003',
      url: 'https://x.com/paulg/status/1847000000000000003',
      author: { handle: 'paulg', name: 'Paul Graham' },
      text: 'This is the most important thing I have read this year.',
      createdAt: '2026-10-20T07:15:00.000Z',
      metrics: { replies: 88, reposts: 1200, likes: 12000 },
      quoted: { handle: 'karpathy', text: 'Quoted insight: gradients are just gossip between parameters.' },
    },
  ]);
});

test('EXTRACT_JS spots a sign-in wall (fixture x-login-wall.html)', () => {
  const env = extract(fixture('x-login-wall.html'));
  assert.ok(env);
  assert.equal(env.state.articles, 0);
  assert.equal(env.state.loginWall, true);
  assert.equal(env.state.rateLimited, false);
  assert.deepEqual(normalizePosts(env.posts), []);
});

test('EXTRACT_JS spots rate-limit copy (fixture x-ratelimit.html)', () => {
  const env = extract(fixture('x-ratelimit.html'));
  assert.ok(env);
  assert.equal(env.state.articles, 0);
  assert.equal(env.state.rateLimited, true);
});

test('EXTRACT_JS on an empty but logged-in timeline is not a wall (fixture x-empty.html)', () => {
  const env = extract(fixture('x-empty.html'));
  assert.ok(env);
  assert.equal(env.state.articles, 0);
  assert.equal(env.state.loginWall, false);
  assert.equal(env.state.rateLimited, false);
});

test('EXTRACT_JS reads the zh-CN login wall and rate-limit copy', () => {
  const wall = extract('<div><span>登录</span><span>注册</span><span>看看正在发生的事</span></div>');
  assert.ok(wall);
  assert.equal(wall.state.articles, 0);
  assert.equal(wall.state.loginWall, true);

  const limited = extract('<div><span>超出限制</span><span>请稍后再试</span></div>');
  assert.ok(limited);
  assert.equal(limited.state.rateLimited, true);

  for (const copy of [
    '<div><span>Something went wrong. Try reloading.</span></div>',
    '<div><span>You are over the daily limit</span></div>',
    '<div><span>已达上限</span></div>',
  ]) {
    const env = extract(copy);
    assert.ok(env, copy);
    assert.equal(env.state.articles, 0, copy);
    assert.equal(env.state.rateLimited, true, copy);
    assert.equal(env.state.loginWall, false, copy);
  }
});

test('EXTRACT_JS splices emoji back in from img[alt] and keeps real line breaks', () => {
  const env = extract(
    '<article data-testid="tweet">' +
      '<div data-testid="tweetText"><span>a</span>' +
      '<img alt="🔥" draggable="false" src="https://abs.twimg.com/emoji/v2/svg/1f525.svg">' +
      '<span><br>b</span></div>' +
      '<a href="/i/status/88"><time datetime="2026-10-24T00:00:00.000Z">1m</time></a>' +
      '</article>',
  );
  assert.ok(env);
  assert.deepEqual(normalizePosts(env.posts), [
    { id: '88', url: 'https://x.com/i/status/88', text: 'a🔥\nb', createdAt: '2026-10-24T00:00:00.000Z' },
  ]);
});

test('EXTRACT_JS keeps an article that lost its author block', () => {
  const env = extract(
    '<article data-testid="tweet">' +
      '<div data-testid="tweetText"><span>no author here</span></div>' +
      '<a href="/i/status/77"><time datetime="2026-10-22T00:00:00.000Z">1m</time></a>' +
      '</article>',
  );
  assert.ok(env);
  assert.equal(env.state.articles, 1);
  assert.deepEqual(normalizePosts(env.posts), [
    { id: '77', url: 'https://x.com/i/status/77', text: 'no author here', createdAt: '2026-10-22T00:00:00.000Z' },
  ]);
});

// Captured from the real x.com (Chrome/155, logged out, 2026-10-25). No data-testid anywhere:
// the new frontend only offers data-slot / data-status / data-engagement-action / data-href.
test('real x.com capture: three posts through the structural channel', () => {
  const env = extract(fixture('x-real-profile-2026-10.html'));
  assert.ok(env);
  assert.equal(env.state.articles, 3, 'the embedded tweet is a nested article, not a top-level post');
  assert.equal(env.posts.length, 3);

  const posts = normalizePosts(env.posts);
  assert.equal(posts.length, 3);
  const [pinned, second, third] = posts;

  assert.equal(pinned.id, '2112931457786081428');
  assert.equal(pinned.url, 'https://x.com/elonmusk/status/2112931457786081428');
  assert.deepEqual(pinned.author, { handle: 'elonmusk', name: 'Elon Musk' });
  assert.equal(pinned.text, 'Some fools still think the legacy news is real. Amazing.');
  assert.doesNotMatch(pinned.text, /已置顶/, 'the pinned badge is page noise, not body text');
  assert.equal(pinned.createdAt, '10月21日', 'dates stay verbatim - no invented ISO timestamps');
  assert.deepEqual(pinned.metrics, { replies: 16000, reposts: 35000, likes: 280000, views: 24480000 });
  assert.equal(pinned.media, undefined, 'the avatar must never become media');

  assert.equal(second.id, '2114243303994486876');
  assert.equal(
    second.text,
    'Try @Starlink for awesome Internet everywhere!',
    'the inline <a> mention must survive: without it the sentence changes meaning',
  );
  assert.deepEqual(second.metrics, { replies: 683, reposts: 366, likes: 5106, views: 4620000 });

  assert.equal(third.id, '2114055584865775967');
  assert.deepEqual(third.author, { handle: 'PhilipPowrs', name: 'Philip Powers' });
  assert.equal(
    third.text,
    'I just set up @Starlink in 15 minutes. Literally laid it in my backyard. ' +
      'Saying goodbye to the scrappy Spectrum service feels so good!',
  );
  assert.equal(third.createdAt, '13小时');
  assert.equal(third.metrics, undefined, 'that capture has no engagement markup - leave metrics empty, do not guess');

  const dump = JSON.stringify(posts);
  assert.doesNotMatch(dump, /profile_images/, 'avatars are filtered out of media');
  assert.doesNotMatch(dump, /已置顶/, 'the pinned badge never reaches any body');
  assert.doesNotMatch(posts.map((p) => p.text).join(' | '), /10月21日|36分钟|13小时/, 'dates never leak into bodies');
  assert.doesNotMatch(posts.map((p) => p.text).join(' | '), /1\.6万|3\.5万|2448万/, 'counts never leak into bodies');
  assert.doesNotMatch(posts.map((p) => p.text).join(' | '), /@elonmusk|@PhilipPowrs/, 'the author handle is not body text');
});

test('short replies are real posts: "Cool" and "True", not drift', () => {
  const env = extract(fixture('x-short-replies.html'));
  assert.ok(env);
  assert.equal(env.state.articles, 2);
  const posts = normalizePosts(env.posts);
  assert.equal(posts.length, 2);

  assert.equal(posts[0].id, '2001');
  assert.equal(posts[0].text, 'Cool', 'a two-word reply is the whole body');
  assert.deepEqual(posts[0].author, { handle: 'elonmusk', name: 'Elon Musk' });
  assert.equal(posts[0].createdAt, '43分钟');
  assert.deepEqual(posts[0].metrics, { replies: 16000, reposts: 35000, likes: 280000 });
  assert.doesNotMatch(posts[0].text, /1\.6万|3\.5万|28万|Elon Musk|@elonmusk|43分钟|Texas/);

  assert.equal(posts[1].id, '2003');
  assert.equal(posts[1].text, 'True');
  assert.deepEqual(posts[1].metrics, { replies: 812, likes: 4096 });
});

test('structural body keeps inline hashtags and emoji alt', () => {
  const env = extract(
    '<article>' +
      '<a href="/u"><div>U</div></a>' +
      '<span><a href="/u"><span>@u</span></a></span>' +
      '<span><a href="/u/status/9">1小时</a></span>' +
      '<div><span>看这个 <a href="/hashtag/AI">#AI</a> ' +
      '<img alt="🚀" src="https://abs.twimg.com/emoji/v2/svg/1f680.svg"> 很酷</span></div>' +
      '</article>',
  );
  assert.ok(env);
  const posts = normalizePosts(env.posts);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, '9');
  assert.equal(posts[0].text, '看这个 #AI 🚀 很酷');
  assert.equal(posts[0].createdAt, '1小时');
});

test('EXTRACT_JS picks the channel per article (old testid markup + 2026 markup in one page)', () => {
  const html =
    '<article data-testid="tweet">' +
    '<div data-testid="User-Name">' +
    '<a href="/old"><span>Old User</span></a>' +
    '<a href="/old/status/111"><time datetime="2026-10-01T00:00:00.000Z">1d</time></a>' +
    '</div>' +
    '<div data-testid="tweetText"><span>legacy markup body text</span></div>' +
    '</article>' +
    '<article>' +
    '<a href="/new"><div>New User</div></a>' +
    '<span><a href="/new"><span>@newuser</span></a></span>' +
    '<span><a href="/new/status/222">昨天</a></span>' +
    '<div><span>structural markup body text</span></div>' +
    '</article>';

  const env = extract(html);
  assert.ok(env);
  assert.equal(env.state.articles, 2);
  const posts = normalizePosts(env.posts);
  assert.equal(posts.length, 2);

  assert.equal(posts[0].id, '111');
  assert.equal(posts[0].text, 'legacy markup body text');
  assert.equal(posts[0].createdAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(posts[0].author, { handle: 'old', name: 'Old User' });

  assert.equal(posts[1].id, '222');
  assert.equal(posts[1].text, 'structural markup body text');
  assert.equal(posts[1].createdAt, '昨天');
  assert.deepEqual(posts[1].author, { handle: 'newuser', name: 'New User' });
});

test('EXTRACT_JS reports href + htmlLength so the URL login criterion can run', () => {
  const href = 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fhome&mode=login';
  const env = toEnvelope(runInFixture(fixture('x-empty.html'), EXTRACT_JS, { href }));
  assert.ok(env);
  assert.equal(env.state.href, href);
  assert.equal(env.state.articles, 0);
  assert.equal(env.state.htmlLength, 0, 'the fixture DOM has no innerHTML, so length stays 0');
  assert.equal(env.state.loginWall, false);
});

test('toEnvelope accepts htmlLen as an alias and tolerates a missing state', () => {
  const env = toEnvelope({ posts: [], state: { articles: 0, text: '', htmlLen: 12873 } });
  assert.ok(env);
  assert.equal(env.state.htmlLength, 12873);
  assert.equal(env.state.href, '');

  const bare = toEnvelope([]);
  assert.ok(bare);
  assert.equal(bare.state.href, '');
  assert.equal(bare.state.htmlLength, 0);
});

test('parseCount understands X count spellings', () => {
  const cases: [unknown, number | undefined][] = [
    ['1.2K', 1200],
    ['12K', 12000],
    ['1,234', 1234],
    ['1,234 replies', 1234],
    ['3.4M', 3400000],
    ['2B', 2000000000],
    ['1.2万', 12000],
    ['10万', 100000],
    ['1.5亿', 150000000],
    [42, 42],
    [0, 0],
    ['', undefined],
    ['Reply', undefined],
    [undefined, undefined],
    [null, undefined],
    [true, undefined],
    [{}, undefined],
    [-5, undefined],
    [Number.NaN, undefined],
  ];
  for (const [input, want] of cases) {
    assert.equal(parseCount(input), want, 'parseCount(' + String(input) + ')');
  }
});

test('normalizePosts tolerates dirty rows', () => {
  const raw = [
    null,
    undefined,
    42,
    'nope',
    [],
    {},
    { text: '   ' },
    { url: '/alpha/status/9', text: '  hello  ' },
    { id: 12345, text: 'id only\n\n\nnext paragraph' },
    { id: 'NaN', url: '', text: 'dropped because there is no id and no url' },
    {
      url: 'https://twitter.com/beta/status/10',
      handle: '@beta_user',
      name: '  Beta  ',
      text: 'x',
      replies: '1.1K',
      reposts: 0,
      likes: 'bad',
      createdAt: 1234,
      media: ['https://pbs.twimg.com/media/Q.jpg', { type: 'image', url: 'https://pbs.twimg.com/media/Q.jpg' }, { url: 7 }, null],
      quoted: 'just a string quote',
    },
  ];
  const posts = normalizePosts(raw as unknown[]);
  assert.deepEqual(posts, [
    { id: '9', url: 'https://x.com/alpha/status/9', text: 'hello' },
    { id: '12345', url: 'https://x.com/i/status/12345', text: 'id only\n\nnext paragraph' },
    {
      id: '10',
      url: 'https://twitter.com/beta/status/10',
      author: { handle: 'beta_user', name: 'Beta' },
      text: 'x',
      createdAt: '1234',
      metrics: { replies: 1100, reposts: 0 },
      media: [{ type: 'image', url: 'https://pbs.twimg.com/media/Q.jpg?name=large' }],
      quoted: { text: 'just a string quote' },
    },
  ]);
});

test('normalizePosts never throws on non-arrays', () => {
  for (const value of [undefined, null, 0, 'x', {}, { posts: [] }]) {
    assert.deepEqual(normalizePosts(value as unknown as unknown[]), []);
  }
});

test('toEnvelope accepts a bare row array and rejects nonsense', () => {
  const bare = toEnvelope([{ url: '/a/status/1', text: 't' }]);
  assert.ok(bare);
  assert.equal(bare.state.articles, 1);
  assert.equal(bare.state.loginWall, false);

  assert.equal(toEnvelope(null), null);
  assert.equal(toEnvelope('x'), null);
  assert.equal(toEnvelope({ posts: 'not an array' }), null);
});
