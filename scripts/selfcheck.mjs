#!/usr/bin/env node
/**
 * scripts/selfcheck.mjs —— 一条命令的只读体检。给自动化验收用：stdout 只有一行紧凑 JSON，退出码分 PASS/FAIL。
 *
 * 查六件事（对应 PLAN 第 8 条里不依赖人眼的那几条）：
 *   1. package   包清单形状：type=module、cortico{kind:world,api:6,…}、入口/图标/describe 文件都在、标签不越界
 *   2. describe  describe.json 与 src 同源：从默认导出重算 tools/events/prompts 再逐字段比（等同 check:extension
 *                的比对逻辑，C/extensions/describe-export.ts:109-176），外加 tools() 的工具名都在声明里
 *   3. tests     node --test 的结果摘要（TAP 的 # pass / # fail）
 *   4. install   Coopanion 装着本包、版本一致、装的那份就是本目录（链接指别处会告警）
 *   5. config    部署 config.json 里 worlds.<id>.enabled 是 true（装了不等于启用），sources 每一行都能解析
 *   6. log       data/logs/core.log 最近 N 行（默认 50）里有没有 x-feed 的 ERROR
 *
 * 退出码：0 = PASS，1 = FAIL，2 = 用法或部署目录不认（连体检都做不了）。
 *
 *   node scripts/selfcheck.mjs                     # 默认部署根，人读摘要走 stderr，JSON 走 stdout
 *   node scripts/selfcheck.mjs --pretty            # JSON 缩进，方便看
 *   node scripts/selfcheck.mjs --skip-tests        # 不跑 node --test（省 3 秒）
 *   node scripts/selfcheck.mjs --data <部署根>      # 也认 CORTICO_COMPANION_DATA
 *   node scripts/selfcheck.mjs --log-lines 200     # 往回多看几行日志
 *   node scripts/selfcheck.mjs --config <路径>      # 部署配置不在默认位置时指过去
 *
 * 只读：除了一次性的临时目录（构造 World 用，跑完删掉）不写任何东西。
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  PKG_DIR,
  inspectInstalled,
  missingDeploymentLines,
  parseArgv,
  pickLayout,
  readJsonFile,
  resolveBotConfig,
  resolveEntry,
  samePath,
  worldIdentity,
} from './install.mjs';

const DEFAULT_LOG_LINES = 50;
/** 整轮 node --test 的墙钟上限。 */
const DEFAULT_TESTS_TIMEOUT_MS = 240000;
/**
 * 单个用例的上限（Node 的 --test-timeout）。这里是 3 秒跑完 165 个用例的套件，
 * 单个用例卡住基本等于挂着了一个句柄（真浏览器连接、没关的 socket）；给每个用例一个看门狗，
 * 整轮就不会陪着一直等。
 */
const DEFAULT_TEST_CASE_TIMEOUT_MS = 60000;
/** TAGS.md:38-40 明写「仅维护者可以声明」，作者带上会被市场退回。 */
const MAINTAINER_ONLY_TAGS = new Set(['pal-ai-world', 'corti', 'coopanion']);
/** 见过的标签词表（raw/TAGS.md:44-70）。不在表里只告警：官方会加词，写死会误判。 */
const KNOWN_TAGS = new Set([
  'im', 'qq', 'streaming', 'game', 'internet', 'browser', 'video', 'voice', 'computer-use',
  'real-world', 'apps', 'memory', 'companion', 'creative', 'diagnostics', 'local',
  'external-setup', 'requires-key', 'experimental', 'internal-state', 'requires-extension',
  'high-cost', 'unofficial-api', 'unsafe', 'sensitive-data', 'injection-risk', 'notice', 'warning',
]);

const checks = [];
const fails = [];
const warns = [];
const data = {};

/** 记一项检查：ok=true 过；detail 是给人看的一句话。 */
function add(id, ok, detail, extra = undefined) {
  const entry = { id, ok, detail };
  if (extra !== undefined) entry.data = extra;
  checks.push(entry);
  if (!ok) fails.push(id + ': ' + detail);
  return ok;
}
const warn = (message) => warns.push(message);

// ── 1. 包清单 ──────────────────────────────────────────────────────────────

function checkPackage() {
  const file = join(PKG_DIR, 'package.json');
  if (!existsSync(file)) return add('package', false, '找不到 ' + file);
  let pkg;
  try {
    pkg = readJsonFile(file);
  } catch (error) {
    return add('package', false, 'package.json 不是合法 JSON：' + message(error));
  }
  const problems = [];
  if (typeof pkg.name !== 'string' || pkg.name === '') problems.push('缺 name');
  if (typeof pkg.version !== 'string' || pkg.version === '') problems.push('缺 version');
  if (pkg.type !== 'module') problems.push('type 不是 "module"（C/extensions.ts:332-335 按 ESM import）');
  const entry = resolveEntry(PKG_DIR, pkg);
  if (!existsSync(entry)) problems.push('入口文件不在：' + entry);
  const cortico = pkg.cortico;
  if (!cortico || typeof cortico !== 'object') problems.push('缺 cortico 块');
  else {
    if (cortico.kind !== 'world') problems.push('cortico.kind=' + String(cortico.kind) + '，world 包要 "world"');
    if (cortico.api !== 6) problems.push('cortico.api=' + String(cortico.api) + '，world 是 6（C/extensions/manifest.ts:23-27）');
    if (typeof cortico.displayName !== 'string' || cortico.displayName === '') problems.push('cortico.displayName 空着');
    if (typeof cortico.icon === 'string' && cortico.icon !== '' && !existsSync(join(PKG_DIR, cortico.icon))) {
      problems.push('cortico.icon 指向的文件不在：' + cortico.icon);
    }
    if (typeof cortico.describe !== 'string' || cortico.describe === '') problems.push('缺 cortico.describe（市场与 check:extension 都读它）');
    else if (!existsSync(join(PKG_DIR, cortico.describe))) problems.push('cortico.describe 指向的文件不在：' + cortico.describe);
    const tags = canonTags(cortico.tags);
    if (tags === null) problems.push('cortico.tags 不是字符串数组');
    else {
      for (const tag of tags) {
        if (MAINTAINER_ONLY_TAGS.has(tag)) problems.push('标签 "' + tag + '" 只有维护者能声明（raw/TAGS.md:38-40）');
        else if (!KNOWN_TAGS.has(tag)) warn('标签 "' + tag + '" 不在见过的词表里（raw/TAGS.md 可能加了新词）');
      }
      if (tags.length === 0) problems.push('cortico.tags 是空的');
    }
    const locales = cortico.locales;
    if (locales !== undefined) {
      if (!locales || typeof locales !== 'object' || Array.isArray(locales)) problems.push('cortico.locales 不是对象');
      else {
        for (const [key, value] of Object.entries(locales)) {
          if (key !== 'zh' && key !== 'en') problems.push('locales 只认 zh/en，多了 "' + key + '"（C/extensions/manifest.ts:42-55）');
          const keys = value && typeof value === 'object' ? Object.keys(value) : [];
          const extra = keys.filter((k) => k !== 'displayName' && k !== 'description');
          if (extra.length > 0) problems.push('locales.' + key + ' 只许 displayName/description，多了 ' + extra.join(','));
        }
      }
    }
  }
  const where = entry.startsWith(PKG_DIR) ? entry.slice(PKG_DIR.length + 1).split('\\').join('/') : entry;
  if (problems.length > 0) return add('package', false, problems.join('；'), { name: pkg.name, version: pkg.version });
  return add(
    'package',
    true,
    String(pkg.name) + '@' + pkg.version + ' · world/api6 · 入口 ' + where + ' · ' + canonTags(cortico.tags).length + ' 个标签',
    { name: pkg.name, version: pkg.version },
  );
}

const canonTags = (value) => (Array.isArray(value) && value.every((t) => typeof t === 'string') ? value : null);

// ── 2. describe.json 与 src 同源 ───────────────────────────────────────────

/**
 * 从默认导出重算一遍该写进 describe.json 的内容，再与包里那份逐字段比。
 * 形状照抄 C/extensions/describe-export.ts:44-96：World 只有 { tools, events }，prompts 取
 * 实例 webUi('zh').promptDocs 里 role=envPrompt 的模板原文（:29-38）。
 */
async function checkDescribe(pkg) {
  const rel = String((pkg.cortico && pkg.cortico.describe) || 'describe.json');
  const describeFile = join(PKG_DIR, rel);
  if (!existsSync(describeFile)) return add('describe', false, '缺 ' + rel);
  let written;
  try {
    written = JSON.parse(readFileSync(describeFile, 'utf8'));
  } catch (error) {
    return add('describe', false, rel + ' 不是合法 JSON：' + message(error));
  }
  const entry = resolveEntry(PKG_DIR, pkg);
  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (error) {
    return add('describe', false, '导入入口失败：' + message(error));
  }
  const def = mod.default;
  if (!def || typeof def !== 'object') return add('describe', false, '入口没有 default 导出');
  if (!def.describe || typeof def.describe !== 'object') return add('describe', false, '定义没有 describe（check:extension 会直接判失败）');

  const problems = [];
  const expected = { tools: [...(def.describe.tools ?? [])], events: [...(def.describe.events ?? [])] };

  // 实例侧：构造一次（不调 start()），拿 envPrompt 原文与 tools() 的名字。
  let scratch = null;
  let liveNames = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'xfeed-selfcheck-'));
    const cfg = def.defaults();
    const ctx = {
      id: def.id,
      cfg,
      timezone: 'UTC',
      botName: 'selfcheck',
      botDir: scratch,
      packageDir: PKG_DIR,
      dataDir: join(scratch, 'data'),
      repoRoot: PKG_DIR,
      secret: () => '',
      storeSecret: () => {},
      persist: (patch) => Object.assign(cfg, patch),
      restart: async () => {},
    };
    mkdirSync(join(scratch, 'data'), { recursive: true });
    const world = def.create(ctx);
    const decl = typeof world.webUi === 'function' ? world.webUi('zh') : null;
    const docs = (decl && Array.isArray(decl.promptDocs) ? decl.promptDocs : []).filter((d) => d && d.role === 'envPrompt');
    const prompts = [];
    for (const doc of docs) {
      if (!doc || typeof doc.path !== 'string' || !existsSync(doc.path)) continue;
      prompts.push({ key: doc.key, title: doc.title, ...(doc.role ? { role: doc.role } : {}), content: readFileSync(doc.path, 'utf8') });
    }
    if (prompts.length > 0) expected.prompts = prompts;
    if (typeof world.tools === 'function') liveNames = world.tools().map((tool) => tool.name);
  } catch (error) {
    warn('构造实例失败，prompt 与 tools() 那两项没查：' + message(error));
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* 临时目录删不掉不影响判断 */
      }
    }
  }

  // 和 check:extension 一样先做一次 JSON 往返，再深比。
  const normalized = JSON.parse(JSON.stringify(expected));
  if (!isDeepStrictEqual(written, normalized)) {
    const diff = describeDiff(normalized, written);
    problems.push(rel + ' 与代码不一致：' + diff);
  }
  if (liveNames !== null) {
    const declared = new Set((def.describe.tools ?? []).map((tool) => tool.name));
    const extra = liveNames.filter((name) => !declared.has(name));
    if (extra.length > 0) problems.push('tools() 返回了没声明的工具：' + extra.join(','));
  }
  if (problems.length > 0) return add('describe', false, problems.join('；'));
  const counts = (normalized.tools ?? []).length + ' 工具 / ' + (normalized.events ?? []).length + ' 事件 / ' + (normalized.prompts ?? []).length + ' 提示词';
  return add('describe', true, rel + ' 与 src 同源（' + counts + (liveNames === null ? ' · tools() 未查' : ' · tools() 名字都在声明里') + '）');
}

/** 只报哪里不一样，别把整份 JSON 倒出来。 */
function describeDiff(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const parts = [];
  for (const key of keys) {
    if (!(key in actual)) parts.push('少 ' + key);
    else if (!(key in expected)) parts.push('多 ' + key);
    else if (!isDeepStrictEqual(expected[key], actual[key])) {
      if (Array.isArray(expected[key]) && Array.isArray(actual[key])) {
        const label = (item) => (item && typeof item === 'object' ? item.name ?? item.type ?? '?' : '?');
        const a = expected[key].map(label);
        const b = actual[key].map(label);
        if (isDeepStrictEqual(a, b)) parts.push(key + ' 内容有差（名字齐全，字段不同）');
        else parts.push(key + ' 名单不同（代码 ' + a.join(',') + ' vs 文件 ' + b.join(',') + '）');
      } else parts.push(key + ' 不同');
    }
  }
  return parts.length > 0 ? parts.join('；') + ' —— 重跑 pnpm describe:extension 或手工同步' : '字段一致但顺序/类型有别（重跑 describe:extension）';
}

// ── 3. node --test ─────────────────────────────────────────────────────────

function checkTests(timeoutMs, caseTimeoutMs) {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=' + String(caseTimeoutMs)], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const tap = (run.stdout ?? '') + (run.stderr ?? '');
  const num = (label) => {
    const match = new RegExp('^# ' + label + ' (\\d+)$', 'm').exec(tap);
    return match ? Number(match[1]) : null;
  };
  const tests = num('tests');
  const pass = num('pass');
  const fail = num('fail');
  const failedNames = [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].replace(/\s+#.*$/, '')).slice(0, 5);
  const duration = /^# duration_ms ([\d.]+)$/m.exec(tap);
  const parsed = tests !== null && pass !== null && fail !== null;
  if (!parsed && run.status === 0) warn('TAP 摘要解析不出来，只按退出码判定（Node 换了输出格式？）');
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  const ok = run.status === 0 && (fail ?? 0) === 0 && (parsed ? pass > 0 : true) && !timedOut;
  const summary = {
    exit: run.status,
    tests,
    pass,
    fail,
    durationMs: duration ? Math.round(Number(duration[1])) : null,
    failed: failedNames,
  };
  data.tests = summary;
  let detail;
  if (timedOut) detail = 'node --test 超过 ' + Math.round(timeoutMs / 1000) + 's 没跑完；用 --tests-timeout-ms 放宽（单用例上限 --test-case-timeout-ms）';
  else if (parsed) detail = 'pass ' + pass + '/' + tests + (fail > 0 ? '，fail ' + fail + '：' + failedNames.join(' , ') : '') + ' · ' + summary.durationMs + 'ms';
  else detail = '退出码 ' + run.status + '（摘要没解析出来）· ' + ((run.stderr ?? '').trim().split(/\r?\n/).pop() ?? '');
  return add('tests', ok, detail, summary);
}

// ── 4. Coopanion 装着本包吗 ─────────────────────────────────────────────────

function checkInstall(layout, pkg) {
  const name = String(pkg.name);
  const localVersion = String(pkg.version);
  if (!existsSync(layout.extensionsDir)) return add('install', false, '找不到扩展目录 ' + layout.extensionsDir + '（Coopanion 装在哪？用 --data 指）');
  let manifest;
  try {
    manifest = readJsonFile(layout.packageJson);
  } catch (error) {
    return add('install', false, 'data/extensions/package.json 读不出来：' + message(error));
  }
  const spec = manifest.dependencies ? manifest.dependencies[name] : undefined;
  const dest = join(layout.nodeModules, ...name.split('/'));
  const installed = inspectInstalled(dest);
  const info = { installed: false, spec: spec ?? null, mode: installed.kind, version: null, versionMatch: false, sameSource: false };
  const problems = [];
  if (spec === undefined && installed.kind === 'absent') {
    problems.push('没装：dependencies 里没有 ' + name + '，node_modules 里也没有（跑 node scripts/install.mjs）');
  } else if (spec === undefined) {
    problems.push('dependencies 里没有 ' + name + '（没登记，重启后框架不会加载它）');
  } else if (installed.kind === 'absent') {
    problems.push('依赖表有这一行，但 node_modules/' + name + ' 不在（差一次 install，或被 pnpm install 清掉了）');
  }
  if (installed.kind === 'link' && installed.target && !samePath(installed.target, PKG_DIR)) {
    warn('装的是另一个目录：' + installed.target + '（不是本目录 ' + PKG_DIR + '）');
  }
  if (installed.kind === 'link' && installed.target && samePath(installed.target, PKG_DIR)) info.sameSource = true;
  if (installed.kind === 'copy') info.sameSource = false;
  let installedPkg = null;
  if (installed.kind !== 'absent') {
    try {
      installedPkg = readJsonFile(join(dest, 'package.json'));
      info.version = installedPkg.version ?? null;
      info.versionMatch = installedPkg.version === localVersion;
      if (!info.versionMatch) problems.push('装的版本 ' + String(installedPkg.version) + ' ≠ 本目录 ' + localVersion);
      info.installed = true;
    } catch (error) {
      problems.push('装的那份 package.json 读不出来：' + message(error));
    }
  }
  if (spec !== undefined && spec !== 'file:' + PKG_DIR.split('\\').join('/')) {
    if (String(spec).startsWith('file:')) {
      const pointed = String(spec).slice(5).split('/').join('\\');
      if (!samePath(pointed, PKG_DIR)) warn('依赖行指的路径不是本目录：' + pointed);
    } else warn('依赖行是 "' + spec + '"（不是 file: 本地目录）；下次 pnpm install 会按注册表重装');
  }
  if (installedPkg) {
    const installedEntry = resolveEntry(dest, installedPkg);
    if (!existsSync(installedEntry)) problems.push('装的那份缺入口文件：' + installedEntry);
    const describeRel = String((installedPkg.cortico && installedPkg.cortico.describe) || 'describe.json');
    if (!existsSync(join(dest, describeRel))) problems.push('装的那份缺 ' + describeRel);
  }
  data.install = info;
  if (problems.length > 0) return add('install', false, problems.join('；'), info);
  const how = installed.kind === 'link' ? '软链→本目录' : '复制';
  return add('install', true, name + ' ' + String(info.version) + ' 已装（' + how + '）', info);
}

// ── 5. 部署配置：worlds.<id>.enabled ───────────────────────────────────────

/**
 * 装了 ≠ 启用：装配层按 worlds.<id>.enabled 决定挂不挂载（C/world.ts:219-263），
 * 没打开的话重启后 World 页根本不会出现。顺带用包自己的解析器（src/config.ts 的
 * sourceLines / parseSourceLine）把 sources 每一行过一遍 —— preflight 拒绝激活的头号原因就是它。
 */
async function checkConfig(layout, opts) {
  const target = resolveBotConfig(layout, opts.config);
  if (!target || !target.file || !existsSync(target.file)) {
    const seen = target && target.candidates && target.candidates.length > 0 ? '看到这些 bot 目录：' + target.candidates.join(', ') : '没看到任何 <data>\\home\\*\\config.json';
    return add('config', false, '找不到部署配置 config.json（' + seen + '）；用 --config 指过去');
  }
  let manifest;
  try {
    manifest = readJsonFile(target.file);
  } catch (error) {
    return add('config', false, target.file + ' 不是合法 JSON：' + message(error));
  }
  const ident = await worldIdentity();
  const section = manifest.worlds ? manifest.worlds[ident.id] : undefined;
  const info = { file: target.file, how: target.how, worldId: ident.id, enabled: false, keys: 0, sources: [] };
  if (!section || typeof section !== 'object') {
    data.config = info;
    return add('config', false, 'worlds.' + ident.id + ' 段不在（装包不等于启用：跑 node scripts/install.mjs，或在控制台 World 页保存一次）', info);
  }
  info.enabled = section.enabled === true;
  info.keys = Object.keys(section).length;
  const problems = [];
  if (!info.enabled) problems.push('worlds.' + ident.id + '.enabled = ' + JSON.stringify(section.enabled) + '（不是 true，重启后不会挂载）');
  try {
    const mod = await import(pathToFileURL(join(PKG_DIR, 'src', 'index.ts')).href);
    const { sourceLines, parseSourceLine } = mod;
    if (typeof sourceLines === 'function' && typeof parseSourceLine === 'function') {
      const lines = sourceLines(section.sources);
      info.sources = lines;
      if (lines.length === 0) problems.push('sources 是空的（preflight 会拒绝激活）');
      for (const line of lines) {
        if (parseSourceLine(line) === null) problems.push('sources 有一行读不懂：' + line);
      }
    }
  } catch (error) {
    warn('sources 没检查（包的解析器导入失败）：' + message(error));
  }
  if (section.port !== undefined) {
    const port = Number(section.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('port=' + JSON.stringify(section.port) + ' 不是 1-65535 的整数（preflight 会拒绝激活）');
  }
  data.config = info;
  if (problems.length > 0) return add('config', false, problems.join('；'), info);
  const sources = info.sources.length > 0 ? '源 ' + info.sources.length + ' 行（' + info.sources[0] + (info.sources.length > 1 ? ' …' : '') + '）' : '源没检查';
  return add('config', true, 'worlds.' + ident.id + '.enabled=true · ' + sources + ' · ' + target.how, info);
}

// ── 6. 日志最近 N 行 ────────────────────────────────────────────────────────

/** 读文件尾部若干行。大文件只读最后 256KB，避免把 5MB 日志搬进内存。 */
function readTailLines(file, count) {
  const size = statSync(file).size;
  const window = 256 * 1024;
  const start = Math.max(0, size - window);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  let read = 0;
  try {
    read = readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, read).toString('utf8');
  const lines = text.split(/\r?\n/);
  if (start > 0 && lines.length > 0) lines.shift();
  return lines.filter((line) => line !== '').slice(-count);
}

function checkLog(layout, lines) {
  if (!existsSync(layout.coreLog)) {
    data.log = { path: layout.coreLog, lines: 0, xFeedLines: 0, errors: 0, warns: 0, samples: [] };
    warn('没有 core.log（Core 还没跑过？）：' + layout.coreLog);
    return add('log', true, '没有 core.log，跳过（Core 没启动过）', data.log);
  }
  const tail = readTailLines(layout.coreLog, lines);
  const related = tail.filter((line) => /x-feed|cortico-world-x|world:x-feed/i.test(line));
  const errorLike = /(^|\s)ERROR(\s|$)|\bException\b|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|cannot find|not found|失败|抛错/i;
  const warnLike = /(^|\s)WARN(\s|$)/;
  const errors = related.filter((line) => errorLike.test(line));
  const warnsHit = related.filter((line) => warnLike.test(line) && !errorLike.test(line));
  data.log = {
    path: layout.coreLog,
    lines: tail.length,
    xFeedLines: related.length,
    errors: errors.length,
    warns: warnsHit.length,
    samples: [...errors, ...warnsHit].slice(0, 3).map((line) => line.slice(0, 200)),
  };
  if (errors.length > 0) return add('log', false, '最近 ' + tail.length + ' 行里有 ' + errors.length + ' 条 x-feed ERROR：' + errors[0].slice(0, 180), data.log);
  if (warnsHit.length > 0) warn('x-feed 有 ' + warnsHit.length + ' 条 WARN（不算失败）：' + warnsHit[0].slice(0, 180));
  return add(
    'log',
    true,
    '最近 ' + tail.length + ' 行：x-feed 相关 ' + related.length + ' 行，ERROR ' + errors.length + '，WARN ' + warnsHit.length,
    data.log,
  );
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const message = (error) => (error && error.message ? error.message : String(error));

function usage() {
  process.stdout.write(
    [
      '用法：node scripts/selfcheck.mjs [选项]',
      '',
      '  --data <路径>         部署根（含 data\\extensions 的那一层）或 data 目录本身；CORTICO_COMPANION_DATA 同义',
      '  --config <文件>       部署配置 config.json（默认 <data>\\home\\<bot>\\config.json）',
      '  --skip-tests          不跑 node --test',
      '  --tests-timeout-ms N  node --test 整轮的墙钟上限，默认 ' + DEFAULT_TESTS_TIMEOUT_MS,
      '  --test-case-timeout-ms N  单个用例上限（看门狗），默认 ' + DEFAULT_TEST_CASE_TIMEOUT_MS,
      '  --log-lines N         core.log 往回看多少行，默认 ' + DEFAULT_LOG_LINES,
      '  --pretty              JSON 缩进输出',
      '  -h, --help            这一屏',
      '',
      '退出码：0 PASS / 1 FAIL / 2 用法或部署目录不认',
    ].join('\n') + '\n',
  );
}

async function main(argv) {
  const { flags, opts } = parseArgv(argv);
  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }
  const pretty = flags.has('pretty');
  const skipTests = flags.has('skip-tests') || flags.has('no-tests');
  const testsTimeout = Number(opts['tests-timeout-ms'] ?? DEFAULT_TESTS_TIMEOUT_MS);
  const caseTimeout = Number(opts['test-case-timeout-ms'] ?? DEFAULT_TEST_CASE_TIMEOUT_MS);
  const logLines = Number(opts['log-lines'] ?? DEFAULT_LOG_LINES);
  const layout = pickLayout(opts);

  const report = {
    ok: false,
    exit: 1,
    pkg: { name: null, version: null, dir: PKG_DIR, node: process.version },
    deploy: {
      root: layout.root,
      extensions: layout.extensionsDir,
      source: layout.probe ? layout.probe.source : layout.source,
      probe: layout.probe ? layout.probe.tried.map((item) => ({ how: item.how, path: item.path, hit: item.hit })) : [],
    },
    checks,
    fails,
    warns,
    data,
  };

  // 部署目录都不认，后面的 install / config / log 三项没有意义：按用法错误退 2，别混进 PASS/FAIL 里。
  if (!layout.found || !existsSync(layout.extensionsDir)) {
    add(
      'deploy',
      false,
      layout.found
        ? '路径里没有 data\\extensions 或 extensions：' + layout.extensionsDir + '（--data 指错了？）'
        : '没找到 Coopanion 安装目录（--data 是最省事的指定方式，探测顺序见 deploy.probe）',
    );
    report.exit = 2;
    process.stdout.write((pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) + '\n');
    for (const line of missingDeploymentLines(layout)) process.stderr.write(line + '\n');
    process.exit(2);
  }

  checkPackage();
  const pkg = safeManifest();
  report.pkg.name = pkg ? pkg.name ?? null : null;
  report.pkg.version = pkg ? pkg.version ?? null : null;
  if (pkg) {
    await checkDescribe(pkg);
    if (skipTests) add('tests', true, '按 --skip-tests 跳过');
    else checkTests(testsTimeout, Number.isFinite(caseTimeout) && caseTimeout > 0 ? caseTimeout : DEFAULT_TEST_CASE_TIMEOUT_MS);
    checkInstall(layout, pkg);
    await checkConfig(layout, opts);
  } else {
    add('describe', false, '包清单读不出来，后续检查跳过');
    add('tests', false, '包清单读不出来，后续检查跳过');
    add('install', false, '包清单读不出来，后续检查跳过');
    add('config', false, '包清单读不出来，后续检查跳过');
  }
  checkLog(layout, Number.isFinite(logLines) && logLines > 0 ? Math.floor(logLines) : DEFAULT_LOG_LINES);

  report.ok = fails.length === 0;
  report.exit = report.ok ? 0 : 1;
  process.stdout.write((pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)) + '\n');
  const passed = checks.filter((check) => check.ok).length;
  const line =
    (report.ok ? 'selfcheck PASS ' : 'selfcheck FAIL ') +
    passed +
    '/' +
    checks.length +
    (data.tests && data.tests.tests !== null && data.tests.tests !== undefined ? ' · tests ' + data.tests.pass + '/' + data.tests.tests : '') +
    (data.install && data.install.installed ? ' · 已装 ' + String(data.install.version) : ' · 未装') +
    (data.log ? ' · 日志 ERROR ' + data.log.errors : '') +
    (fails.length > 0 ? ' · ' + fails[0] : '');
  process.stderr.write(line + '\n');
  process.exit(report.exit);
}

function safeManifest() {
  try {
    return readJsonFile(join(PKG_DIR, 'package.json'));
  } catch {
    return null;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write('selfcheck: 体检本身出错：' + message(error) + '\n');
    process.exit(2);
  });
}
