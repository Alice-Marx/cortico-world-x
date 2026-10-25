# 验收手册 · cortico-world-x

给**人工验收**用：按 PLAN 第 8 条的 6 条标准，一条一条说清「怎么做 / 看到什么算过 / 失败看哪里」。
自动化那半（包形状、describe 同源、node --test、装没装、启没启用、日志有没有 ERROR）交给
`scripts/selfcheck.mjs`，它只读、输出一行 JSON、退出码分 PASS/FAIL。

> 本手册里每条「事实」后面都带出处。C = `<部署根>\resources\app\build\cortico\src`（框架源码），
> REPORT = `_research\contract\REPORT.md`。脚本不重启任何进程：重启是验收人这一侧的动作。
>
> 下面出现的 `<部署根>`、`<botDir>`、`<本仓库目录>` 都是占位符，按下表换成你自己的路径；
> 表里给的 `%LOCALAPPDATA%\Programs\Coopanion` 是 Windows 的默认安装位置，也是三个脚本的探测对象。

---

## 一、路径与入口

**先找到「部署根」**——就是 `Coopanion.exe` 所在的那一层（里面应该有 `data\extensions`）。三种找法：

1. 目录习惯：Windows 默认装在 `%LOCALAPPDATA%\Programs\Coopanion`（本机实测环境即此，只是盘符不同）；
   装到程序目录的是 `%ProgramFiles%\Coopanion`；便携版就是解压出来那个文件夹。
2. 应用里看：控制台「关于 / 设置」页或托盘图标右键的菜单里能看到安装路径。
3. 让脚本自己找：三个脚本都按下面的顺序定部署根，命中即停，并把探测过的每条路径打出来；一条都没命中就以**退出码 2** 结束。

   | 顺序 | 来源 |
   |---|---|
   | 1 | `--data <部署根>` |
   | 2 | 环境变量 `CORTICO_COMPANION_DATA` |
   | 3 | `%LOCALAPPDATA%\Programs\Coopanion`（Windows 默认安装位置） |
   | 4 | `%ProgramFiles%\Coopanion` |
   | 5 | `%ProgramFiles(x86)%\Coopanion` |
   | 6 | 便携版：脚本所在盘符根下的 `Coopanion`（非 Windows 是 `~/Coopanion`） |

   看探测结果：`node scripts/install.mjs --dry-run`（不写任何文件，会逐条打印 [命中]/[没有]/[跳过]）。
   只想指定一次而不想每条命令都带参数，就设环境变量：
   cmd `set CORTICO_COMPANION_DATA=<部署根>`，PowerShell `$env:CORTICO_COMPANION_DATA='<部署根>'`。
   **注意**：装在非默认盘（本机实测环境就是装在 D:）时，第 3~6 条都探不到，必须用 `--data` 或这个环境变量。

| 东西 | 路径 | 出处 |
|---|---|---|
| 部署根 | `<部署根>`（例：`%LOCALAPPDATA%\Programs\Coopanion`） | C/extensions.ts:96-101 的 EXTENSIONS_DIR |
| 扩展目录 | `<部署根>\data\extensions` | 含 package.json / pnpm-workspace.yaml / node_modules；REPORT 第 10 条 |
| 控制台 | `http://127.0.0.1:<web.port>`（`<botDir>\config.json` 的 `web.port`；本机实测值是 17788） | 部署的 config.json |
| 部署目录 botDir | `<部署根>\data\home\<bot 目录>`（本机实测是 `home\companion`） | config.json / deployment.json 所在的那一层 |
| World 数据目录 | `<botDir>\data`（`paths.data` 缺省 `data`，相对 botDir 解析） | C/deploy.ts:158-168 + C/core/config.ts:127 |
| 知识库（本 World） | `<botDir>\data\x-feed\`（= `ctx.dataDir`/`vaultSubdir`，默认 `x-feed`） | README「配置」段 vaultSubdir |
| 日志 | `<部署根>\data\logs\core.log`（>5MB 转 core.old.log） | REPORT 第 10 条 |
| 重启旗标 | `<部署根>\data\.restart-request` | C/boot.ts:9,41-43 |

判定口径：**World 挂载 ≠ 激活**。按 `cfg.enabled` 启动时直接 `create()`，**不走 preflight**；
只有操作者点「激活」才走 `preflight`（C/world.ts:395 vs :219-263，REPORT 第 4 条）。
所以「装了 / 激活了 / 通了浏览器」是三件事，下面的验收分别对应。

---

## 二、第 0 步：先跑自动化自检（30 秒，什么都不改）

```
cd <本仓库目录>
node scripts/selfcheck.mjs                 # 一行 JSON 到 stdout，人读摘要在 stderr
node scripts/selfcheck.mjs --pretty        # 想看清结构时
# 部署根不在默认位置时（本机实测环境就是这种：装在 D: 而不是 %LOCALAPPDATA%）：
node scripts/selfcheck.mjs --data "<部署根>"
```

退出码：`0` = PASS，`1` = 有 FAIL，`2` = 用法/部署目录不认（连体检都做不了）。
stderr 那行是人读摘要，长这样（本机实测样例，装好之后）：

```
selfcheck PASS 6/6 · tests 165/165 · 已装 0.1.0 · 日志 ERROR 0
```

**算过**：退出码 0，且 JSON 里 `checks` 六项全 `ok:true`：

| id | 查什么 |
|---|---|
| `package` | `type=module`、`cortico{kind:world,api:6,displayName,icon,describe,tags,locales}` 形状，入口文件在 |
| `describe` | `describe.json` 与 `src` **同源**：从默认导出重算 tools/events/prompts 再逐字段深比，且 `tools()` 的工具名都在声明里 |
| `tests` | `node --test` 的 `# pass / # fail` 摘要 |
| `install` | 扩展目录里装着本包、**版本一致**、装的那份就是本目录（`link` 指别处会进 `warns`） |
| `config` | 部署 `config.json` 里 `worlds.x-feed.enabled` 是 **true**（装了不等于启用），`sources` 每一行都能被解析、`port` 合法 |
| `log` | `core.log` 最近 50 行里有没有 **x-feed 的 ERROR**（WARN 只记 `warns`，不算失败） |

**失败看哪里**：`fails` 数组里每条都是 `<能修的动作> + <证据>`；`data` 里带原始摘要
（`data.tests.failed` 是被判失败的用例名，`data.install.mode` 是 `link`/`copy`/`absent`，
`data.config.enabled`/`data.config.sources` 是部署配置的实读值，`data.log.samples` 是命中的日志行）。

---

## 三、安装与回滚（第 2 条的前置）

装包是**三件事**，缺一件验收就卡住：① 依赖表里有一行 + node_modules 里有一份（装上了）
② `config.json` 里 `worlds.x-feed.enabled = true`（启用了）③ 重启 Core（生效）+ 点激活（过 preflight）。

```
node scripts/install.mjs                     # 软链进 node_modules + 依赖表加一行 file: + 打开 worlds.x-feed.enabled
node scripts/install.mjs --copy              # 复制一份（源码目录不能动时用）
node scripts/install.mjs --dry-run           # 只打印计划，一个字节都不写
node scripts/install.mjs --no-enable         # 只装包，不碰 config.json（重启后不会挂载）
node scripts/install.mjs --config <路径>      # config.json 不在默认位置时指过去

node scripts/uninstall.mjs                   # 还原 package.json + 删 node_modules 里那份 + 删 worlds.x-feed 段
node scripts/uninstall.mjs --purge-backups   # 顺手清掉 install 挪开的旧副本
node scripts/uninstall.mjs --restore-config  # config.json 也整份还原（默认只删本 World 那一段）
node scripts/uninstall.mjs --no-config       # 不碰部署配置
```

**装法为什么不是 `pnpm add`**：框架只读 `data/extensions/package.json` 的 dependencies（C/extensions.ts:110-113），
再去 `<extensions>/node_modules/<包名>/` 找包（:266-268）—— 依赖表有这一行 + node_modules 有这一份 = 装上了。
`pnpm add` / `pnpm install` 会改 lockfile、走网络、按它自己的规则重写 node_modules；
装完再跑一次 `selfcheck`，`data.install.mode` 与 `sameSource` 会告诉你现在到底是链接还是副本。

**为什么要写 `config.json`**：装配层按 `cfg.worlds.<id>.enabled` 决定挂不挂载（C/world.ts:219-263）。
只装包不启用，重启后 World 页根本不会出现这个 World。install 的规矩：

- 段不存在 → 写一份默认段 + `enabled: true`；
- 段已存在 → 只补**缺的键**与 `enabled`，你改过的值一个都不覆盖；`worlds` 里别人的段一个键都不碰；
- 写之前先备份 `config.json.bak-xfeed-<时间戳>`（就在 config.json 旁边），写完打印「新增了哪几个键」。
- Core 跑着的时候写也安全：框架自己改配置是「读文件→打补丁→写回」（C/world.ts:475-483 的 `updateJsonObject`），
  不拿内存里的整份快照覆盖磁盘，所以不会把我们写的那一段吞掉。**但挂载要看启动时的配置，所以仍然必须重启。**

**默认源为什么是 `user:elonmusk` 而不是 `home`**：两者在未登录时都撞登录墙（回执归「页面没打开」），
但 `home` 还多一种失败——账号已登录而首页推荐流是空的，那会得到空页（`XError 'empty'`），看起来像解析坏了。
公开主页是固定目标，登录着就必然有内容；验收只要 1 条真内容，确定性比个性化重要。
想改就改 `worlds.x-feed.sources`（或让模型调 `x_watch`），或改 `scripts/install.mjs` 里的 `DEFAULT_SOURCES`。

**uninstall 为什么默认「只删那一段」而不是整份还原**：装完之后你很可能在控制台改过别的 World、别的开关；
整份还原会把这些改动一起抹掉。所以默认只删 `worlds.x-feed`，要彻底回到装之前才用 `--restore-config`。

**算过**：install 打印 `10/10 项通过`，收尾是「下一步：重启 Coopanion…」与回滚命令；`uninstall` 之后
`data/extensions/package.json` **与 `config.json` 都与装之前逐字节一致**（脚本自比备份的 sha256；本机实测两次往返都是 identical）。

---

## 四、六条验收标准

### 1. `node --test` 全绿

- **怎么做**：`node --test`（= `npm test`）；只想跑契约形状那几条用 `node --test "tests/*.test.ts"`。
  注意 `node --test tests/` 会被 Node 24 当成单个入口模块（README「自检」段已有这条坑）。
- **算过**：`# tests / # pass / # fail 0`，退出码 0。等价自动化口径：`selfcheck` 的 `tests` 项 `ok:true`。
- **失败看哪里**：TAP 里 `not ok N - <用例名>` 的 `location:` 就是文件行号；`data.tests.failed` 是同一份名单。

### 2. 包能在控制台装入并启用，时间线出现 `x-feed.ready`

- **怎么做**：`node scripts/install.mjs`（它顺手把 `worlds.x-feed.enabled` 写成 true；手改也行：`<botDir>\config.json` 的 `worlds.x-feed.enabled`）→ **重启 Core**（控制台按钮，或写 `data\.restart-request`；
  ESM 模块缓存，不重启装多少遍都是旧代码，REPORT 第 10 条）→ 控制台 → 扩展页确认列表里有 `cortico-world-x 0.1.0`
  → World 页点「激活」。
  可脚本化复核（控制台在跑的时候；下面的 17788 是本机实测端口，换成你 `<botDir>\config.json` 里的 `web.port`）：
  ```
  node -e "fetch('http://127.0.0.1:17788/api/extensions').then(r=>r.json()).then(d=>console.log(d.extensions.filter(e=>/x/.test(e.name)).map(e=>({name:e.name,version:e.version,kind:e.kind,loaded:e.loaded,worldId:e.worldId,reason:e.reason}))))"
  node -e "fetch('http://127.0.0.1:17788/api/worlds').then(r=>r.json()).then(d=>console.log(d.worlds.map(w=>w.id)))"
  ```
- **算过**：三条同时成立——(a) `/api/extensions` 里有 `cortico-world-x` 且 `version=0.1.0`、`kind=world`、
  `loaded=true`；(b) `/api/worlds` 里有 `x-feed`；(c) **时间线出现一条 `x-feed.ready`**（origin `internal`）：
  ```
  node -e "fetch('http://127.0.0.1:17788/api/events?limit=200').then(r=>r.json()).then(d=>console.log(d.events.filter(e=>String(e.type).startsWith('x-feed')).map(e=>e.type+' @'+e.ts)))"
  ```
- **失败看哪里**：
  - 扩展页显示但 `loaded=false` → 看 `reason`；对应 `core.log` 里 `扩展导入失败` / `notInNodeModules` / manifest 的 WARN（C/extensions.ts:279,282-289,338-339）。
  - 点了激活弹「激活失败: …」→ 原文来自 `preflight`（C/strings.ts:32），它只说三件事：模式、端口通不通、源空不空/看不看得懂（以及 own 模式找不找得到浏览器）。
  - 激活成功但**没有** `x-feed.ready` → 浏览器没连上，这时应该出现 `x-feed.down`；两者都没有就是事件没推（PLAN 第 6 节）。日志里搜 `x-feed`。

### 3. 用真实浏览器读到至少 1 条真实 X 内容并落进知识库

- **怎么做**：先决定浏览器模式（README「前置条件」）：
  - **attach**（推荐先验这条链路）：自己起日常浏览器 `chrome.exe --remote-debugging-port=9223`，登录态共享，端口与 `worlds.x-feed.port` 一致；
  - **own**：本 World 自己拉起专属 Chrome + 包内 profile，**登录态不共享** —— 必须在那次拉起的窗口里登一次 X，否则永远是登录墙。
  然后让模型调 `x_look`（或 `x_status` 先看连接与库条数），或等一个 `intervalMinutes` 周期。
- **算过**：
  - 工具回执里带**至少 1 条**真实帖子（有作者/正文/时间/URL），不是空数组；
  - 知识库文件**真的多了条目**：`<botDir>\data\x-feed\index.jsonl` 行数增加（一条一行），`notes\` 下出现对应的 md；
    `x_status` 报的「库里条数」与目录里数得出来的一致。
  - 建议记下两个数（验收 6 要用）：`x_status` 的条数、`index.jsonl` 的行数。
  - own 模式的 `<botDir>\data\x-feed\` 下还应该有 `browser-profile\`（专属 profile）与 `login-done`（登过一次的标记，
    `src/world.ts:17`：有它才把浏览器开到屏幕外）。
- **失败看哪里**：
  - 回执属于「页面没打开」或 `x_read` 报登录墙（PLAN 3.2 的 `login-required`）→ 是没登录，不是 CDP 坏了；
    对照 vault 里有没有 `login-done`；
  - 回执属于「连不上浏览器」→ 端口/可执行文件（own）或远程调试没开（attach），看 `worlds.x-feed.port`、`chromePath`；
  - 库没长但回执有条目 → 看 `core.log` 里 learn 的写入错误与目录权限；也可能是 `vaultSubdir` 指到了别处（用 `x_status` 报的路径对账）。

### 4. 摘要事件进对话，且不发垃圾

- **怎么做**：`deliverDigest=true`（默认）+ `intervalMinutes>0`（默认 120），等一轮扫描；或手动 `x_sync_now`。
- **算过**：时间线里 `x-feed.scanned`（只落库、不投递）与 `x-feed.posts`（摘要，trigger `debounce`、origin `external`）
  分工正确；对话里出现**一条**摘要，长度不超过 `digestMaxChars`；同一批内容不会重复投递。
  把上面 `/api/events` 那条命令再跑一次，数 `x-feed.posts` 的条数。
- **失败看哪里**：没有 `x-feed.posts` → `deliverDigest` 关了、这轮没有新内容（`x-feed.scanned` 里 `added=0`），或事件 type 写错（未声明的 type 只 warn 但照常生效，REPORT 第 5 条）；
  话太多 = 每轮都投 → 查 `intervalMinutes`、`digestMaxChars`、以及是否把「无新内容」也当成了有内容。

### 5. 关掉浏览器后工具按 5 类失败之一回报，World 不消失

- **怎么做**：连上之后**把浏览器关掉**（own 模式杀掉那个 Chrome；attach 模式关掉带调试口的那个），
  再让模型调 `x_look` / `x_status` / `x_sync_now`。
- **算过**：
  - 回执落在 **5 类之一**：`连不上浏览器` / `浏览器没连上` / `命令没回话` / `页面没打开` / `浏览器报错`
    （口径见 `src/ENV_PROMPT.md:38-53`；具体回执措辞归 W5 的 i18n）；
  - **World 不消失**：`/api/worlds` 里 `x-feed` 还在、World 页还能开、配置表单还能渲染、
    `/api/extensions` 里 `cortico-world-x` 仍 `loaded=true`；
  - 下一次浏览器起来之后，同一个工具还能用（不需要重启 Core）。
- **失败看哪里**：回执是空白/抛异常而不是五类之一 → 工具没按契约包装错误；
  World 从 `/api/worlds` 消失 → `core.log` 里找未捕获异常（`start()` 抛错会连带挂掉装配，PLAN 第 6 节要求 start 绝不抛错）。

### 6. 重启 Coopanion 后状态（游标 / 知识库）仍在

- **怎么做**：记下验收 3 的两个数（条数、行数）与 `x_status` 报的「上次扫描时刻」→ 重启 Core
  （控制台按钮或 `data\.restart-request`）→ 等 `x-feed.ready` 重新出现 → 再跑 `x_status`。
- **算过**：重启后 `x_status` 的条数与 `index.jsonl` 行数**不少于**重启前；「上次扫描时刻」还是那个旧值（不是空/现在）；
  `<botDir>\data\x-feed\state.json` 在且能解析。定时器是进程内 `setInterval`，重启后由 `start()` 重挂（README「排错」段），
  所以「游标还在」和「下一轮会自动跑」是两件事，分别验。
- **失败看哪里**：条数归零 → 库写到了临时目录/相对路径（拿 `x_status` 报的路径对账）；
  扫描时刻丢了 → `state.json` 没写成或写在 `ctx.dataDir` 之外；重启后没有 `x-feed.ready` → 回到第 2 条的失败分支。

---

## 五、四条硬断言一览（用户点名的）

| # | 断言 | 一条命令 |
|---|---|---|
| A1 | 时间线出现 `x-feed.ready` | `/api/events?limit=200` 过滤 `type` 前缀 `x-feed` |
| A2 | 知识库文件真的多了条目 | `index.jsonl` 行数前后对比 + `x_status` 条数 |
| A3 | 关浏览器后回执属于 5 类之一，且 World 不消失 | 回执文案对上 `src/ENV_PROMPT.md:38-53` 之一；`/api/worlds` 仍含 `x-feed` |
| A4 | 重启后游标与库还在 | 重启前后 `x_status` 条数/上次扫描时刻 + `state.json` |

---

## 六、最容易翻车的 3 个点

1. **装了/改了不重启，等于什么都没干。** 扩展在 Core 子进程里 `import()`（C/extensions.ts:335），ESM 模块缓存不会自己失效；
   `data/extensions` 里再跑一次 `pnpm install` 还会按 pnpm 自己的规则重写 node_modules（`file:` 目录依赖可能变链接也可能变副本），
   之后哪怕重启，验的也可能是另一份代码。**每次验收前先 `node scripts/selfcheck.mjs`，看 `data.install.mode` 与 `sameSource`。**
2. **own 模式没有登录态。** 专属 profile 与日常浏览器互不相干，没在拉起的那个窗口里登过 X 就永远是登录墙；
   这时回执是「页面没打开」或 `login-required`，很像 CDP 坏了，其实是没登录。先用 attach 验通链路，再验 own。
3. **日志里 WARN ≠ 失败，裸 node import 失败 ≠ 装坏了。** 真正让第 2 条挂的是 `扩展导入失败` / `notInNodeModules`
   （C/extensions.ts:279,338）；而 `.ts` 包在 node_modules 里**必然**不能被裸 node 加载
   （Node 拒绝给 node_modules 下的 .ts 剥类型，`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），
   Core 里靠 `--import tsx` 加载 —— 官方装的 `cortico-world-fatfish` 就是 node_modules 里的 `src/index.ts`。
   所以 `--copy` 模式跳过这一项校验是设计如此，不是漏检；要自己验加载就用默认的软链模式。

---

## 七、收尾：卸载与清理

```
node scripts/uninstall.mjs --purge-backups
```

脚本在 `<部署根>\data\extensions`（以及 `<botDir>`）里可能留下这些**它自己的**文件（都可以删，删掉不影响 Coopanion）：

| 文件 | 谁留的 | 作用 |
|---|---|---|
| `data\extensions\package.json.bak-xfeed-<时间戳>` | install | 安装前的依赖表快照，uninstall 的还原点 |
| `data\extensions\package.json.pre-uninstall-xfeed-<时间戳>` | uninstall | 卸载前的快照，卸载自己也能退回去 |
| `<botDir>\config.json.bak-xfeed-<时间戳>` | install | 写 `worlds.x-feed` 之前的配置快照 |
| `<botDir>\config.json.pre-uninstall-xfeed-<时间戳>` | uninstall | 删段之前的配置快照 |
| `data\extensions\node_modules\cortico-world-x.bak-xfeed-<时间戳>` | install（重复装时） | 上一份旧副本，`--purge-backups` 清掉 |

本仓库目录（`<本仓库目录>`）不会被卸载动到。
