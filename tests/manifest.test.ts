/**
 * 契约形状的守门测试。跑法：node --test tests/
 *
 * 只读文件、只构造定义；不联网、不启浏览器（attach 那条只连本进程里开的一个假端口）。
 * 断言的是 REPORT.md 里带 file:line 的那些形状，所以每条都标明出处。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { PROBE_SOCKET_TIMEOUT_MS, PROBE_TIMEOUT_MS, runProbe } from '../src/definition.ts';
import definitionModule, { X_FEED } from '../src/index.ts';
// 语法权威：源行的解析必须转交给它，config.ts 不许再有一份（W3 与 W1 的边界）。
import { parseSource } from '../src/x/index.ts';
import {
  CONFIG_OWNER,
  CONFIG_PREFIX,
  SOURCE_KINDS,
  WORLD_ID,
  X_FEED_DECLARED_KEYS,
  X_FEED_DEFAULTS,
  parseSourceLine,
  sourceLines,
  xFeedConfigGroups,
} from '../src/config.ts';
import { MODEL, PREFLIGHT, TEXT, strings } from '../src/i18n.ts';
import { ENV_PROMPT_FILE, ENV_PROMPT_KEY, XWorld } from '../src/world.ts';

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 与 dry-mount.ts:80-97 的 fakeWorldContext 同形：默认配置、没有密钥、写回是空操作。 */
function fakeCtx(overrides: Record<string, unknown> = {}) {
  const cfg = { ...X_FEED.defaults(), ...overrides };
  return {
    id: X_FEED.id,
    cfg,
    timezone: 'Asia/Shanghai',
    botName: 'Coo',
    botDir: ROOT,
    packageDir: ROOT,
    dataDir: join(ROOT, '.test-data'),
    repoRoot: ROOT,
    secret: () => '',
    storeSecret: () => {},
    persist: (patch: Record<string, unknown>) => Object.assign(cfg, patch),
    restart: async () => {},
  } as never;
}

const TAGS_VOCABULARY = [
  'pal-ai-world', 'corti', 'coopanion',
  'im', 'qq', 'streaming', 'game', 'internet', 'browser', 'video', 'voice', 'computer-use', 'real-world',
  'apps', 'memory', 'companion', 'creative', 'diagnostics', 'local', 'external-setup', 'requires-key',
  'experimental', 'internal-state', 'requires-extension', 'high-cost', 'unofficial-api',
  'unsafe', 'sensitive-data', 'injection-risk',
];

const TOOL_TAGS = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];

test('package.json：入口、关键词、cortico 块（REPORT 第 1 条）', () => {
  assert.equal(pkg.type, 'module', 'CJS 会让扩展与框架各持一份模块实例（manifest.ts:6）');
  assert.equal(pkg.main, './src/index.ts', '源码直跑（raw/cortico-extensions.md:225-226）');
  assert.equal(pkg.exports['.'], './src/index.ts', '入口解析 exports→module→main（extensions.ts:119-130）');
  assert.ok(existsSync(join(ROOT, pkg.main)), 'main 指向的文件必须真的在');
  assert.ok(pkg.keywords.includes('cortico-world'), '按类发现的关键字（manifest.ts:30-34）');
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6, 'world 契约版本是 6，bot 才是 7（manifest.ts:23-27）');
  assert.equal(typeof pkg.cortico.displayName, 'string');
  assert.ok(pkg.cortico.displayName.length > 0);
  assert.equal(pkg.cortico.describe, 'describe.json');
  assert.ok(existsSync(join(ROOT, pkg.cortico.describe)));
  assert.equal(pkg.cortico.icon, 'assets/icon.svg');
  assert.match(readFileSync(join(ROOT, pkg.cortico.icon), 'utf8'), /^<svg[\s>]/, '图标是 svg（manifest.ts:40）');
});

test('cortico.tags：只用 TAGS.md 词表里的标签（REPORT 第 9 条）', () => {
  const tags = pkg.cortico.tags;
  assert.ok(Array.isArray(tags) && tags.length > 0);
  for (const tag of tags) assert.ok(TAGS_VOCABULARY.includes(tag), '词表外的标签：' + tag);
  assert.ok(tags.includes('internet'), '读网上内容（TAGS.md:50）');
  assert.ok(tags.includes('browser'), '我们开页、滚动、读页，browser 是实话（TAGS.md:51）');
  assert.deepEqual([...tags].sort(), ['browser', 'internet'], '定稿的两个标签');

  // 撤掉的和不该加的，都别顺手加回来：
  assert.ok(!tags.includes('requires-key'), '本包不要任何第三方 API key');
  assert.ok(!tags.includes('unofficial-api'), '驱动浏览器不是调非官方接口；红标声明过就摘不掉');
  assert.ok(
    !tags.includes('injection-risk'),
    '第三方文本走 origin external（x-feed.posts），不进 origin internal 事件；' +
      '而带警示标签的包不能被认证（Pal-AI-Lab/cortico-extensions#202）',
  );
  for (const reserved of ['coopanion', 'corti', 'pal-ai-world']) {
    assert.ok(!tags.includes(reserved), '官方蓝标作者不能声明（TAGS.md:34）');
  }

  // 市场标签只写在 package.json 的 cortico.tags 里；describe.json 不能另立一份
  const describe = JSON.parse(readFileSync(join(ROOT, pkg.cortico.describe), 'utf8'));
  assert.equal(describe.tags, undefined, 'describe.json 不该有市场标签字段');
  assert.ok(
    !JSON.stringify(describe).includes('injection-risk'),
    'describe.json 里也不该出现已撤掉的注入风险标签',
  );
});

test('cortico.locales：只认 zh / en，只许 displayName / description（manifest.ts:42-55）', () => {
  const locales = pkg.cortico.locales;
  assert.deepEqual(Object.keys(locales).sort(), ['en', 'zh']);
  for (const [language, entry] of Object.entries(locales) as Array<[string, Record<string, unknown>]>) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'displayName'], language + ' 的键集');
    assert.ok(String(entry.displayName).length > 0);
    assert.ok(String(entry.description).length > 0);
  }
});

test('describe.json 与代码逐字一致（REPORT 第 9 条）', () => {
  const describe = JSON.parse(readFileSync(join(ROOT, pkg.cortico.describe), 'utf8'));
  assert.deepEqual(describe.tools, X_FEED.describe.tools, 'check:extension 会重新生成并比对');
  assert.deepEqual(describe.events, X_FEED.describe.events);
  assert.equal(describe.prompts.length, 1);
  const prompt = describe.prompts[0];
  assert.equal(prompt.key, ENV_PROMPT_KEY);
  assert.equal(prompt.role, 'envPrompt');
  assert.equal(prompt.content, readFileSync(ENV_PROMPT_FILE, 'utf8'), 'prompts 的 content 是模板原文');
  for (const key of Object.keys(describe)) {
    assert.ok(['tools', 'events', 'prompts'].includes(key), 'world 包只有这三类字段（describe.ts:17-34）');
  }
});

test('describe.tools：能过 dry-mount 的形状检查（dry-mount.ts:170-187）', () => {
  const tools = X_FEED.describe.tools;
  assert.equal(tools.length, 7, 'PLAN 第 5 节的 7 个工具');
  const seen = new Set();
  for (const tool of tools) {
    assert.ok(!seen.has(tool.name), '工具名重复：' + tool.name);
    seen.add(tool.name);
    assert.match(tool.name, /^[a-z0-9]+_/, '约定 <短名>_<动词>（dry-mount.ts:68）');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, 'description 原样发给模型（history.ts:35-42）');
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.tags) && tool.tags.length > 0, '空标签会被 warn（loop.ts:477-480）');
    for (const tag of tool.tags) assert.ok(TOOL_TAGS.includes(tag), '标签词表（core/types.ts:189-199）：' + tag);
    assert.equal(typeof tool.summary.zh, 'string');
    assert.equal(typeof tool.summary.en, 'string');
  }
  assert.deepEqual([...seen].sort(), ['x_export', 'x_look', 'x_read', 'x_recall', 'x_status', 'x_sync_now', 'x_watch']);
});

test('defaults()：PLAN 第 4 节的 11 项，每次一个新对象', () => {
  const defaults = X_FEED.defaults();
  assert.deepEqual(
    Object.keys(defaults).sort(),
    [
      'chromePath', 'deliverDigest', 'digestMaxChars', 'enabled', 'intervalMinutes',
      'limitPerSource', 'maxScrolls', 'mode', 'port', 'sources', 'vaultSubdir',
    ],
    '键集就是 PLAN 第 4 节那 11 项',
  );
  assert.equal(defaults.enabled, false, '默认必须能构造且不启用（dry-mount.ts:141-143）');
  assert.equal(defaults.mode, 'own');
  assert.equal(defaults.port, 9223);
  assert.equal(defaults.chromePath, '');
  assert.equal(defaults.sources, 'home');
  assert.equal(defaults.intervalMinutes, 120);
  assert.equal(defaults.limitPerSource, 20);
  assert.equal(defaults.maxScrolls, 3);
  assert.equal(defaults.vaultSubdir, 'x-feed');
  assert.equal(defaults.deliverDigest, true);
  assert.equal(defaults.digestMaxChars, 1200);

  const first = X_FEED.defaults();
  const second = X_FEED.defaults();
  assert.notEqual(first, second, '每次新对象：装配层会把部署配置叠在上面');
  first.port = 1;
  assert.equal(second.port, 9223, '改一份不能污染默认值');
  assert.equal(X_FEED_DEFAULTS.port, 9223, '模块级默认值也不许被改');
});

test('ConfigGroup：owner 与键前缀、与 defaults() 一一对应（REPORT 第 3 条）', () => {
  for (const language of ['zh', 'en'] as const) {
    const groups = xFeedConfigGroups(language);
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.owner, CONFIG_OWNER);
    assert.equal(group.owner, 'world:x-feed', 'owner 必须是 world:<id>（dry-mount.ts:216）');
    assert.equal(group.id, 'world:' + WORLD_ID);
    assert.equal(group.schema.type, 'object');

    const defaults = X_FEED.defaults() as Record<string, unknown>;
    const declared: string[] = [];
    for (const [path, property] of Object.entries(group.schema.properties as Record<string, Record<string, unknown>>)) {
      assert.ok(path.startsWith(CONFIG_PREFIX), '键必须落在 ' + CONFIG_PREFIX + ' 段内（dry-mount.ts:54）');
      const suffix = path.slice(CONFIG_PREFIX.length);
      assert.ok(suffix in defaults, 'defaults() 里没有对应项：' + path);
      assert.ok(defaults[suffix] !== undefined, '默认值不能是 undefined：' + path);
      assert.equal(typeof property.type, 'string');
      assert.ok(String(property.title).length > 0, '每项都要 title');
      declared.push(suffix);
    }
    assert.deepEqual([...declared].sort(), [...X_FEED_DECLARED_KEYS].sort(), '声明的键就是那 10 项');
    const implicit = Object.keys(defaults).filter((key) => !declared.includes(key));
    assert.deepEqual(implicit, ['enabled'], '只差 enabled：它是装配层通用渲染的开关');
    const mode = (group.schema.properties as Record<string, Record<string, unknown>>)['worlds.x-feed.mode'];
    assert.deepEqual(mode.enum, ['own', 'attach']);
    assert.equal(mode['x-hot'], false, '换模式要重建实例');
  }
});

test('index 默认导出：形状与 isWorldDefinition 一致（extensions.ts:132-139）', () => {
  assert.equal(definitionModule, X_FEED, 'default 导出就是那个定义');
  const definition = definitionModule as Record<string, unknown>;
  assert.equal(typeof definition.id, 'string');
  assert.ok((definition.id as string).length > 0);
  assert.equal(typeof definition.label, 'string');
  assert.equal(typeof definition.defaults, 'function');
  assert.equal(typeof definition.create, 'function');
  assert.equal(definition.id, 'x-feed', 'PLAN A1 定的 world id');
  assert.equal(definition.id, WORLD_ID, 'id 与配置段前缀同源');
});

test('实例契约：id / tools() / envPromptVars() / webUi()（core/types.ts:903-952）', () => {
  const world = X_FEED.create(fakeCtx());
  assert.ok(world instanceof XWorld);
  assert.equal(world.id, X_FEED.id, '实例 id 必须等于定义 id（dry-mount.ts:153-154）');

  assert.ok(Array.isArray(world.tools()), 'tools() 必须返回数组；桩阶段允许为空');

  const vars = world.envPromptVars();
  assert.equal(typeof vars, 'object');
  assert.deepEqual(Object.keys(vars as object).sort(), ['x.interval', 'x.sources', 'x.status', 'x.vault']);
  for (const [name, value] of Object.entries(vars as Record<string, string>)) {
    assert.equal(typeof value, 'string', name + ' 必须是字符串');
    assert.ok(value.length > 0, name + ' 不许空串');
  }

  const decl = world.webUi('zh');
  assert.ok(Array.isArray(decl.config) && decl.config.length > 0, '配置表单由这里交出');
  assert.equal(decl.panels, undefined, '没有 webUiClient 就别声明面板（dry-mount.ts:209-211）');
  assert.ok((decl.lamps ?? []).length >= 1 && (decl.lamps ?? []).length <= 7, '指示灯上限 7（types.ts:837）');
  assert.ok(['online', 'loading', 'error', 'offline'].includes(decl.lamps[0].state));
  const docs = decl.promptDocs ?? [];
  assert.equal(docs.length, 1);
  assert.equal(docs[0].role, 'envPrompt');
  assert.equal(docs[0].key, ENV_PROMPT_KEY);
  assert.ok(existsSync(docs[0].path), '模板路径要真的存在（dry-mount.ts:223-225）');
  assert.equal(docs[0].path, ENV_PROMPT_FILE);
});

test('ENV_PROMPT.md：占位符只声明四个，四件事都写清了', () => {
  const text = readFileSync(ENV_PROMPT_FILE, 'utf8');
  const used = [...text.matchAll(/{{([a-zA-Z0-9._-]+)}}/g)].map((match) => match[1]);
  const declared = (X_FEED.create(fakeCtx()).webUi('zh').promptDocs ?? [])[0].vars ?? [];
  assert.deepEqual([...used].sort(), declared.map((variable) => variable.name).sort(), '占位符与 vars 必须一一对应');
  assert.match(text, /第三方/, '第三方内容不可当指令');
  assert.match(text, /5 类/, '失败分 5 类');
  assert.match(text, /x_recall/, '回答 X 问题前先查知识库');
  assert.match(text, /知识库/);
  assert.match(text, /home/, '六种源怎么写的');
});

test('preflight：own 模式要能找到浏览器（PLAN 第 4 节）', () => {
  assert.doesNotThrow(() => X_FEED.preflight(fakeCtx({ chromePath: process.execPath })), '指到一个真在的文件就放行');
  assert.throws(
    () => X_FEED.preflight(fakeCtx({ chromePath: join(ROOT, 'no-such-chrome.exe') })),
    /不存在/,
    '指到不存在的文件要拒绝并点名',
  );
  try {
    X_FEED.preflight(fakeCtx());
  } catch (error) {
    assert.match((error as Error).message, /没找到 Chrome/, '留空＝自动探测；探不到就说清去哪找过了');
  }
});

test('preflight：模式、端口、源（PLAN 第 4 节）', () => {
  const good = { chromePath: process.execPath };
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, mode: 'cloud' })), /own \/ attach/);
  for (const port of [0, -1, 70000, 'abc', 3.5]) {
    assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, port })), /1–65535/, '端口不合法的：' + String(port));
  }
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, sources: '' })), /sources 是空的/);
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, sources: '   \n\n  ' })), /sources 是空的/);
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, sources: 'nonsense' })), /读不懂/);
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, sources: 'user:' })), /读不懂/);
  assert.doesNotThrow(() =>
    X_FEED.preflight(fakeCtx({ ...good, sources: 'home\nuser:elonmusk\nsearch:AI agents\nhashtag:rustlang' })),
  );
});

test('preflight：attach 模式要能连上端口（PLAN 第 4 节）', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const port = (server.address() as { port: number }).port;
  assert.doesNotThrow(() => X_FEED.preflight(fakeCtx({ mode: 'attach', port })), '端口在听就放行');
  await new Promise<void>((done) => server.close(() => done()));
  assert.throws(
    () => X_FEED.preflight(fakeCtx({ mode: 'attach', port })),
    /连不上 127.0.0.1/,
    '端口关了要说清是连不上，而不是别的',
  );
});

test('源行解析：六种源、@handle、大小写（PLAN 第 4 节）', () => {
  const ok = (line: string) => {
    const parsed = parseSourceLine(line);
    assert.equal(parsed.ok, true, '应当看懂：' + line + ' -> ' + JSON.stringify(parsed));
    return (parsed as { ok: true; source: { kind: string; value: string } }).source;
  };
  assert.deepEqual(ok('home'), { kind: 'home', value: '' });
  assert.deepEqual(ok('user:elonmusk'), { kind: 'user', value: 'elonmusk' });
  assert.deepEqual(ok('user:@elonmusk'), { kind: 'user', value: 'elonmusk' }, 'handle 可以带 @');
  assert.deepEqual(ok('@elonmusk'), { kind: 'user', value: 'elonmusk' }, '裸 @handle 是 W3 认的简写');
  assert.deepEqual(ok('search:AI agents'), { kind: 'search', value: 'AI agents' });
  assert.deepEqual(ok('list:1234567890'), { kind: 'list', value: '1234567890' });
  assert.deepEqual(ok('hashtag:rustlang'), { kind: 'hashtag', value: 'rustlang' });
  assert.deepEqual(ok('post:https://x.com/a/status/1'), { kind: 'post', value: 'https://x.com/a/status/1' });

  // 大小写：种类不区分，handle 保留原样（这是 W3 parseSource 的取舍，别在这里另立一套）
  assert.deepEqual(ok('HOME'), { kind: 'home', value: '' });
  assert.deepEqual(ok('USER:ElonMusk'), { kind: 'user', value: 'ElonMusk' });
});

test('源行解析：与 W3 的 parseSource 同源，没有第二份语法', () => {
  const samples = [
    'home', 'home:', 'user:elonmusk', 'user:@elonmusk', '@elonmusk', 'search:ai agents',
    'list:12345', 'list:https://x.com/i/lists/987', 'hashtag:#人工智能',
    'post:https://x.com/foo/status/12345', 'https://x.com/foo/status/12345',
    'nonsense', 'user:', 'home:x', 'list:abc', ':x',
  ];
  for (const line of samples) {
    const direct = parseSource(line);
    const parsed = parseSourceLine(line);
    assert.equal(parsed.ok, direct !== null, '两边对同一行的判断必须一致：' + line);
    if (parsed.ok) assert.deepEqual(parsed.source, direct, '解析结果必须逐字相同：' + line);
  }
  // 本地那份种类表也不能与 W3 漂：每种都能被 parseSource 认出来。
  const example: Record<string, string> = {
    home: 'home', user: 'user:elonmusk', search: 'search:ai agents',
    list: 'list:12345', hashtag: 'hashtag:ai', post: 'post:https://x.com/a/status/1',
  };
  assert.deepEqual([...SOURCE_KINDS].sort(), ['hashtag', 'home', 'list', 'post', 'search', 'user']);
  for (const kind of SOURCE_KINDS) {
    assert.equal(parseSource(example[kind])?.kind, kind, 'SOURCE_KINDS 里的 ' + kind + ' 与 W3 不一致了');
  }
});

test('源行拆分：空行与 # 注释行跳过，坏行不静默丢', () => {
  assert.deepEqual(sourceLines('home\n\n user:a \r\n'), ['home', 'user:a']);
  assert.deepEqual(sourceLines('  \n\t\n'), [], '只有空行');
  assert.deepEqual(sourceLines(undefined), []);
  assert.deepEqual(sourceLines(null), []);
  assert.deepEqual(
    sourceLines('# 每行一个源\nhome\n   # user:someone\nuser:elonmusk'),
    ['home', 'user:elonmusk'],
    '以 # 开头的整行是注释，不当源',
  );

  for (const bad of ['nonsense', 'user:', ':x', 'home:x', 'list:abc', '']) {
    const parsed = parseSourceLine(bad);
    assert.equal(parsed.ok, false, '读不懂的行不能当成功：' + JSON.stringify(bad));
    const reason = (parsed as { ok: false; reason: string }).reason;
    assert.ok(reason.trim().length > 0, '失败必须带一句能直接进报错的 reason：' + JSON.stringify(bad));
  }
  const whyUser = parseSourceLine('user:');
  assert.equal(whyUser.ok, false);
  assert.match((whyUser as { ok: false; reason: string }).reason, /user/, '坏行要点名是哪个种类缺值');
  const whyUnknown = parseSourceLine('nonsense');
  assert.equal(whyUnknown.ok, false);
  assert.match((whyUnknown as { ok: false; reason: string }).reason, /种类/, '认不出种类时要说明能填哪些');
});

test('preflight 与源：注释与空行不算源，坏行点名到行', () => {
  const good = { chromePath: process.execPath };
  assert.throws(() => X_FEED.preflight(fakeCtx({ ...good, sources: '# 只有注释\n\n' })), /sources 是空的/);
  assert.doesNotThrow(() =>
    X_FEED.preflight(fakeCtx({ ...good, sources: '# 说明\n\n home \n  # user:someone\nuser:elonmusk' })),
  );
  assert.throws(
    () => X_FEED.preflight(fakeCtx({ ...good, sources: 'home\nnonsense\nuser:elonmusk' })),
    /nonsense/,
    '报错要把那一行原样带出来',
  );
});

test('端口探测：上限 2000ms，超时把子进程收掉（U2 裁决）', () => {
  assert.equal(PROBE_TIMEOUT_MS, 2000);
  assert.ok(PROBE_SOCKET_TIMEOUT_MS < PROBE_TIMEOUT_MS, '子进程自己要比上限先放弃');

  // 永不退出的脚本：到上限后必须被强制结束，而且真的不在进程表里了。
  const marker = join(tmpdir(), 'x-feed-probe-' + String(process.pid) + '-' + String(Date.now()) + '.pid');
  const script =
    "import('node:fs').then((fs) => { fs.writeFileSync(" +
    JSON.stringify(marker) +
    ", String(process.pid)); setInterval(() => {}, 1000); });";
  const startedAt = Date.now();
  const result = runProbe(script);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.match(result.detail, /2000ms/, '超时要说是被强制结束的：' + result.detail);
  assert.ok(elapsed >= 1900 && elapsed < 8000, '应当卡在 2s 上限附近，实际 ' + String(elapsed) + 'ms');

  const childPid = Number(readFileSync(marker, 'utf8').trim());
  rmSync(marker, { force: true });
  assert.ok(childPid > 0, '子进程应当写下自己的 pid');
  assert.throws(
    () => process.kill(childPid, 0),
    '探测子进程必须已经被回收；还活着说明上限没生效或进程留在表里',
  );
});

test('i18n：zh / en 成对，zh-Hant 走中文、其余走英文', () => {
  assert.equal(strings(undefined).label, 'X 时间线', '没给语言时按框架缺省取中文');
  assert.equal(strings('zh').label, 'X 时间线');
  assert.equal(strings('zh-Hant').label, 'X 时间线');
  assert.equal(strings('en').label, 'X Timeline');
  assert.equal(strings('ja').label, 'X Timeline');

  const walk = (node: unknown, path: string): void => {
    assert.equal(typeof node, 'object');
    const pair = node as Record<string, unknown>;
    if (typeof pair.zh === 'string' || typeof pair.en === 'string') {
      assert.equal(typeof pair.zh, 'string', path + ' 缺 zh');
      assert.equal(typeof pair.en, 'string', path + ' 缺 en');
      assert.ok(String(pair.zh).length > 0 && String(pair.en).length > 0, path + ' 有空文案');
      return;
    }
    for (const [key, value] of Object.entries(pair)) walk(value, path + '.' + key);
  };
  walk(TEXT.tools, 'tools');
  walk(TEXT.events, 'events');
  walk(TEXT.config, 'config');
  for (const tool of X_FEED.describe.tools) {
    assert.ok(String(TEXT.tools[tool.name as keyof typeof TEXT.tools].zh).length > 0, tool.name + ' 缺中文摘要');
  }

  assert.match(PREFLIGHT.modeUnknown('x'), /worlds\.x-feed\.mode/, '报错点名到具体键');
  assert.match(MODEL.intervalOn(30), /30 分钟/);
  assert.match(MODEL.vault('x-feed'), /x-feed/);
});

/**
 * 文件里所有「整条」模块语句：import / export / 副作用 import / 动态 import。
 *
 * 按整个文件内容匹配、**跨行**——一条 import 可以写成很多行，逐行扫必然误判
 * （src/world.ts 的 import type 就是多行的，W6 撞的就是这一条）。
 * 正文用 [^;]*? 而不是 [\s\S]*?：不许跨过语句结束符，否则前一条没有 from 的语句
 * 会把后一条的 from 抢过来。
 */
interface ModuleStatement {
  specifier: string;
  /** 语句起始行号，1 起。 */
  line: number;
  /** 语句原文；跨行折成一行，直接进报错。 */
  text: string;
}

function moduleStatements(source: string): ModuleStatement[] {
  const patterns = [
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\1/gm,
    /^[ \t]*import\s*(['"])([^'"]+)\1/gm,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  const found: ModuleStatement[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[0];
      // 类型擦除：import type / export type 整段运行时不留痕。
      // （import { type X } 不算——语句本身还在，模块照样会在运行时被解析。）
      if (/^[ \t]*(?:import|export)\s+type\b/.test(raw)) continue;
      found.push({
        specifier: match[2],
        line: source.slice(0, match.index ?? 0).split('\n').length,
        text: raw.replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return found;
}

/** 递归收集目录下的 TS 文件（Node 24 的 readdirSync recursive）。 */
function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|tsx|mts)$/.test(entry.name)) continue;
    const parent = (entry as { parentPath?: string }).parentPath ?? dir;
    out.push(join(parent, entry.name));
  }
  return out.sort();
}

/** 扫一个目录：返回「文件:行号 原文」形式的框架运行时依赖清单。 */
function frameworkRuntimeImports(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of typescriptFiles(dir)) {
    for (const statement of moduleStatements(readFileSync(file, 'utf8'))) {
      if (!statement.specifier.startsWith('cortico/')) continue;
      const rel = file.slice(dir.length + 1).replace(/\\/g, '/');
      offenders.push(rel + ':' + String(statement.line) + ' ' + statement.text);
    }
  }
  return offenders;
}

test('包内没有框架运行时依赖：cortico/* 只能 import type（全文件匹配 + 递归）', () => {
  const srcDir = join(ROOT, 'src');
  const offenders = frameworkRuntimeImports(srcDir);
  assert.deepEqual(
    offenders,
    [],
    '运行时 import 框架会让裸 node 加载失败，也会让测试跑不起来：\n' + offenders.join('\n'),
  );

  // 递归真的覆盖到子目录——W2/W3/W4/W5 的代码都在里面，正是这条护栏最该管的地方。
  const files = typescriptFiles(srcDir).map((file) => file.slice(srcDir.length + 1).replace(/\\/g, '/'));
  for (const sub of ['cdp', 'x', 'learn', 'tools']) {
    assert.ok(files.some((file) => file.startsWith(sub + '/')), '递归没扫到 src/' + sub + '/：' + files.join(', '));
  }
  assert.ok(files.length >= 10, '扫到的文件太少，递归可能没生效：' + String(files.length));
});

test('护栏自身的正反例：多行 import type 放过，真运行时 import 必抓（含子目录）', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'x-feed-guard-'));
  try {
    mkdirSync(join(scratch, 'nested', 'deep'), { recursive: true });
    // 应当放过：多行 import type 与 export type
    writeFileSync(
      join(scratch, 'multi-line-type.ts'),
      [
        'import type {',
        '  ToolDef,',
        '  World,',
        "} from 'cortico/core/types.ts';",
        "export type { XSource } from 'cortico/x/types.ts';",
        '',
      ].join('\n'),
    );
    // 应当抓到：子目录里的普通 import
    writeFileSync(
      join(scratch, 'nested', 'deep', 'runtime.ts'),
      ["import { describeTools } from 'cortico/world.ts';", ''].join('\n'),
    );
    // 应当抓到：副作用 import 与动态 import
    writeFileSync(join(scratch, 'side-effect.ts'), "import 'cortico/core/loop.ts';\n");
    writeFileSync(
      join(scratch, 'dynamic.ts'),
      "export async function load() { return import('cortico/prefix.ts'); }\n",
    );
    // 应当抓到：值再导出（export ... from 也是运行时依赖）
    writeFileSync(join(scratch, 're-export.ts'), "export { describeTools } from 'cortico/world.ts';\n");
    // 应当放过：注释与普通字符串里提到 cortico/ 不是依赖
    writeFileSync(
      join(scratch, 'notes.ts'),
      ["// import type { X } from 'cortico/ignored.ts';", "const s = \"from 'cortico/also-ignored.ts'\";", ''].join('\n'),
    );

    const offenders = frameworkRuntimeImports(scratch);
    assert.equal(offenders.length, 4, '只该抓到 4 条真依赖，实际：\n' + offenders.join('\n'));
    assert.ok(
      offenders.some((item) => item.startsWith('re-export.ts:1 ') && item.includes("export { describeTools } from 'cortico/world.ts'")),
      offenders.join('\n'),
    );
    assert.ok(
      offenders.some((item) => item.startsWith('nested/deep/runtime.ts:1 ') && item.includes("from 'cortico/world.ts'")),
      '子目录里的运行时 import 必须抓到，且报错带 文件:行号 原文：\n' + offenders.join('\n'),
    );
    assert.ok(
      offenders.some((item) => item.startsWith('side-effect.ts:1 ') && item.includes("import 'cortico/core/loop.ts'")),
      offenders.join('\n'),
    );
    assert.ok(
      offenders.some((item) => item.startsWith('dynamic.ts:1 ') && item.includes("import('cortico/prefix.ts')")),
      offenders.join('\n'),
    );
    assert.ok(
      !offenders.some((item) => item.includes('multi-line-type.ts')),
      '多行 import type 被误判了：\n' + offenders.join('\n'),
    );
    assert.ok(
      !offenders.some((item) => item.includes('notes.ts')),
      '注释或字符串被误判了：\n' + offenders.join('\n'),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('文档：README 说清怎么装怎么排错，NOTICE 保留许可与出处', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /data\/logs\/core\.log/, '排错指向 core.log（REPORT 第 10 条）');
  assert.match(readme, /node --test/);
  assert.match(readme, /corepack pnpm add|选本机目录/, '安装路径写清楚');
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  assert.match(notice, /MIT/);
  assert.match(notice, /cortico-world-browser/, '参照过就要写出处');
  assert.match(notice, /Copyright/);
  // 本包的 MIT 与上游实现是两件事，分节写
  assert.match(notice, /Copyright \(c\) 2026 Alice-Marx/, '本包的版权行');
  assert.match(notice, /Phantivia/, '上游的版权声明按 MIT 保留');
  assert.match(notice, /LICENSE/, '本包许可指到 LICENSE 文件');
  // 测试夹具的来源与用途：公开内容、只做回归、不进 npm 包
  assert.match(notice, /x-real-profile-2026-10\.html/, '夹具要写明来源');
  assert.match(notice, /仅用于解析器回归测试/, '夹具用途声明');
  assert.match(notice, /files 不含 tests/, '夹具不随包发布');
});

test('仓库元信息：LICENSE / 公开仓库地址 / files 白名单 / .gitignore', () => {
  // package.json 说 MIT，就必须有 LICENSE 这份文件（市场与 GitHub 都看它）
  assert.equal(pkg.license, 'MIT');
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Alice-Marx/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);

  // 公开仓库地址：三处都在，且指向 github
  assert.match(pkg.repository.url, /^https:\/\/github\.com\/Alice-Marx\/cortico-world-x/);
  assert.equal(pkg.repository.type, 'git');
  assert.match(pkg.homepage, /^https:\/\/github\.com\/Alice-Marx\/cortico-world-x/);
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\/Alice-Marx\/cortico-world-x\/issues/);

  // 要能发 npm：不能是 private
  assert.equal(pkg.private, undefined, 'private 会让 npm publish 直接失败');

  // files 白名单：只发运行时需要的东西，tests/ 与 PLAN.md 不进包
  for (const entry of ['src/', 'assets/', 'scripts/', 'docs/', 'describe.json', 'README.md', 'LICENSE', 'NOTICE']) {
    assert.ok(pkg.files.includes(entry), 'files 少了 ' + entry);
  }
  for (const forbidden of ['tests', 'tests/', 'PLAN.md']) {
    assert.ok(!pkg.files.includes(forbidden), 'files 不该包含 ' + forbidden);
  }

  // .gitignore：依赖、日志、运行时产物都要挡住，免得在包目录里试跑污染仓库
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  for (const pattern of [
    'node_modules/',
    'coverage/',
    'dist/',
    '*.tgz',
    '*.tmp',
    '*.log',
    '.DS_Store',
    'browser-profile/',
    'export-*.json',
    'index.jsonl',
    'state.json',
    'sources.local.json',
    'login-done',
    'meta.json',
    '*.bad-*',
    'PLAN.md',
  ]) {
    assert.ok(ignore.includes(pattern), '.gitignore 少了 ' + pattern);
  }
});
