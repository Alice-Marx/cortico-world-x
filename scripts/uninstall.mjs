#!/usr/bin/env node
/**
 * scripts/uninstall.mjs —— install.mjs 的反向操作，三件事：
 *   还原 data/extensions/package.json → 删掉 node_modules 里那份 → 关掉部署配置里的 worlds.<id>
 *
 * package.json 的还原源是 install 留下的最近一次「不含本包」的备份 package.json.bak-xfeed-<时间戳>；
 * 备份不在（别人手工装过）就退一步：只删依赖表里那一行。
 *
 * config.json 默认**只删 worlds.<id> 这一段**，不从备份整份还原：装完之后你很可能在控制台改过
 * 别的 world、别的开关，整份还原会把那些改动一起抹掉。想要彻底回到装之前，用 --restore-config。
 *
 * 动任何一个文件之前都先存副本（package.json / config.json 各一份 pre-uninstall-xfeed-<时间戳>），
 * 所以「卸载」本身也能再退回去 —— 卸载不是不可逆的那一步。
 *
 *   node scripts/uninstall.mjs                  # 卸本机默认部署
 *   node scripts/uninstall.mjs --data <部署根>   # 卸别的部署（也认 CORTICO_COMPANION_DATA）
 *   node scripts/uninstall.mjs --dry-run        # 只打印，不动文件
 *   node scripts/uninstall.mjs --purge-backups  # 顺手清掉 install 挪开的旧副本 node_modules/<包名>.bak-xfeed-*
 *   node scripts/uninstall.mjs --restore-config # config.json 也整份还原（默认只删 worlds.<id>）
 *   node scripts/uninstall.mjs --no-config      # 不碰部署配置
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DATA_ENV,
  PKG_DIR,
  backupFile,
  backupPathFor,
  disableWorldSection,
  inspectInstalled,
  listBackups,
  listInstallBackups,
  manifestText,
  missingDeploymentLines,
  parseArgv,
  pickLayout,
  readJsonFile,
  removeInstalled,
  resolveBotConfig,
  worldIdentity,
  writeTextAtomic,
} from './install.mjs';

/** 这份备份的 dependencies 里有没有本包。读不了当「没有」，让还原挑到它。 */
function hasDependency(file, name) {
  try {
    const manifest = readJsonFile(file);
    return Boolean(manifest.dependencies && manifest.dependencies[name] !== undefined);
  } catch {
    return false;
  }
}

const out = (line = '') => process.stdout.write(line + '\n');
const ok = (label, detail = '') => out('  [ok] ' + label + (detail ? '  ' + detail : ''));
const bad = (label, detail = '') => out('  [!!] ' + label + (detail ? '  ' + detail : ''));
const info = (label, detail = '') => out('  [--] ' + label + (detail ? '  ' + detail : ''));

function usage() {
  out('用法：node scripts/uninstall.mjs [选项]');
  out('');
  out('  --data <路径>   部署根（含 data\\extensions 的那一层）或 data 目录本身；' + DATA_ENV + ' 同义');
  out('  --dry-run       只打印要做什么，不动任何文件');
  out('  --purge-backups 顺手删掉 install 挪开的旧副本（node_modules/<包名>.bak-xfeed-*）');
  out('  --restore-config config.json 整份还原（默认只删 worlds.<id> 那一段）');
  out('  --no-config     不碰部署配置');
  out('  --config <文件> 部署配置 config.json 的位置（默认 <data>\\home\\<bot>\\config.json）');
  out('  --strict        本来就没装时按失败退出（默认 0）');
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
  const layout = pickLayout(opts);
  if (!layout.found) {
    for (const line of missingDeploymentLines(layout)) process.stderr.write(line + '\n');
    process.exit(2);
  }
  const ident = await worldIdentity();
  const touchConfig = !flags.has('no-config');
  const restoreConfigWhole = flags.has('restore-config');
  const configTarget = touchConfig ? resolveBotConfig(layout, opts.config) : null;
  const configFile = configTarget && configTarget.file && existsSync(configTarget.file) ? configTarget.file : null;

  let name;
  try {
    name = readJsonFile(join(PKG_DIR, 'package.json')).name;
  } catch (error) {
    process.stderr.write('uninstall: 读不了本包的 package.json：' + String(error && error.message ? error.message : error) + '\n');
    process.exit(2);
  }
  const dest = join(layout.nodeModules, ...name.split('/'));

  out(name + ' ← 从扩展目录卸下');
  out('');
  info('扩展目录 ' + layout.extensionsDir);
  info('包名     ' + name);
  info('世界 id  ' + ident.id);
  info('部署配置 ' + (touchConfig ? (configFile ?? '找不到（用 --config 指过去，或 --no-config 跳过）') : '按 --no-config 跳过'));
  if (dryRun) info('模式     dry-run：不会写任何文件');
  out('');

  if (!existsSync(layout.extensionsDir)) {
    process.stderr.write('uninstall: 找不到扩展目录 ' + layout.extensionsDir + '（--data 指的路径里没有 data\\extensions 或 extensions）。\n');
    process.exit(2);
  }

  const manifestFile = layout.packageJson;
  let manifest = null;
  if (existsSync(manifestFile)) {
    try {
      manifest = readJsonFile(manifestFile);
    } catch (error) {
      process.stderr.write('uninstall: ' + manifestFile + ' 不是合法 JSON：' + String(error && error.message ? error.message : error) + '\n');
      process.exit(2);
    }
  }
  const dep = manifest && manifest.dependencies ? manifest.dependencies[name] : undefined;
  const installed = inspectInstalled(dest);
  if (dep === undefined && installed.kind === 'absent') {
    out('本来就没装：依赖表里没有 ' + name + '，node_modules 里也没有它。');
    out('（要装：node scripts/install.mjs --data "' + layout.root + '"）');
    process.exit(flags.has('strict') ? 1 : 0);
  }

  // 1. 先给自己留一份还原点（两个文件各一份）
  const safety = existsSync(manifestFile) ? backupPathFor(manifestFile, 'package.json', 'pre-uninstall-xfeed') : null;
  const configSafety = configFile ? backupPathFor(configFile, 'config.json', 'pre-uninstall-xfeed') : null;
  const configBackups = configFile ? listBackups(dirname(configFile), 'config.json') : [];

  // 还原点要挑「最近一次不含本包的」：连装两次时，最新的那份备份里已经带着本包的依赖行了。
  const backups = listInstallBackups(layout.extensionsDir);
  const restoreFrom = backups.find((file) => !hasDependency(file, name)) ?? backups[0] ?? null;
  info('还原点   ' + (restoreFrom ? basename(restoreFrom) + '（最近一次 install 备份）' : '没有 install 备份，改成只删依赖表里那一行'));

  if (dryRun) {
    out('');
    out('dry-run 计划：');
    if (safety) info('存还原点 ' + basename(safety));
    if (configSafety) info('存还原点 ' + basename(configSafety));
    info(restoreFrom ? '还原     ' + basename(restoreFrom) + ' → package.json' : '删依赖行 "' + name + '"');
    if (installed.kind !== 'absent') info('删         ' + dest + '（' + installed.kind + '）');
    if (configFile) {
      if (restoreConfigWhole) info('配置     ' + (configBackups[0] ? '整份还原 ← ' + basename(configBackups[0]) : '没有 config.json 备份，只能删段'));
      else info('配置     只删 worlds.' + ident.id + '（别人的段不动）');
    }
    return;
  }

  // 2. 存还原点
  if (safety) {
    const written = backupFile(manifestFile, 'package.json', 'pre-uninstall-xfeed');
    ok('存还原点', basename(written) + '（' + statSync(written).size + ' B，逐字节一致）');
  }
  if (configSafety) {
    const written = backupFile(configFile, 'config.json', 'pre-uninstall-xfeed');
    ok('存还原点', basename(written) + '（config.json，' + statSync(written).size + ' B）');
  }

  // 3. 还原 package.json
  let restored = null;
  if (restoreFrom) {
    copyFileSync(restoreFrom, manifestFile);
    try {
      restored = readJsonFile(manifestFile);
    } catch (error) {
      bad('还原后的 package.json 不是合法 JSON', String(error && error.message ? error.message : error));
      info('手动还原：copy "' + safety + '" "' + manifestFile + '"');
      process.exit(1);
    }
    ok('还原 package.json', '← ' + basename(restoreFrom));
  }
  // 备份里如果本来就有这一行（装了两遍），就地再删一次，让终态确定。
  if (!restored && manifest) restored = manifest;
  if (restored && restored.dependencies && restored.dependencies[name] !== undefined) {
    const copy = { ...restored, dependencies: { ...restored.dependencies } };
    delete copy.dependencies[name];
    writeTextAtomic(manifestFile, manifestText(copy));
    restored = copy;
    if (restoreFrom) info('备份里也带着这一行，已按终态再删一次');
    else ok('删依赖行', '"' + name + '"');
  }
  if (restored && restored.dependencies && Object.keys(restored.dependencies).length === 0) info('依赖表现在是空的（原本就这样？）');

  // 4. 删 node_modules 里那份
  try {
    const gone = removeInstalled(dest, name);
    if (gone.removed) ok('删 node_modules/' + name, gone.how === 'link' ? '只删链接，源目录没动' : '删掉了那份复制');
    else ok('删 node_modules/' + name, '本来就不在');
  } catch (error) {
    bad('删 node_modules/' + name + ' 失败', String(error && error.message ? error.message : error));
    info('package.json 已经还原了；这一份可以手工删：' + dest);
    process.exit(1);
  }

  // 5. 顺手清 install 挪开的旧副本
  const leftovers = existsSync(layout.nodeModules)
    ? readdirSync(layout.nodeModules).filter((n) => n.startsWith(name + '.bak-xfeed-'))
    : [];
  if (leftovers.length > 0) {
    if (flags.has('purge-backups')) {
      for (const name2 of leftovers) rmSync(join(layout.nodeModules, name2), { recursive: true, force: true });
      ok('清掉旧副本', leftovers.join(' '));
    } else {
      info('install 挪开的旧副本还在（要清加 --purge-backups）：' + leftovers.join(' '));
    }
  }

  // 6. 部署配置：默认只删 worlds.<id>，别人的段一个键都不动
  if (!touchConfig) info('部署配置', '按 --no-config 跳过');
  else if (!configFile) info('部署配置', '找不到 config.json，没动它（要动就 --config 指过去）');
  else {
    try {
      if (restoreConfigWhole && configBackups.length > 0) {
        copyFileSync(configBackups[0], configFile);
        ok('还原 config.json', '← ' + basename(configBackups[0]) + '（整份还原，别人的段也回到那次状态）');
      } else {
        const removed = disableWorldSection(configFile, ident.id);
        if (removed) ok('config.json 删掉 worlds.' + ident.id, '别人的段一个键都没动' + (restoreConfigWhole ? '（没有 config.json 备份可整份还原）' : ''));
        else info('config.json', '本来就没有 worlds.' + ident.id);
      }
    } catch (error) {
      bad('清 worlds.' + ident.id + ' 失败', String(error && error.message ? error.message : error));
      info('config.json 的还原点在 ' + (configSafety ?? '(没存)'));
      process.exit(1);
    }
  }

  // 7. 校验 + 给人自己复核的命令
  out('');
  out('校验：');
  let depGone = false;
  let depDetail = '';
  try {
    const now = readJsonFile(manifestFile);
    const left = now.dependencies ? now.dependencies[name] : undefined;
    depGone = left === undefined;
    depDetail = left === undefined ? '依赖表里没有 ' + name : '还留着 "' + left + '"';
  } catch (error) {
    depDetail = 'package.json 读不回来：' + String(error && error.message ? error.message : error);
  }
  (depGone ? ok : bad)('data/extensions/package.json 不再依赖 ' + name, depDetail);
  const stillThere = inspectInstalled(dest);
  (stillThere.kind === 'absent' ? ok : bad)('node_modules/' + name + ' 已清掉', stillThere.kind);
  let configGone = true;
  if (configFile) {
    try {
      const now = readJsonFile(configFile);
      const left = now.worlds ? now.worlds[ident.id] : undefined;
      configGone = left === undefined;
      (configGone ? ok : bad)('config.json 里没有 worlds.' + ident.id, configGone ? '启用段已删，重启后不会挂载' : '还留着：' + JSON.stringify(left).slice(0, 120));
    } catch (error) {
      configGone = false;
      bad('config.json 读不回来', String(error && error.message ? error.message : error));
    }
  }
  out('');
  out('自己复核（cmd；bash 下 type/dir 换成 cat/ls）：');
  out('  node scripts/selfcheck.mjs --data "' + layout.root + '"      # install 那项应是 ok:false（未安装）');
  out('  type "' + manifestFile + '"');
  out('  dir "' + layout.nodeModules + '"');
  if (configFile) out('  node -e "const c=require(\'' + configFile.split('\\').join('/') + '\'); console.log(Object.keys(c.worlds))"');
  if (safety) out('  后悔药：「' + safety + '」是卸载前那份 package.json。');
  if (configSafety) out('  后悔药：「' + configSafety + '」是卸载前那份 config.json。');
  out('');
  out('重启 Coopanion 后扩展列表里就没有 ' + name + ' 了（本机源码目录原样留着，随时能再装）。');
  process.exit(depGone && stillThere.kind === 'absent' && configGone ? 0 : 1);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write('uninstall: 卸载自己出错了：' + String(error && error.message ? error.message : error) + '\n');
    process.exit(2);
  });
}
