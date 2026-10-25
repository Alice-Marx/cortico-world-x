#!/usr/bin/env node
/**
 * scripts/install.mjs —— 把本包装进 Coopanion 的扩展目录。可回滚，可重复跑。
 *
 * 为什么是「复制 / 软链到 node_modules/<包名> + 在 data/extensions/package.json 的 dependencies 里加一行
 * file: 路径」，而不是照文档盲跑 pnpm add：
 * 框架只按 readInstalled() 读 data/extensions/package.json 的 dependencies（C/extensions.ts:110-113），
 * 然后去 <extensions>/node_modules/<name>/package.json 找包（:266-268），再 import 解析出的入口
 * （resolveExtensionEntry :119-130，import :332-341）。也就是说：依赖表里有这一行、node_modules 里有这一份，
 * 就等于装上了。pnpm add 要走网络、改 lockfile、可能把 store 里的硬链接塞进来，装坏了不好退。
 *
 * 步骤（任何一步失败都自动回滚到跑之前的状态）：
 *   预检包 → 备份 package.json → 挪开旧副本 → 建链接/复制 → 加依赖行
 *   → 备份 config.json 并打开 worlds.<世界id>.enabled → 逐项校验 → 打印「下一步」
 *
 * 为什么还要动 config.json：装进 node_modules 只让扩展能被「看到」，装配层按
 * cfg.worlds.<id>.enabled 决定挂不挂载（C/world.ts:219-263），没打开的话重启后 World 根本不出现。
 * 段不存在就写一份默认值；段已存在只补缺的键与 enabled，用户改过的值一律不覆盖，别人的段不碰。
 *
 * 本文件同时是 uninstall.mjs / selfcheck.mjs 的公共底座：布局探测（resolveLayout）、package.json 读写、
 * file: 规范只在这里实现一次，免得三份路径逻辑漂移。import 它没有副作用，main 只在被直接执行时跑。
 *
 *   node scripts/install.mjs                     # 装到本机默认部署根
 *   node scripts/install.mjs --data <部署根>      # 装到别的部署（也认 CORTICO_COMPANION_DATA）
 *   node scripts/install.mjs --copy              # 复制一份而不是软链（默认软链：改源码只需重启）
 *   node scripts/install.mjs --dry-run           # 只打印计划，不动任何文件
 *   node scripts/install.mjs --no-enable         # 只装包，不打开 worlds.<id>.enabled
 *   node scripts/install.mjs --config <路径>      # 部署配置不在默认位置时指过去
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本包目录（scripts/ 的上一级）。装进去的永远是这一份。 */
export const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 指定部署根的另一个入口（与 --data 等价，--data 优先）。 */
export const DATA_ENV = 'CORTICO_COMPANION_DATA';
/** 部署配置的覆盖入口（config.json 不在 <data>/home/<bot>/ 时用）。 */
export const CONFIG_ENV = 'CORTICO_COMPANION_CONFIG';

const COLLATOR = (() => {
  try {
    return new Intl.Collator('en');
  } catch {
    return null;
  }
})();

/** Windows 上比较路径要折大小写（文件系统不分大小写）；其它平台原样。 */
const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

/** realpath 拿不到（路径不存在）时退回归一化后的绝对路径。 */
export function canon(path) {
  try {
    return fold(realpathSync.native(path));
  } catch {
    return fold(resolve(path));
  }
}

export const samePath = (a, b) => canon(a) === canon(b);

/** file: 协议里的路径：正斜杠，Windows 盘符不带多余前缀。 */
export function fileSpec(pkgDir) {
  return 'file:' + resolve(pkgDir).split(sep).join('/');
}

// ── 目录布局 ────────────────────────────────────────────────────────────────

/**
 * 把用户给的路径认成部署根或 data 目录，返回全部落点。
 *
 * 认法（都先看文件在不在，不猜）：
 *   <p>\data\extensions 存在 → p 是部署根；
 *   <p>\extensions 存在     → p 是 data 目录；
 *   路径末段叫 data         → 当 data 目录；
 *   其它                    → 当部署根（后面缺目录时会给出可执行的报错，而不是继续往下走）。
 *
 * @param {string} raw --data 的值或 CORTICO_COMPANION_DATA；必填（探测交给 pickLayout）
 * @param {string} [source] 只用于报告：'--data' | 'env' | 'probe'
 */
export function resolveLayout(raw, source = '--data') {
  const given = String(raw ?? '').trim();
  if (given === '') throw new Error('resolveLayout 需要一个路径；默认位置由 pickLayout 探测');
  const base = resolve(given);
  const has = (p) => existsSync(join(p, 'extensions'));
  let root;
  let dataDir;
  let how;
  if (existsSync(join(base, 'data', 'extensions'))) {
    root = base;
    dataDir = join(base, 'data');
    how = '部署根';
  } else if (has(base)) {
    dataDir = base;
    root = dirname(base);
    how = 'data 目录';
  } else if (basename(base).toLowerCase() === 'data') {
    dataDir = base;
    root = dirname(base);
    how = 'data 目录';
  } else {
    root = base;
    dataDir = join(base, 'data');
    how = '部署根';
  }
  const extensionsDir = join(dataDir, 'extensions');
  return {
    root,
    dataDir,
    extensionsDir,
    packageJson: join(extensionsDir, 'package.json'),
    nodeModules: join(extensionsDir, 'node_modules'),
    logsDir: join(dataDir, 'logs'),
    coreLog: join(dataDir, 'logs', 'core.log'),
    restartFlag: join(dataDir, '.restart-request'),
    how,
    source,
    given,
    found: true,
    exists: existsSync(extensionsDir),
  };
}

/**
 * 按顺序探测部署位置。纯函数：env / platform / pkgDir / home 都可以从参数塞进来（方便单测）。
 *
 * 顺序固定，命中第一条即停（前两条在 pickLayout 里，优先于这里）：
 *   1. --data
 *   2. 环境变量 CORTICO_COMPANION_DATA
 *   3. %LOCALAPPDATA%\Programs\Coopanion   —— Windows 默认安装位置
 *   4. %ProgramFiles%\Coopanion            —— 装到程序目录的那份
 *   5. %ProgramFiles(x86)%\Coopanion       —— 32 位安装
 *   6. 便携版：脚本所在盘符根下的 Coopanion（非 Windows 退化成 ~/Coopanion）
 */
export function deploymentCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pkgDir = options.pkgDir ?? PKG_DIR;
  const home = String(options.home ?? homedir());
  const value = (name) => String(env[name] ?? '').trim();
  const list = [];
  const seen = new Set();
  const push = (how, path) => {
    const given = String(path ?? '').trim();
    if (given === '') return;
    const abs = resolve(given);
    const key = fold(abs);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ how, path: abs });
  };
  const localAppData = value('LOCALAPPDATA');
  if (localAppData !== '') push('%LOCALAPPDATA%\\Programs\\Coopanion', join(localAppData, 'Programs', 'Coopanion'));
  const programFiles = value('ProgramFiles') || value('PROGRAMFILES');
  if (programFiles !== '') push('%ProgramFiles%\\Coopanion', join(programFiles, 'Coopanion'));
  const programFilesX86 = value('ProgramFiles(x86)') || value('PROGRAMFILES(X86)');
  if (programFilesX86 !== '') push('%ProgramFiles(x86)%\\Coopanion', join(programFilesX86, 'Coopanion'));
  const drive = /^([A-Za-z]:)[\\/]/.exec(pkgDir);
  if (platform === 'win32' && drive) push('便携版：脚本盘符 ' + drive[1] + '\\Coopanion', drive[1] + '\\Coopanion');
  else push('便携版：家目录 ~/Coopanion', join(home, 'Coopanion'));
  return list;
}

/** 逐条试，返回 { hit, tried }；tried 里每条都带命中与否，用于报告。 */
export function probeDeployment(options = {}) {
  const candidates = options.candidates ?? deploymentCandidates(options);
  const tried = candidates.map((candidate) => ({
    ...candidate,
    hit: existsSync(join(candidate.path, 'data', 'extensions')) || existsSync(join(candidate.path, 'extensions')),
  }));
  return { hit: tried.find((item) => item.hit) ?? null, tried };
}

/**
 * --data > CORTICO_COMPANION_DATA > 按顺序探测。
 * 都找不到时返回 { found: false, probe }：调用方打 missingDeploymentLines() 并以退出码 2 结束。
 */
export function pickLayout(opts = {}, env = process.env) {
  const fromArg = typeof opts.data === 'string' ? opts.data.trim() : '';
  if (fromArg !== '') {
    const layout = resolveLayout(fromArg, '--data');
    layout.probe = { source: '--data', tried: [{ how: '--data', path: layout.root || resolve(fromArg), hit: true }] };
    return layout;
  }
  const fromEnv = String(env[DATA_ENV] ?? '').trim();
  if (fromEnv !== '') {
    const layout = resolveLayout(fromEnv, 'env');
    layout.probe = { source: 'env', tried: [{ how: DATA_ENV, path: layout.root || resolve(fromEnv), hit: true }] };
    return layout;
  }
  const { hit, tried } = probeDeployment({ env });
  if (hit) {
    const layout = resolveLayout(hit.path, 'probe');
    const index = tried.indexOf(hit) + 1;
    layout.probe = { source: 'probe', tried, index };
    return layout;
  }
  return {
    root: '',
    dataDir: '',
    extensionsDir: '',
    packageJson: '',
    nodeModules: '',
    logsDir: '',
    coreLog: '',
    restartFlag: '',
    how: '未找到',
    source: 'probe',
    given: '',
    found: false,
    exists: false,
    probe: { source: 'probe', tried },
  };
}

/** 「按顺序找过」的报告行，三个脚本共用。 */
export function describeProbe(layout) {
  const probe = layout && layout.probe ? layout.probe : { source: 'probe', tried: [] };
  if (probe.source === '--data') return ['部署根来自 --data：' + (layout.root || layout.given)];
  if (probe.source === 'env') return ['部署根来自环境变量 ' + DATA_ENV + '：' + (layout.root || layout.given)];
  const lines = ['没给 --data，也没设 ' + DATA_ENV + '，按这个顺序探测：'];
  probe.tried.forEach((item, index) => {
    lines.push('  ' + (index + 1) + '. ' + item.how + '  →  ' + item.path + (item.hit ? '   [命中]' : '   [没有]'));
  });
  if (layout.found && probe.index) lines.push('命中第 ' + probe.index + ' 条：' + layout.root);
  else lines.push('一条都没命中。');
  return lines;
}

/** 找不到部署时打给用户的整段话（人话 + 探测证据 + 下一步）。 */
export function missingDeploymentLines(layout) {
  return [
    '没找到 Coopanion 安装目录：请用 --data <部署根> 指定，或设环境变量 ' + DATA_ENV + '。',
    'Windows 默认装在 %LOCALAPPDATA%\\Programs\\Coopanion；便携版就是 Coopanion.exe 所在的那一层（里面应有 data\\extensions）。',
    ...describeProbe(layout),
  ];
}

// ── 参数 / 输出 ─────────────────────────────────────────────────────────────

/** 极简参数解析：--k=v、--k v、--flag。没有位置参数。 */
export function parseArgv(argv) {
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      flags.add(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      opts[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[name] = next;
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, opts };
}

const out = (line = '') => process.stdout.write(line + '\n');
const ok = (label, detail = '') => out('  [ok] ' + label + (detail ? '  ' + detail : ''));
const bad = (label, detail = '') => out('  [!!] ' + label + (detail ? '  ' + detail : ''));
const info = (label, detail = '') => out('  [--] ' + label + (detail ? '  ' + detail : ''));

/** 本地时间戳，字典序即时间序。 */
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    '-' +
    p(date.getHours()) +
    p(date.getMinutes()) +
    p(date.getSeconds())
  );
}

/** 退出码：0 成了 / 1 校验失败或已回滚 / 2 用法或前置条件不满足（什么都没动）。 */
export function die(message, code = 2) {
  process.stderr.write('install: ' + message + '\n');
  process.exit(code);
}

// ── package.json 读写 ───────────────────────────────────────────────────────

export function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 原子写：同目录临时文件 + rename（Windows 上 rename 覆盖已有文件是原子的）。 */
export function writeTextAtomic(file, text) {
  const tmp = file + '.xfeed-tmp-' + process.pid;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 包里那份 package.json 的规范文本：2 空格缩进 + 结尾换行。 */
export const manifestText = (obj) => JSON.stringify(obj, null, 2) + '\n';

/** 按框架的层次取入口：exports → module → main → index.js（C/extensions.ts:119-130）。 */
export function resolveEntry(pkgDir, pkg) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const o = value;
      return pick(o['.'] ?? o.import ?? o.default ?? null);
    }
    return null;
  };
  const rel = pick(pkg.exports) ?? pick(pkg.module) ?? pick(pkg.main) ?? 'index.js';
  return join(pkgDir, rel);
}

/** 本包的预检：形状不对就别动部署的那堆文件。返回问题列表（空＝过）。 */
export function preflightPackage(pkgDir) {
  const problems = [];
  const file = join(pkgDir, 'package.json');
  if (!existsSync(file)) return { problems: ['找不到 ' + file] };
  let pkg;
  try {
    pkg = readJsonFile(file);
  } catch (error) {
    return { problems: ['package.json 不是合法 JSON：' + error.message] };
  }
  if (typeof pkg.name !== 'string' || pkg.name === '') problems.push('package.json 缺 name');
  if (typeof pkg.version !== 'string' || pkg.version === '') problems.push('package.json 缺 version');
  if (pkg.type !== 'module') problems.push('type 必须是 "module"（框架按 ESM 入口 import，C/extensions.ts:332-335）');
  const cortico = pkg.cortico;
  if (!cortico || typeof cortico !== 'object') problems.push('缺 cortico 块');
  else {
    if (cortico.kind !== 'world') problems.push('cortico.kind 必须是 "world"，实际 ' + String(cortico.kind));
    if (cortico.api !== 6) problems.push('cortico.api 必须是 6（world 的契约版本，C/extensions/manifest.ts:23-27）');
    if (typeof cortico.displayName !== 'string' || cortico.displayName === '') problems.push('cortico.displayName 空着');
    if (typeof cortico.icon === 'string' && cortico.icon !== '' && !existsSync(join(pkgDir, cortico.icon))) {
      problems.push('cortico.icon 指向的文件不在：' + cortico.icon);
    }
    if (typeof cortico.describe === 'string' && cortico.describe !== '' && !existsSync(join(pkgDir, cortico.describe))) {
      problems.push('cortico.describe 指向的文件不在：' + cortico.describe);
    }
  }
  const entry = resolveEntry(pkgDir, pkg);
  if (!existsSync(entry)) problems.push('入口文件不在：' + entry);
  else if (!canon(entry).startsWith(canon(pkgDir) + sep)) {
    problems.push('入口解析到了包外：' + entry + '（框架只按 exports/module/main 取，别让路径跳出包目录）');
  }
  if (!existsSync(join(pkgDir, 'describe.json')) && !(cortico && cortico.describe)) {
    problems.push('既没有 describe.json 也没有 cortico.describe');
  }
  return { problems, pkg, entry };
}

// ── 备份 ────────────────────────────────────────────────────────────────────

/**
 * 备份一个文件到同目录的 <label>.<ext>-<YYYYMMDD-HHmmss>，逐字节校验后返回备份路径。
 * ext 默认 bak-xfeed；uninstall 的安全副本用 pre-uninstall-xfeed（跟 install 的还原点不撞名）。
 * 时间戳撞车（同一秒跑两次）时加 -2、-3，不覆盖旧备份。
 */
export function backupPathFor(file, label, ext = 'bak-xfeed') {
  const stamp = timestamp();
  let dest = join(dirname(file), label + '.' + ext + '-' + stamp);
  let n = 2;
  while (existsSync(dest)) {
    dest = join(dirname(file), label + '.' + ext + '-' + stamp + '-' + n);
    n += 1;
  }
  return dest;
}

export function backupFile(file, label, ext = 'bak-xfeed') {
  const dest = backupPathFor(file, label, ext);
  copyFileSync(file, dest);
  const before = readFileSync(file);
  const after = readFileSync(dest);
  if (before.compare(after) !== 0) throw new Error('备份与原文不一致：' + dest);
  return dest;
}

/** install 的 package.json 备份。 */
export const backupPackageJson = (layout) => backupFile(layout.packageJson, 'package.json');

/** 某个 label 的 bak-xfeed 备份，按文件名（＝时间）从新到旧。 */
export function listBackups(dir, label) {
  if (!existsSync(dir)) return [];
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\.bak-xfeed-\\d{8}-\\d{6}(?:-\\d+)?$');
  const names = readdirSync(dir).filter((name) => re.test(name));
  const sorted = COLLATOR ? names.sort((a, b) => COLLATOR.compare(b, a)) : names.sort().reverse();
  return sorted.map((name) => join(dir, name));
}

/** install 的 package.json 备份列表。 */
export const listInstallBackups = (extensionsDir) => listBackups(extensionsDir, 'package.json');

// ── node_modules 里的那份 ──────────────────────────────────────────────────

/** 只看不跟：是链接（含 Windows junction）、真目录、还是别的。 */
export function inspectInstalled(dir) {
  if (!existsSync(dir) && !lstatExists(dir)) return { kind: 'absent' };
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    let target = null;
    try {
      target = realpathSync.native(dir);
    } catch {
      target = null; // 悬空链接
    }
    return { kind: 'link', target };
  }
  if (st.isDirectory()) return { kind: 'dir' };
  return { kind: 'other' };
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 删链接：先 unlink，Windows junction 上 unlink 会 EPERM，退 rmdir（两者都不碰目标目录）。 */
function removeLink(path) {
  try {
    unlinkSync(path);
    return;
  } catch {
    rmSync(path, { recursive: false, force: false });
  }
}

/**
 * 删掉 node_modules 里的那一份，返回怎么删的。链接只删链接本身，不碰目标目录。
 * 真目录要先核对 package.json 的 name，避免手滑删了别人装的同名无关包。
 */
export function removeInstalled(path, expectedName) {
  const state = inspectInstalled(path);
  if (state.kind === 'absent') return { removed: false, how: 'absent' };
  let name = null;
  try {
    name = readJsonFile(join(path, 'package.json')).name ?? null;
  } catch {
    name = null; // 悬空链接或读不了：链接可以删，目录不行
  }
  if (name !== null && expectedName && name !== expectedName) {
    throw new Error('node_modules 里那份的 name 是 ' + name + '，不是 ' + expectedName + '，不动它');
  }
  if (state.kind === 'link') {
    removeLink(path);
    return { removed: true, how: 'link' };
  }
  if (state.kind === 'other') throw new Error('那个名字既不是目录也不是链接：' + path);
  rmSync(path, { recursive: true, force: false });
  return { removed: true, how: 'copy' };
}

/** 递归复制（跟符号链接走，取内容）。 */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dest, name));
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/** 复制模式要带哪些东西：package.json + 清单里 files 列的每一项（npm/pnpm 打包语义）。 */
function copyEntries(pkg) {
  const listed = Array.isArray(pkg.files) ? pkg.files : ['src', 'assets', 'describe.json', 'NOTICE', 'README.md'];
  return Array.from(new Set(['package.json', ...listed]));
}

// ── 装进去 ──────────────────────────────────────────────────────────────────

/** 建链接：Windows 用 junction（不需要管理员权限），其它平台用目录软链。 */
function linkDir(target, dest) {
  symlinkSync(resolve(target), dest, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 装一份到 node_modules/<name>，返回怎么装的描述。
 * 已有的那份（链接指别处 / 旧复制）会先挪到 <name>.bak-xfeed-<ts>，保证可回滚。
 */
function placePackage(pkgDir, dest, mode) {
  const notes = [];
  let parked = null;
  const existing = inspectInstalled(dest);
  if (existing.kind === 'link') {
    if (existing.target && samePath(existing.target, pkgDir)) return { action: 'reuse', notes: ['已经是本目录的链接，复用'], parked };
    removeLink(dest);
    notes.push('挪掉了指向别处的旧链接 ' + (existing.target ?? '(悬空)'));
  } else if (existing.kind === 'dir') {
    parked = dest + '.bak-xfeed-' + timestamp();
    renameSync(dest, parked);
    notes.push('旧副本挪到 ' + basename(parked) + '（回滚会挪回来）');
  } else if (existing.kind === 'other') {
    throw new Error('node_modules 里那个名字不是目录也不是链接：' + dest);
  }
  if (mode === 'copy') {
    const pkg = readJsonFile(join(pkgDir, 'package.json'));
    mkdirSync(dest, { recursive: true });
    for (const rel of copyEntries(pkg)) {
      const src = join(pkgDir, rel);
      if (!existsSync(src)) continue;
      copyTree(src, join(dest, rel));
    }
    return { action: 'copy', notes, parked };
  }
  linkDir(pkgDir, dest);
  return { action: 'link', notes, parked };
}

/** 在 deploy 目录里用裸 node import 一次装好的入口，证明「装上去能被加载」。 */
function smokeImport(entry, cwd) {
  const script =
    'const m = await import(' +
    JSON.stringify(pathToFileURL(entry).href) +
    ');\n' +
    'const d = m.default;\n' +
    "if (!d || typeof d !== 'object') { console.error('no default export'); process.exit(3); }\n" +
    "if (typeof d.id !== 'string' || d.id === '') { console.error('default.id is empty'); process.exit(4); }\n" +
    "if (typeof d.label !== 'string') { console.error('default.label is not a string'); process.exit(5); }\n" +
    "if (typeof d.defaults !== 'function' || typeof d.create !== 'function') { console.error('defaults/create missing'); process.exit(6); }\n" +
    "console.log('id=' + d.id);\n";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  const idLine = (run.stdout ?? '')
    .split(/\r?\n/)
    .find((line) => line.startsWith('id='));
  const noise = (text) =>
    (text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^Node\.js v/.test(line) && !/ExperimentalWarning|--trace-warnings/.test(line));
  const ok = run.status === 0 && Boolean(idLine);
  // 出错时把「错误类型 + 第一条有信息的话」拎出来，别让人对着 Node 的整屏堆栈找。
  const lines = [...noise(run.stderr), ...noise(run.stdout)];
  const thrown = lines.findIndex((line) => /^[A-Za-z]*Error\b|^Error\b/.test(line));
  const detail = ok ? true : lines.slice(thrown === -1 ? 0 : thrown, (thrown === -1 ? 0 : thrown) + 2).join(' | ') || 'exit ' + String(run.status);
  const codeMatch = /\[?\b(ERR_[A-Z0-9_]+)\b\]?/.exec(lines.join('\n'));
  return { ok, id: idLine ? idLine.slice(3).trim() : null, detail: ok ? '' : detail, code: codeMatch ? codeMatch[1] : null };
}

// ── 部署配置：worlds.<id>.enabled ───────────────────────────────────────────

/**
 * 这份部署的默认源。选 user:<公开大号> 而不是 home 的理由：
 * 两者在未登录时都撞登录墙（回执归「页面没打开」），但 home 还多一种失败——账号已登录而首页推荐流是空的，
 * 那会得到空页（XError 'empty'），看着像解析坏了；公开主页是固定目标，登录着就必然有内容。
 * 验收只要 1 条真内容，确定性比"个性化"重要。改它只需要改这一行。
 */
export const DEFAULT_SOURCES = 'user:elonmusk';

/**
 * 找部署配置 config.json。优先级：--config > CORTICO_COMPANION_CONFIG > <data>/home/<bot>/config.json。
 * Core 的里面是 dataDir = abs(paths.data)（C/deploy.ts:158-168），paths.data 缺省 "data"（C/core/config.ts:127），
 * 相对 botDir 解析；本机 botDir = <部署根>/data/home/companion。
 * 认不出来返回 null，由调用方决定是报错还是跳过。
 */
export function resolveBotConfig(layout, explicit, env = process.env) {
  const fromArg = String(explicit ?? '').trim();
  if (fromArg !== '') return { file: resolve(fromArg), how: '--config', candidates: [] };
  const fromEnv = String(env[CONFIG_ENV] ?? '').trim();
  if (fromEnv !== '') return { file: resolve(fromEnv), how: CONFIG_ENV, candidates: [] };
  const home = join(layout.dataDir, 'home');
  if (!existsSync(home)) return null;
  let candidates = [];
  try {
    candidates = readdirSync(home).filter((entry) => existsSync(join(home, entry, 'config.json')));
  } catch {
    return null;
  }
  if (candidates.length === 1) return { file: join(home, candidates[0], 'config.json'), how: 'home/' + candidates[0], candidates };
  if (candidates.includes('companion')) return { file: join(home, 'companion', 'config.json'), how: 'home/companion', candidates };
  return { file: null, how: 'ambiguous', candidates };
}

/**
 * 世界 id 与默认配置段：优先问包自己（defaults() 是唯一真相），导入失败时退回 PLAN 第 4 节的兜底表。
 * 只 import 一次，装包/自检/卸载共用。
 */
export async function worldIdentity() {
  const fallback = {
    id: 'x-feed',
    defaults: {
      enabled: false,
      mode: 'own',
      port: 9223,
      chromePath: '',
      sources: 'home',
      intervalMinutes: 120,
      limitPerSource: 20,
      maxScrolls: 3,
      vaultSubdir: 'x-feed',
      deliverDigest: true,
      digestMaxChars: 1200,
    },
  };
  try {
    const mod = await import(pathToFileURL(join(PKG_DIR, 'src', 'index.ts')).href);
    const def = mod.default;
    if (def && typeof def.id === 'string' && def.id !== '' && typeof def.defaults === 'function') {
      return { id: def.id, defaults: { ...def.defaults() }, fromCode: true };
    }
    return { ...fallback, fromCode: false, why: '默认导出不是 WorldDefinition' };
  } catch (error) {
    return { ...fallback, fromCode: false, why: String(error && error.message ? error.message : error) };
  }
}

/**
 * 把 worlds.<id>.enabled 打开，写到 config.json。
 *
 * - 段不存在：写 { ...defaults, sources: <能立刻出内容>, enabled: true }；
 * - 段已存在：只补缺的键与 enabled，用户改过的值一律不覆盖；别人的段一根手指都不碰；
 * - 已经开着且不缺键：一次都不写（返回 untouched）。
 *
 * @returns {{ added: string[], changed: string[], untouched: boolean, replaced: boolean }}
 */
export function enableWorldSection(configFile, options) {
  const { worldId, defaults, sources } = options;
  const manifest = JSON.parse(readFileSync(configFile, 'utf8'));
  if (!manifest.worlds || typeof manifest.worlds !== 'object' || Array.isArray(manifest.worlds)) manifest.worlds = {};
  const worlds = manifest.worlds;
  const wanted = { ...defaults };
  if (sources) wanted.sources = sources;
  const added = [];
  const changed = [];
  let replaced = false;
  const current = worlds[worldId];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(wanted)) {
      if (key === 'enabled' || current[key] !== undefined) continue;
      current[key] = value;
      added.push(key);
    }
    if (current.enabled !== true) {
      const had = current.enabled !== undefined;
      current.enabled = true;
      (had ? changed : added).push('enabled');
    }
  } else {
    if (current !== undefined) replaced = true; // 段是 true/字符串之类：按默认段重写，报告里点名
    worlds[worldId] = { ...wanted, enabled: true };
    added.push(...Object.keys(worlds[worldId]));
  }
  if (added.length === 0 && changed.length === 0 && !replaced) return { added, changed, untouched: true, replaced };
  writeTextAtomic(configFile, manifestText(manifest));
  return { added: added.sort(), changed: changed.sort(), untouched: false, replaced };
}

/** 从 config.json 里删掉 worlds.<id>，别的段不动。返回删没删。 */
export function disableWorldSection(configFile, worldId) {
  const manifest = JSON.parse(readFileSync(configFile, 'utf8'));
  const worlds = manifest.worlds;
  if (!worlds || typeof worlds !== 'object' || Array.isArray(worlds) || worlds[worldId] === undefined) return false;
  delete worlds[worldId];
  writeTextAtomic(configFile, manifestText(manifest));
  return true;
}

/** 读回 config.json，看 worlds.<id>.enabled 是不是 true。 */
export function worldEnabled(configFile, worldId) {
  const manifest = JSON.parse(readFileSync(configFile, 'utf8'));
  const section = manifest.worlds && manifest.worlds[worldId];
  return Boolean(section && typeof section === 'object' && section.enabled === true);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function usage() {
  out('用法：node scripts/install.mjs [选项]');
  out('');
  out('  --data <路径>   部署根（含 data\\extensions 的那一层）或 data 目录本身');
  out('                  ' + DATA_ENV + ' 环境变量同义，--data 优先');
  out('  --copy          复制一份进 node_modules（默认软链：改源码只要重启）');
  out('  --dry-run       只打印计划，不动任何文件');
  out('  --no-enable     只装包，不往 config.json 写 worlds.<id>.enabled（重启后不会挂载）');
  out('  --config <文件> 部署配置 config.json 的位置（默认 <data>\\home\\<bot>\\config.json）');
  out('  --keep-on-fail  校验失败时不自动回滚（默认回滚）');
  out('  -h, --help      这一屏');
  out('');
  out('不给 --data 时按顺序探测部署根：' + DATA_ENV + ' → %LOCALAPPDATA%\\Programs\\Coopanion');
  out('  → %ProgramFiles%\\Coopanion → %ProgramFiles(x86)%\\Coopanion → <脚本盘符>\\Coopanion；');
  out('一条都没命中就退出码 2，并打印探测过的每条路径。');
}

async function main(argv) {
  const { flags, opts } = parseArgv(argv);
  if (flags.has('help') || flags.has('h')) {
    usage();
    return;
  }
  const dryRun = flags.has('dry-run');
  const mode = flags.has('copy') ? 'copy' : 'link';
  const layout = pickLayout(opts);
  if (!layout.found) {
    for (const line of missingDeploymentLines(layout)) process.stderr.write(line + '\n');
    process.exit(2);
  }
  const ident = await worldIdentity();
  const enable = !flags.has('no-enable');
  const configTarget = enable ? resolveBotConfig(layout, opts.config) : null;

  out('cortico-world-x → 扩展目录');
  out('');
  const hitNote =
    layout.probe.source === 'probe'
      ? '（探测命中：' + layout.probe.tried[layout.probe.index - 1].how + '）'
      : '（来自 ' + layout.probe.source + '）';
  info('部署根  ' + layout.root + hitNote);
  info('扩展目录 ' + layout.extensionsDir);
  info('包目录  ' + PKG_DIR);
  info('装法    ' + (mode === 'copy' ? '复制' : '软链') + (dryRun ? '（dry-run：不会写任何文件）' : ''));
  info('世界 id ' + ident.id + (ident.fromCode ? '（取自包的 defaults()）' : '（包导入不了，用兜底默认值）'));
  info('部署配置 ' + (enable ? (configTarget && configTarget.file ? configTarget.file + '（' + configTarget.how + '）' : '找不到') : '按 --no-enable 跳过'));
  out('');

  if (!existsSync(layout.extensionsDir)) {
    die('找不到扩展目录 ' + layout.extensionsDir + '（--data 指的路径里没有 data\\extensions 或 extensions）。');
  }
  if (!existsSync(layout.packageJson) && !dryRun) {
    die('扩展目录里没有 package.json：' + layout.packageJson + '。这个目录不是 Coopanion 的 data\\extensions？');
  }
  // 前置条件先查完再动手：配置找不到时不该留下半装状态。
  if (enable && (!configTarget || !configTarget.file)) {
    const seen = configTarget && configTarget.candidates.length > 0 ? '看到这些：' + configTarget.candidates.join(', ') : '没看到任何 <data>\\home\\*\\config.json';
    die('找不到部署配置 config.json（' + seen + '）。用 --config 指过去，或者加 --no-enable 只装包（那样重启后 World 不会挂载）。');
  }
  if (enable && !existsSync(configTarget.file)) {
    die('部署配置不存在：' + configTarget.file + '（--config 指错了？）');
  }

  // 1. 预检
  const pre = preflightPackage(PKG_DIR);
  if (pre.problems.length > 0) {
    out('预检：包形状不对，一个文件都没动');
    for (const problem of pre.problems) bad(problem);
    process.exit(1);
  }
  const pkg = pre.pkg;
  const name = pkg.name;
  const localVersion = pkg.version;
  const entryRel = pre.entry.slice(PKG_DIR.length + 1).split(sep).join('/');
  const dest = join(layout.nodeModules, ...name.split('/'));
  const spec = fileSpec(PKG_DIR);
  ok('包形状', name + '@' + localVersion + ' · 入口 ' + entryRel + ' · cortico.kind=world api=6');

  if (dryRun) {
    out('');
    out('dry-run 计划：');
    info('备份   ' + layout.packageJson + ' → package.json.bak-xfeed-<时间戳>');
    info('装法   ' + dest + ' ← ' + (mode === 'copy' ? '复制 ' + PKG_DIR : '软链 ' + PKG_DIR));
    info('依赖行 "dependencies"."' + name + '" = "' + spec + '"');
    if (enable) info('部署配置 ' + configTarget.file + ' → 备份后写 worlds.' + ident.id + '（enabled=true, sources=' + DEFAULT_SOURCES + ', 其余取默认值）');
    info('校验   ' + (enable ? 10 : 9) + ' 项（副本在不在、版本、入口、describe、图标、依赖行、' + (enable ? 'worlds.enabled、' : '') + '裸 node 加载…）');
    out('');
    // 父任务要求：「--dry-run 下打印『我按这个顺序找过，结果命中了 X』」。
    out('部署根是这样定下来的（dry-run 只读，命中即停）：');
    let step = 1;
    const mark = (how, result) => out('  ' + step++ + '. ' + how.padEnd(30) + ' → ' + result);
    mark('--data', layout.probe.source === '--data' ? layout.root + '   [命中]' : '没给');
    mark(DATA_ENV, layout.probe.source === 'env' ? layout.root + '   [命中]' : '没设');
    for (const candidate of deploymentCandidates({ env: process.env })) {
      const hit =
        layout.probe.source === 'probe' && layout.probe.tried.some((item) => item.hit && samePath(item.path, candidate.path));
      mark(candidate.how, candidate.path + (hit ? '   [命中]' : layout.probe.source === 'probe' ? '   [没有]' : '   [跳过]'));
    }
    if (layout.probe.source === 'probe' && layout.probe.index) out('  命中的是第 ' + (layout.probe.index + 2) + ' 条（探测序列里的第 ' + layout.probe.index + ' 条）。');
    return;
  }

  const state = { backup: null, action: null, parked: null, configFile: null, configBackup: null };
  const rollback = () => {
    try {
      if (inspectInstalled(dest).kind !== 'absent') {
        if (inspectInstalled(dest).kind === 'link') removeLink(dest);
        else rmSync(dest, { recursive: true, force: true });
      }
      if (state.parked) {
        renameSync(state.parked, dest);
        state.parked = null;
      }
      if (state.backup) copyFileSync(state.backup, layout.packageJson);
      if (state.configBackup && state.configFile) copyFileSync(state.configBackup, state.configFile);
    } catch (error) {
      bad('回滚时又出错', String(error && error.message ? error.message : error));
      info('手动还原：copy "' + state.backup + '" "' + layout.packageJson + '"');
    }
  };

  // 2. 备份
  let backup;
  try {
    backup = backupPackageJson(layout);
  } catch (error) {
    die('备份 package.json 失败（没继续装）：' + String(error && error.message ? error.message : error));
  }
  state.backup = backup;
  const backups = listInstallBackups(layout.extensionsDir);
  ok('备份 package.json', basename(backup) + '（' + statSync(backup).size + ' B，逐字节一致）');
  if (backups.length > 5) info('install 备份已有 ' + backups.length + ' 份，旧的可以删：' + backups.slice(5).map((p) => basename(p)).join(' '));

  // 3. 装进 node_modules
  try {
    mkdirSync(layout.nodeModules, { recursive: true });
    const placed = placePackage(PKG_DIR, dest, mode);
    state.action = placed.action;
    state.parked = placed.parked ?? null;
    for (const note of placed.notes) info(note);
    if (placed.action === 'reuse') ok('node_modules 里那份', '复用已有链接 → ' + PKG_DIR);
    else if (placed.action === 'copy') ok('node_modules 里那份', '复制 → ' + dest);
    else ok('node_modules 里那份', '软链（junction）→ ' + PKG_DIR);
  } catch (error) {
    bad('装进 node_modules 失败', String(error && error.message ? error.message : error));
    rollback();
    out('');
    out('已回滚：package.json 还原自 ' + basename(state.backup));
    process.exit(1);
  }
  // 4. 依赖行
  try {
    const original = readFileSync(layout.packageJson, 'utf8');
    const manifest = JSON.parse(original);
    const canonical = manifestText(manifest);
    if (canonical !== original) info('原 package.json 格式不标准（重写后会规范化）；原文在 ' + basename(backup));
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: spec };
    writeTextAtomic(layout.packageJson, manifestText(manifest));
    ok('依赖行', '"' + name + '": "' + spec + '"');
  } catch (error) {
    bad('写依赖行失败', String(error && error.message ? error.message : error));
    rollback();
    out('');
    out('已回滚：package.json 还原自 ' + basename(state.backup));
    process.exit(1);
  }

  // 5. 部署配置：先备份，再打开 worlds.<id>.enabled
  if (enable) {
    state.configFile = configTarget.file;
    try {
      state.configBackup = backupFile(state.configFile, 'config.json');
      const result = enableWorldSection(state.configFile, { worldId: ident.id, defaults: ident.defaults, sources: DEFAULT_SOURCES });
      if (result.untouched) {
        ok('部署配置', basename(state.configFile) + ' 里 worlds.' + ident.id + ' 已是 enabled=true 且不缺键，没改它');
      } else {
        const parts = [];
        if (result.added.length > 0) parts.push('新增 ' + result.added.join(','));
        if (result.changed.length > 0) parts.push('改 ' + result.changed.join(','));
        if (result.replaced) parts.push('原段不是对象，按默认段重写');
        ok('部署配置', '备份 ' + basename(state.configBackup) + ' · worlds.' + ident.id + '：' + parts.join('；'));
        if (result.added.includes('sources') || result.added.length > 3) info('sources = ' + DEFAULT_SOURCES + '（选它的理由见 scripts/install.mjs 的 DEFAULT_SOURCES 注释与 docs/ACCEPTANCE.md）');
      }
    } catch (error) {
      bad('写部署配置失败', String(error && error.message ? error.message : error));
      rollback();
      out('');
      out('已回滚：package.json 与 config.json 都还原了，node_modules/' + name + ' 已清掉。');
      process.exit(1);
    }
  } else {
    info('部署配置', '按 --no-enable 跳过：重启后框架不会挂载 worlds.' + ident.id);
  }

  // 6. 逐项校验
  out('');
  out('逐项校验：');
  const checks = [];
  const check = (label, pass, detail = '') => {
    checks.push(pass);
    if (pass) ok(label, detail);
    else bad(label, detail);
  };
  const installed = inspectInstalled(dest);
  check('node_modules/' + name + ' 在位', installed.kind !== 'absent', installed.kind === 'link' ? '链接 → ' + (installed.target ?? '?') : installed.kind);
  let installedPkg = null;
  try {
    installedPkg = readJsonFile(join(dest, 'package.json'));
    check('装好的 package.json 可解析', true, installedPkg.name + '@' + installedPkg.version);
  } catch (error) {
    check('装好的 package.json 可解析', false, String(error && error.message ? error.message : error));
  }
  check('版本与本目录一致', Boolean(installedPkg) && installedPkg.version === localVersion, localVersion);
  const installedEntry = installedPkg ? resolveEntry(dest, installedPkg) : join(dest, entryRel);
  check('入口文件在装好的副本里', existsSync(installedEntry), entryRel);
  const describeRel = String((pkg.cortico && pkg.cortico.describe) || 'describe.json');
  check('describe.json 在装好的副本里且能解析', existsSync(join(dest, describeRel)) && parses(join(dest, describeRel)), describeRel);
  const iconRel = pkg.cortico && pkg.cortico.icon ? String(pkg.cortico.icon) : '';
  check('图标在装好的副本里', iconRel === '' || existsSync(join(dest, iconRel)), iconRel || '(未声明)');
  let depOk = false;
  let depDetail = '';
  try {
    const manifest = readJsonFile(layout.packageJson);
    const got = manifest.dependencies && manifest.dependencies[name];
    depOk = got === spec;
    depDetail = got === undefined ? '依赖表里没有这一行' : '"' + got + '"';
  } catch (error) {
    depDetail = 'package.json 读不回来：' + String(error && error.message ? error.message : error);
  }
  check('data/extensions/package.json 里有这一行且指向本目录', depOk, depDetail);
  let enabledOk = true;
  let enabledDetail = '按 --no-enable 跳过';
  if (enable && state.configFile) {
    try {
      enabledOk = worldEnabled(state.configFile, ident.id);
      enabledDetail = enabledOk ? 'worlds.' + ident.id + '.enabled = true' : 'worlds.' + ident.id + '.enabled 不是 true';
    } catch (error) {
      enabledOk = false;
      enabledDetail = 'config.json 读不回来：' + String(error && error.message ? error.message : error);
    }
  }
  check('config.json 里 worlds.' + ident.id + '.enabled 是 true', enabledOk, enabledDetail);
  const smoke = smokeImport(installedEntry, layout.extensionsDir);
  if (!smoke.ok && smoke.code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    // 复制模式下裸 node 必然拒绝：Node 不给 node_modules 里的 .ts 剥类型。这不是包的问题——
    // 官方装着的那份 cortico-world-fatfish 也是 node_modules 里的 src/index.ts，靠 Core 的 tsx 加载。
    check('入口能被加载（裸 node 这一项在复制模式下跳过）', true, '复制到 node_modules 后裸 node 不给 .ts 剥类型（Node 限制）；Core 里靠 tsx，与已装的 fatfish 同路');
    info('想自己验证加载：用软链模式（默认，node_modules 里是指向本目录的链接，裸 node 能直接 import）');
  } else {
    check('裸 node 从部署目录 import 得动（isWorldDefinition 四样齐全）', smoke.ok, smoke.ok ? 'world id = ' + smoke.id : smoke.detail);
  }
  check('卸载脚本在（回滚有路）', existsSync(join(PKG_DIR, 'scripts', 'uninstall.mjs')), 'scripts/uninstall.mjs');

  const passed = checks.filter(Boolean).length;
  out('');
  if (passed === checks.length) {
    out('装好了：' + passed + '/' + checks.length + ' 项通过。');
  } else {
    out('校验没过：' + passed + '/' + checks.length + '。');
    if (!flags.has('keep-on-fail')) {
      rollback();
      out('已回滚：package.json 还原自 ' + basename(state.backup) + '，node_modules/' + name + ' 已清掉。');
      out('（想留着现场排查再跑一次加 --keep-on-fail；回滚前的那份在 ' + basename(backup) + '）');
    } else {
      out('按 --keep-on-fail 留了现场。手动回滚：node scripts/uninstall.mjs --data "' + layout.root + '"');
    }
    process.exit(1);
  }

  out('');
  out('下一步：重启 Coopanion 才生效（ESM 模块缓存，改源码也要重启一次）');
  out('  控制台 → 重启；或写 ' + layout.restartFlag + '（Electron 见 Core 子进程退出会自动拉起）');
  out('  重启后在控制台 → 扩展 里应该看到 ' + name + ' ' + localVersion + '，World 页出现「' + (pkg.cortico.displayName || name) + '」');
  if (enable) out('  部署配置已打开：' + basename(state.configFile) + ' 的 worlds.' + ident.id + '.enabled = true（备份 ' + basename(state.configBackup) + '）');
  out('  验收清单：docs/ACCEPTANCE.md');
  out('回滚：node scripts/uninstall.mjs --data "' + layout.root + '"');
}

/** 文件在且是合法 JSON。 */
function parses(file) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write('install: 装的时候自己出错了：' + String(error && error.message ? error.message : error) + '\n');
    process.exit(2);
  });
}
