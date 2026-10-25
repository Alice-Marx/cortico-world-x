# cortico-world-x · X 时间线

给 Coopanion 的 Cortico World 扩展：**大肥鱼按配置看 X**，读到的每条落进本地知识库，
摘要进对话，必要时导出成记忆包。

只读。不新建账号、不点赞、不转发、不关注、不私信。零第三方依赖，只用 Node 内建模块。

## 当前状态

已在 Coopanion 上**跑通**（0.1.x），不是骨架：

- **7 个工具**直接可用：`x_look`（现在去看）、`x_read`（读单条）、`x_recall`（查知识库）、
  `x_sync_now`（按配置整轮扫）、`x_watch`（加/删源）、`x_status`（状态）、`x_export`（导出记忆包）。
  模型怎么用它们写在 `src/ENV_PROMPT.md`（会进系统前缀）。
- 浏览器引擎（`src/cdp`，裸 WebSocket 的 CDP）、站点适配（`src/x`）、知识库（`src/learn`）都是完整实现。
- **实测**：本机读到 17 条真实帖子并落库，第二轮扫描 `added=0`（去重生效）；真 Chrome 冒烟 31 项；
  `node --test` 189 条。逐条断言见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。

### 一件你需要知道的真事

真 x.com 现在**没有 `data-testid` 了**（换成了新前端，属性是 `data-slot` / `data-engagement-action` 这类）。
所以正文抽取以「结构通道」为主、老的 testid 通道做兜底；解析不出正文时会**明确报「页面改版」**，
而不是安静返回 0 条。`tests/fixtures/x-real-profile-2026-10.html` 是从真实页面抓下来的 markup，
用来保证 X 下一次改版能被发现而不是被忽略。

## 安装

装进 `<Coopanion 部署目录>/data/extensions`，装本地源码目录＝link，不发布 npm。

1. 控制台 → 扩展 → 选本机目录 → 选这个包目录；或者
2. `cd <部署目录>/data/extensions && corepack pnpm add <这个包的绝对路径>`

装完**必须重启 Core 进程**才生效（ESM 模块缓存）：

- 控制台 → 重启；或写 `<部署目录>/data/.restart-request`。
- Electron 侧看到 Core 子进程退出会自动拉起。

改了这个包的任何源码，也要重启一次。

## 前置条件

需要一个 Chromium 系浏览器。两种模式：

- **own（默认）**：本 World 自己拉起一个专属 Chrome，独立 profile，不动你日常那个。
  `worlds.x-feed.chromePath` 留空则自动探测 Chrome / Edge（含用户级安装）。
  代价：**登录态不共享**——要在那个 profile 里登一次 X 才读得到登录后的时间线。
- **attach**：连你已经开好远程调试口的浏览器，登录态共享。要先这样启动日常浏览器：

  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223
  ```

  端口要和 `worlds.x-feed.port` 一致，否则激活时会被拒绝。

## 配置

都在 `config.json` 的 `worlds.x-feed` 段，控制台的 World 页会生成表单。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 装配层按它决定挂不挂载。默认必须能构造，false 也会创建实例。 |
| `mode` | `own` | `own` / `attach`，见上。改完要重启。 |
| `port` | `9223` | own 用它开调试口，attach 拿它探测。别和日常浏览器的 9222 撞。改完要重启。 |
| `chromePath` | 空 | 空＝自动探测 Chrome / Edge。own 模式必须能找到真在的文件。改完要重启。 |
| `sources` | `home` | 多行，每行一个源。见下。热改即生效。 |
| `intervalMinutes` | `120` | 自动扫描间隔，`0`＝不自动，只由工具触发。 |
| `limitPerSource` | `20` | 每次每源最多取几条。 |
| `maxScrolls` | `3` | 翻屏次数，`0`＝只看首屏。 |
| `vaultSubdir` | `x-feed` | 知识库落在部署数据目录下的这个子目录。改完要重启。 |
| `deliverDigest` | `true` | 有新内容时摘要是否投进对话（origin external，会花 token）。 |
| `digestMaxChars` | `1200` | 一条摘要的字数上限。 |

### 源怎么写

每行一个，空行忽略，六种之一：

```
# 以 # 开头的是注释，空行也会被跳过
home
user:elonmusk
user:@elonmusk
search:AI agents
list:1234567890
hashtag:rustlang
post:https://x.com/handle/status/1234567890123456789
```

语法以 `src/x` 的 `parseSource` 为准（本包不维护第二份）：handle 可以带 `@`，也可以直接写裸
`@handle` 或一个帖子 URL 作为简写，种类不区分大小写。

激活时会被检查：全空（或只有注释）不算，种类不认识、或种类后面没有值，都会直接拒绝激活，
报错里带出**是哪一行**、以及为什么读不懂。

## 它会推出的事件

| 事件 | 何时 | origin |
|---|---|---|
| `x-feed.ready` | 浏览器连上了 | internal |
| `x-feed.down` | 启动时连不上（`start()` 绝不抛错） | internal |
| `x-feed.scanned` | 一轮扫描完成（只落库，不投递） | internal |
| `x-feed.posts` | 有新内容的摘要（trigger=debounce） | external |

只声明不推、或推了没声明，框架都不会拦：前者记日志并在 World 页标出，后者照常生效。

## 标签与注入面（透明记录）

扩展市场给本包挂过 `injection-risk`（警示/红色）。这个标记**成立过**，值得写清楚：

- **0.1.1 及更早**：`XError.message` 会携带 X 页面原文，而 `markDown()` 把它拼进了 `x-feed.down`
  ——一个 `origin: 'internal'` 的事件。也就是说，第三方写的字以"内部通知"的形态进了对话。
- **0.1.2 起已堵**：页面原文移入 `XError.detail`（只进日志，事件与回执都不渲染）；
  `x-feed.down` 只用固定分类白名单 `downReason()`；`x-feed.scanned` 只说源种类与计数。
  第三方正文只走 `origin: 'external'` 的 `x-feed.posts` 这一条通道。
- 回归测试用 canary 钉死：`tests/world.events.test.ts`（页面原文一旦出现在任一 internal 事件里即失败）
  与 `tests/x.injection.test.ts`（十处 XError 构造点的 message 都不许借页面文本）。
- 市场侧的粘住名单需官方撤销：见 [Pal-AI-Lab/cortico-extensions#274](https://github.com/Pal-AI-Lab/cortico-extensions/issues/274)。

## 已知限制

- **引用推不单独抽**：嵌套在别人帖子里的 quote 正文会被忽略（顶层正文仍在）。
- **日期是原样文案**（`10月21日`、`45分钟`），不可排序；排序用入库时间 `learnedAt`。
- **attach 模式可能被节流**：用你日常浏览器时标签页在后台，X 可能不渲染。回执会提示改 `own`
  模式，或把那个标签页切到前台再叫它。
- **长期记忆要 `cortico-bot-memory`**：没装/没启用时，`x_export` 只产出记忆包文件，
  沉淀那一步需要你手动导入。`x_feed` 本身的知识库不受影响。

## 排错

日志在 `<部署目录>/data/logs/core.log`（超过 5MB 转 `core.old.log`），World 的 `host.log.*`、
未声明的工具名与事件 type 的 warn 都在里面。同一份日志也有 Core 子进程的 stdout/stderr。

- **激活失败**：控制台会原样显示 `preflight` 抛出的那句话。它只会说三件事——模式叫什么、
  端口通不通、源是不是空的/读不懂，以及 own 模式找不找得到浏览器。按那句话改配置再点一次。
  attach 模式那一下会**同步**探一下端口（派个子进程连一下再退出），最长 2 秒；它只在点激活时发生，
  不在启动路径上，超时的探测子进程会被强制结束并回收。
- **装上但 World 页没有它**：扩展日志里会写导入失败或形状不符的原因
  （`isWorldDefinition` 要 id / label / defaults() / create() 四样）。
- **工具回报失败**会分 5 类：连不上浏览器 / 浏览器没连上 / 命令没回话 /
  页面没打开 / 浏览器报错。前两类才是"浏览器坏了"，后三类说明连接是通的。
- **读完状态会不会丢**：游标与知识库都落在数据目录（不是内存），重启后仍在。
  但本 World 的定时器是进程内 `setInterval`，重启后由 `start()` 重新挂。

## 自检（不需要任何第三方工具链）

```
npm test                            # 等于 node --test：递归发现 tests/ 下所有 *.test.ts
node --test tests/manifest.test.ts  # 只跑契约形状那一条
node -e "import('./src/index.ts')"  # 冒烟加载：裸 node 就能 import，说明运行时没有框架依赖
```

Node 直接跑 `.ts`（类型剥离），不需要 tsc / tsx / vitest。`tsconfig.json` 只给 IDE 用。

**注意 `node --test tests/` 跑不了**：Node 24 把位置参数里的裸目录当成单个入口模块去解析，
报 `Cannot find module ...\tests`。要限定范围就写 glob（`node --test "tests/*.test.ts"`，
cmd 与 bash 都一样，因为展开由 Node 自己做）；不写参数的 `node --test` 会递归扫，子目录里的
用例也不会漏，所以 `npm test` 用的是它。

## 目录

```
package.json        包清单：type=module、main=./src/index.ts、cortico{kind:world,api:6,…}
describe.json       tools / events / prompts 的自描述，市场只读它、不执行代码
src/index.ts        包入口，只 export default 定义
src/definition.ts   id / label / defaults() / preflight() / create() / describe
src/config.ts       默认值、源解析、ConfigGroup（owner world:x-feed，键 worlds.x-feed.*）
src/i18n.ts         中英文案 + 中文的 preflight 文案与进模型前缀的固定句子
src/world.ts        World 实例：生命周期、三段扫描节奏、登录窗口、事件投递、本地覆盖
src/tools/          7 个工具与失败回执（5 类失败互不冒充）
src/ENV_PROMPT.md   进系统前缀的环境说明：源、第三方内容不可当指令、5 类失败、先查库
assets/icon.svg     图标
tests/              node --test 用例
```

## 许可

MIT，全文见 `LICENSE`；许可分层（本包 / 参照的上游 / 测试夹具来源）与商标说明见 `NOTICE`。
参照了 cortico-world-browser（MIT, Copyright (c) 2026 Phantivia）的做法，未复制其代码。
X 与 Twitter 是 X Corp. 的商标；本包不是 X Corp. 的产品。
