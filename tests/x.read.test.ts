import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXTRACT_JS, isLoginUrl, parseSource, readPost, readSource } from '../src/x/index.ts';
import { makeFakeEngine, makeScriptedEngine } from './fixtures/support/fake-engine.ts';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const rounds = () => fixture('x-scroll.html').split('<!-- round -->');
const source = (spec: string) => parseSource(spec) as { kind: 'home'; value: string };

test('readSource opens one tab, scrolls, de-dupes by status id, closes the tab', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: rounds() });
  const posts = await readSource(engine, source('user:alpha'), { limit: 10, scrolls: 3, settleMs: 0 });

  assert.deepEqual(
    posts.map((p) => p.id),
    ['1900000000000000001', '1900000000000000002', '1900000000000000003'],
  );
  assert.deepEqual(calls.goto, ['https://x.com/alpha']);
  assert.equal(calls.newPage, 1);
  assert.equal(calls.waitReady, 1);
  assert.equal(calls.closePage, 1);
  assert.equal(calls.scroll, 2, 'two scrolls: the last one added nothing and broke the loop');
  assert.ok(calls.expressions.length > 0);
  assert.ok(calls.expressions.every((expr) => expr === EXTRACT_JS), 'only the declared expression is evaluated');
});

test('readSource stops scrolling once the limit is reached', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: rounds() });
  const posts = await readSource(engine, source('home'), { limit: 2, scrolls: 5, settleMs: 0 });
  assert.equal(posts.length, 2);
  assert.equal(calls.scroll, 0);
});

test('readSource with scrolls: 0 keeps only the first screen', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: rounds() });
  const posts = await readSource(engine, source('search:ai agents'), { limit: 10, scrolls: 0, settleMs: 0 });
  assert.deepEqual(
    posts.map((p) => p.id),
    ['1900000000000000001', '1900000000000000002'],
  );
  assert.equal(calls.scroll, 0);
  assert.deepEqual(calls.goto, ['https://x.com/search?q=ai%20agents&f=live']);
});

test('readSource clamps limit and scrolls into range', async () => {
  const one = makeFakeEngine({ rounds: rounds() });
  const posts = await readSource(one.engine, source('home'), { limit: 0, scrolls: -3, settleMs: 0 });
  assert.equal(posts.length, 1);
  assert.equal(one.calls.scroll, 0);
});

test('readSource rejects an unrecognised source without opening a tab', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: rounds() });
  await assert.rejects(
    () => readSource(engine, { kind: 'user', value: '' }, { settleMs: 0 }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'parse-failed');
      return true;
    },
  );
  assert.equal(calls.newPage, 0);
});

test('readSource throws login-required on a sign-in wall and still closes the tab', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-login-wall.html')] });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'login-required');
      assert.match(String(err.message), /Sign in to X/);
      return true;
    },
  );
  assert.equal(calls.closePage, 1);
});

test('readSource throws ratelimited on rate-limit copy', async () => {
  const { engine } = makeFakeEngine({ rounds: [fixture('x-ratelimit.html')] });
  await assert.rejects(
    () => readSource(engine, source('user:alpha'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'ratelimited');
      assert.match(String(err.message), /Rate limit exceeded/);
      return true;
    },
  );
});

test('readSource returns [] for an empty but healthy timeline', async () => {
  const { engine } = makeFakeEngine({ rounds: [fixture('x-empty.html')] });
  assert.deepEqual(await readSource(engine, source('list:42'), { settleMs: 0 }), []);
});

test('readSource reports a navigation failure as parse-failed', async () => {
  const { engine } = makeScriptedEngine(
    { posts: [], state: { articles: 0, text: '', loginWall: false, rateLimited: false } },
    { ok: false, note: 'net::ERR_INTERNET_DISCONNECTED' },
  );
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'parse-failed');
      assert.match(String(err.message), /ERR_INTERNET_DISCONNECTED/);
      return true;
    },
  );
});

test('readSource reports articles without rows as parse-failed (selector drift)', async () => {
  const { engine } = makeScriptedEngine({
    posts: [],
    state: { articles: 3, text: '', loginWall: false, rateLimited: false },
  });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'parse-failed');
      assert.match(String(err.message), /markup probably changed/);
      return true;
    },
  );
});

test('readSource rejects a non-envelope evaluate result as parse-failed', async () => {
  const { engine } = makeScriptedEngine('not an object');
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'parse-failed');
      return true;
    },
  );
});

test('readSource maps an evaluate rejection to parse-failed', async () => {
  const { engine } = makeFakeEngine({ rounds: rounds() });
  const broken = {
    ...engine,
    evaluate: async () => {
      throw new Error('Target closed');
    },
  };
  await assert.rejects(
    () => readSource(broken, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'parse-failed');
      assert.match(String(err.message), /Target closed/);
      return true;
    },
  );
});

test('readPost returns the post with the requested status id', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-timeline.html')] });
  const post = await readPost(engine, 'https://x.com/NASA/status/1847000000000000002');
  assert.ok(post);
  assert.equal(post.id, '1847000000000000002');
  assert.equal(post.author?.handle, 'NASA');
  assert.deepEqual(calls.goto, ['https://x.com/NASA/status/1847000000000000002']);
  assert.equal(calls.closePage, 1);
});

test('readPost refuses a non-post url without touching the browser', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-timeline.html')] });
  assert.equal(await readPost(engine, 'https://x.com/home'), null);
  assert.equal(await readPost(engine, 'not a url'), null);
  assert.equal(calls.newPage, 0);
});

test('readPost returns null when the page has no post', async () => {
  const { engine } = makeFakeEngine({ rounds: [fixture('x-empty.html')] });
  assert.equal(await readPost(engine, 'https://x.com/foo/status/12345'), null);
});

test('readSource turns a half-empty timeline into a loud parse-failed (fixture x-drift.html)', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-drift.html')] });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'parse-failed');
      assert.match(String(err.message), /疑似页面改版：正文选择器已失效/);
      assert.match(String(err.message), /3 行既无正文也无媒体/);
      assert.match(String(err.message), /本轮没有一条抽出正文/);
      assert.match(String(err.message), /tweetText selector probably changed/);
      return true;
    },
  );
  assert.equal(calls.closePage, 1);
});

test('a partly-broken timeline still returns what it has (fixture x-mixed-timeline.html)', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-mixed-timeline.html')] });
  const posts = await readSource(engine, source('user:elonmusk'), { limit: 10, scrolls: 0, settleMs: 0 });

  assert.deepEqual(
    posts.map((p) => p.id),
    ['3001', '3003', '3005'],
    'the two body-less rows are skipped instead of failing the whole read',
  );
  assert.deepEqual(posts.map((p) => p.text), ['Cool', 'True', '🤣']);
  assert.equal(calls.closePage, 1);
});

test('a media-only timeline is not called drift (fixture x-media-only.html)', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-media-only.html')] });
  const posts = await readSource(engine, source('user:shutter'), { limit: 10, scrolls: 0, settleMs: 0 });

  assert.equal(posts.length, 3, 'three media-only posts must come back, not a parse error');
  assert.deepEqual(posts.map((p) => p.text), ['', '', '']);
  assert.deepEqual(posts.map((p) => p.media?.length), [1, 2, 1]);
  assert.equal(posts[0].id, '1900000000000000201');
  assert.equal(posts[0].author?.handle, 'shutter');
  assert.equal(calls.closePage, 1);
});

test('readSource turns new rate-limit copy into ratelimited', async () => {
  const copies = [
    '<div><span>Something went wrong. Try reloading.</span></div>',
    '<div><span>You are over the daily limit for posts.</span></div>',
    '<div><span>已达上限</span><span>请稍后再来</span></div>',
  ];
  for (const html of copies) {
    const { engine } = makeFakeEngine({ rounds: [html] });
    await assert.rejects(
      () => readSource(engine, source('home'), { settleMs: 0 }),
      (err: { code?: string; message?: string }) => {
        assert.equal(err.code, 'ratelimited', 'copy: ' + html);
        assert.match(String(err.message), /Something went wrong|daily limit|已达上限/);
        return true;
      },
    );
  }
});

test('a media-only post page is not mistaken for selector drift (readPost guard)', async () => {
  const html =
    '<article data-testid="tweet">' +
    '<div data-testid="User-Name">' +
    '<a href="/pic"><span>Pic</span></a>' +
    '<a href="/pic/status/555"><time datetime="2026-10-23T00:00:00.000Z">1m</time></a>' +
    '</div>' +
    '<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/ONLY.jpg?format=jpg&amp;name=small" alt=""></div>' +
    '</article>';
  const { engine } = makeFakeEngine({ rounds: [html] });
  const post = await readPost(engine, 'https://x.com/pic/status/555');
  assert.ok(post, 'one article with no text must still come back');
  assert.equal(post.id, '555');
  assert.equal(post.text, '');
  assert.deepEqual(post.media, [{ type: 'image', url: 'https://pbs.twimg.com/media/ONLY.jpg?format=jpg&name=large' }]);
});

// Real evidence (Chrome/155, logged out): goto /home landed on the onboarding flow with 0 articles,
// no login testid, an empty body.innerText and no testids at all. Only the URL gives it away.
const REAL_ONBOARDING_HREF = 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fhome&mode=login';

test('readSource: a logged-out redirect to the login flow is login-required (URL criterion)', async () => {
  const { engine, calls } = makeScriptedEngine({
    posts: [],
    state: {
      href: REAL_ONBOARDING_HREF,
      articles: 0,
      text: '',
      htmlLength: 12873,
      loginWall: false,
      rateLimited: false,
    },
  });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'login-required');
      assert.match(String(err.message), /i\/jf\/onboarding/, 'the receipt must name the URL it landed on');
      assert.match(String(err.message), /redirect_after_login/);
      return true;
    },
  );
  assert.equal(calls.closePage, 1);
});

test('readSource: a big but silent page is render-blocked, never login-required', async () => {
  const { engine } = makeScriptedEngine({
    posts: [],
    state: { href: 'https://x.com/home', articles: 0, text: '', htmlLength: 12873, loginWall: false, rateLimited: false },
  });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'render-blocked');
      assert.match(String(err.message), /没有渲染出可见内容/);
      assert.match(String(err.message), /后台标签页/);
      assert.match(String(err.message), /12873/);
      return true;
    },
  );
});

test('readSource: a rendered but empty timeline is neither a wall nor render-blocked', async () => {
  const { engine } = makeScriptedEngine({
    posts: [],
    state: {
      href: 'https://x.com/home',
      articles: 0,
      text: 'No posts yet',
      htmlLength: 12873,
      loginWall: false,
      rateLimited: false,
    },
  });
  assert.deepEqual(await readSource(engine, source('user:nobody'), { settleMs: 0 }), []);
});

test('readSource: a rate limit beats the login-URL criterion', async () => {
  const { engine } = makeScriptedEngine({
    posts: [],
    state: {
      href: REAL_ONBOARDING_HREF,
      articles: 0,
      text: 'Rate limit exceeded',
      htmlLength: 12873,
      loginWall: false,
      rateLimited: true,
    },
  });
  await assert.rejects(
    () => readSource(engine, source('home'), { settleMs: 0 }),
    (err: { code?: string }) => {
      assert.equal(err.code, 'ratelimited');
      return true;
    },
  );
});

test('readSource reads the real capture end to end (3 posts, no drift alarm)', async () => {
  const { engine, calls } = makeFakeEngine({ rounds: [fixture('x-real-profile-2026-10.html')] });
  const posts = await readSource(engine, source('user:elonmusk'), { limit: 10, scrolls: 0, settleMs: 0 });
  assert.equal(posts.length, 3);
  assert.equal(posts[0].author?.handle, 'elonmusk');
  assert.deepEqual(calls.goto, ['https://x.com/elonmusk']);
  assert.equal(calls.closePage, 1);
});

test('isLoginUrl: the four URL shapes, and nothing else', () => {
  const yes = [
    'https://x.com/i/flow/login',
    'https://x.com/i/flow/login?redirect_after_login=%2Fhome',
    'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fhome&mode=login',
    'https://x.com/home?mode=login',
    'https://x.com/?redirect_after_login=%2Fhome',
  ];
  for (const href of yes) assert.equal(isLoginUrl(href), true, href);

  const no = [
    'https://x.com/home',
    'https://x.com/i/lists/42',
    'https://x.com/search?q=ai&f=live',
    'https://x.com/i/flow/loginAs',
    'https://x.com/elonmusk/status/1847000000000000001',
    '',
  ];
  for (const href of no) assert.equal(isLoginUrl(href), false, href);
});
