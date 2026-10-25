/**
 * CDP 引擎的错误类型。PLAN 3.1 定的 7 个 code 是对外契约：
 * 上层（W5 工具）只按 code 决定说哪句话，不去正则匹配 message。
 *
 * 单独成文件是为了让 types.ts 能对外转出 CdpError 而不产生运行时循环依赖：
 * types.ts → engine.ts（类型）→ error.ts。
 */
export type CdpErrorCode =
  | 'no-browser'
  | 'no-port'
  | 'ws-failed'
  | 'cdp-failed'
  | 'page-failed'
  | 'timeout'
  | 'not-connected';

export class CdpError extends Error {
  code: CdpErrorCode;
  hint?: string;

  constructor(code: CdpErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.hint = hint;
  }

  /** 给 status()/事件用：丢掉栈，只留人话。 */
  toJSON(): { code: CdpErrorCode; message: string; hint?: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/** 每个 code 的默认人话提示：具体抛错处可以覆盖，但永远有兜底。 */
export const HINT: Record<CdpErrorCode, string> = {
  'no-browser': '装好 Chrome 或 Edge，或在配置里填 chromePath（own 模式需要专属 profile 目录）',
  'no-port':
    'own 模式：确认浏览器起来了、端口没被别的程序占住；attach 模式：先手动启动浏览器并带 --remote-debugging-port=<端口>',
  'ws-failed':
    '调试口在听但 WebSocket 连不上：Chrome 111 起需要 --remote-allow-origins=*，或有安全软件拦了本机调试端口',
  'cdp-failed': '浏览器拒绝了这条命令：页面可能已经关掉或正在导航，重试一次通常就好',
  'page-failed': '页面不存在或已关闭：看一眼现在还有哪些页面，或重新开一个页面',
  timeout: '浏览器没在超时内回话：它可能卡住了，或这条命令太重；稍后重试，或给调用方加大超时',
  'not-connected': '还没连上浏览器：先让 ensure() 成功一次（status() 看得到最后一次失败原因）',
};

export function isCdpError(err: unknown): err is CdpError {
  return err instanceof CdpError;
}

/** 任何异常都折成 CdpError：上层不该看见裸 Error。 */
export function asCdpError(
  err: unknown,
  fallback: CdpErrorCode = 'cdp-failed',
  hint?: string,
): CdpError {
  if (isCdpError(err)) return err;
  return new CdpError(fallback, describe(err), hint ?? HINT[fallback]);
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
