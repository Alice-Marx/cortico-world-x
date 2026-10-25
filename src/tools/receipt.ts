/**
 * 工具回执的失败分类：PLAN 第 5 节要求把失败分成 5 类，措辞按 _research/cwb/NOTES.md 第 4 节的
 * 事故教训来（归错类等于让人去修一个没坏的东西）：
 *
 *   ① 连不上浏览器  CdpError('no-browser' | 'no-port')
 *   ② 连上了但没接住 CdpError('not-connected' | 'ws-failed')
 *   ③ 命令没回话    CdpError('timeout' | 'cdp-failed')
 *   ④ 页面没打开    CdpError('page-failed') 与全部 XError（站点层：登录墙 / 空页 / 结构漂 / 限流）
 *   ⑤ 浏览器报错    其余一切（预想不到的异常）
 *
 * 两类错误来自两个模块，这里只按 code 判，不去正则匹配 message：
 * cdp/error.ts:1-4 把「上层只按 code 决定说哪句话」写成了契约，x/types.ts:22 同理。
 */
import { CdpError, type CdpErrorCode } from '../cdp/types.ts';
import { XError, type XErrorCode } from '../x/types.ts';

export type FailureClass = 'no-browser' | 'not-connected' | 'cmd-silent' | 'page' | 'browser-error';

/** 五类的固定标签。方括号里的这几个字是回执的分类锚点：测试按它断言，绝不互相冒充。 */
export const FAILURE_LABEL: Record<FailureClass, string> = {
  'no-browser': '连不上浏览器',
  'not-connected': '连上了但没接住',
  'cmd-silent': '命令没回话',
  page: '页面没打开',
  'browser-error': '浏览器报错',
};

const CDP_CLASS: Record<CdpErrorCode, FailureClass> = {
  'no-browser': 'no-browser',
  'no-port': 'no-browser',
  'not-connected': 'not-connected',
  'ws-failed': 'not-connected',
  timeout: 'cmd-silent',
  'cdp-failed': 'cmd-silent',
  'page-failed': 'page',
};

/** 站点层一律归「页面没打开」：能连上浏览器却读不到内容，问题在 X 那一侧，不在浏览器。 */
const X_CLASS: Record<XErrorCode, FailureClass> = {
  'login-required': 'page',
  empty: 'page',
  'parse-failed': 'page',
  ratelimited: 'page',
};

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof CdpError) return CDP_CLASS[error.code] ?? 'browser-error';
  if (error instanceof XError) return X_CLASS[error.code] ?? 'page';
  return 'browser-error';
}

/** 该做什么。每类只说这一类该做的事，混进去就是在冒充别的类。 */
export function adviceFor(kind: FailureClass, error: unknown, mode?: 'own' | 'attach'): string {
  switch (kind) {
    case 'no-browser':
      return '浏览器没开，或者没带远程调试口启动。'
        + 'own 模式本该自己拉一个：确认 Chrome / Edge 装好了，或把 worlds.x-feed.chromePath 填成绝对路径；'
        + 'attach 模式要你先手动起来，并带 --remote-debugging-port=<worlds.x-feed.port>（只在你信任的本机环境开，别常驻）。';
    case 'not-connected':
      // attach 模式下面向的是用户日常浏览器：不许教人关掉 origin 防护，代价要写清。
      return mode === 'attach'
        ? '调试口是通的，但连接没建起来。先重试一次；还不行就重启那个浏览器，把来源收窄到本机这一个端口：'
          + '--remote-allow-origins=http://127.0.0.1:<port>。'
          + '注意：这个参数会放松浏览器的 origin 防护，本机别的进程也能借这个调试口读到你登录的站点——'
          + '只在信得过的机器上用，用完把浏览器关掉。'
        : '调试口是通的，但连接没建起来。先重试一次；还不行就重启那个浏览器'
          + '（Chrome 111 起需要 --remote-allow-origins=*；这是本 World 自己的专属实例，登录态不在里面）。';
    case 'cmd-silent':
      return '浏览器收下了命令却没在超时内回话。稍后重试；一直这样就说明浏览器卡住了，重启它。';
    case 'page':
      return pageAdvice(error, mode);
    default:
      return '浏览器这一侧报了意料之外的错。把这段回执和 data/logs/core.log 一起看，多半要改代码。';
  }
}

/** attach 模式下读到空页的第一嫌疑是「后台标签页被节流」，不是选择器。 */
export const ATTACH_THROTTLE_HINT =
  'attach 模式的标签页开在后台，浏览器可能把它节流了（站点看到 visibility=hidden，SPA 常常不渲染）：'
  + '建议把 worlds.x-feed.mode 改成 own，或者把那个标签页切到前台再叫我。别急着怀疑选择器。';

function pageAdvice(error: unknown, mode?: 'own' | 'attach'): string {
  if (error instanceof XError) {
    switch (error.code) {
      case 'login-required':
        return '这次是 X 让你登录，不是浏览器坏了。own 模式下浏览器窗口已经打开，'
          + '请在弹出的 Chrome 里登录 X（只需一次），登录完再叫我——登录一次之后本扩展会记住，下次把窗口收起来。'
          + '不想看到窗口就改成 attach 模式：把 worlds.x-feed.mode 设成 attach，'
          + '用你平时登录 X 的那个浏览器带 --remote-debugging-port=<port> 启动。';
      case 'empty':
        return '页面打开了，但上面没有内容：可能还在加载，也可能这个源本来就没东西。稍后重试或换个源。'
          + (mode === 'attach' ? '另外' + ATTACH_THROTTLE_HINT : '');
      case 'parse-failed':
        return '页面打开了，但读不出帖子：要么这条链接不对，要么 X 的页面结构变了。';
      case 'ratelimited':
        return 'X 正在限流这台浏览器。过十几分钟再试，别连着扫。';
    }
  }
  return '页面没打开：确认这个链接还有效（帖子可能被删、被设成不公开，或这个源写错了）。'
    + (mode === 'attach' ? '另外' + ATTACH_THROTTLE_HINT : '');
}

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * 失败回执。形状固定成三行：分类锚点 / 发生了什么 / 该做什么。
 * what 是这次调用在干什么（例如 'x_look user:alpha'），模型靠它把失败对回到动作上。
 * mode 只影响该做什么：attach 模式面对的是用户自己的浏览器，提示必须更保守。
 */
export function failureText(error: unknown, what: string, mode?: 'own' | 'attach'): string {
  const kind = classifyFailure(error);
  const label = FAILURE_LABEL[kind];
  const lines = ['[失败 · ' + label + '] ' + what];
  const detail = oneLine(errorText(error));
  if (detail) lines.push('发生了什么：' + detail);
  const hint = error instanceof CdpError ? oneLine(String(error.hint ?? '')) : '';
  if (hint && hint !== detail) lines.push('提示：' + hint);
  lines.push('该做什么：' + adviceFor(kind, error, mode));
  return lines.join('\n');
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

/** 单条站内内容的摘要行；第三方正文压成一行、截断，避免长推撑爆回执。 */
export function itemLine(who: string, when: string, text: string, max = 140): string {
  const flat = oneLine(text, max);
  return ['·', who, when, flat].filter((part) => part !== '').join(' ');
}
