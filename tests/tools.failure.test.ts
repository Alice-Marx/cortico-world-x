/**
 * 5 类失败回执（PLAN 第 5 节；措辞按 _research/cwb/NOTES.md 第 4 节的事故教训）。
 *
 * 这个文件守的是最容易被毁掉的那件事：把「站点/登录问题」说成「浏览器坏了」。
 * 每条断言都走真实 handler（x_look / x_read），只有回执文本是断言对象。
 * 另外守一件事：world.tools() 的声明必须与 definition.ts 的 TOOL_SPECS 逐字一致。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CdpError } from '../src/cdp/types.ts';
import { TOOL_SPECS } from '../src/definition.ts';
import { classifyFailure, FAILURE_LABEL } from '../src/tools/receipt.ts';
import { callTool, makeScriptedEngine, makeWorld } from './world.support.ts';

const fixture = (name: string): string => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

const LABELS = Object.values(FAILURE_LABEL);

/** 回执里只许出现它自己那一类的标签，别的四类一个字都不许有。 */
function assertOnlyClass(text: string, expected: string): void {
  assert.ok(text.includes('[失败 · ' + expected + ']'), '回执里要有分类锚点「' + expected + '」，实得：' + text);
  for (const label of LABELS) {
    if (label === expected) continue;
    assert.ok(!text.includes(label), '「' + expected + '」的回执里混进了「' + label + '」：' + text);
  }
}

test('① 连不上浏览器：浏览器没开 / 没开远程调试口', async () => {
  const engine = makeScriptedEngine({
    failOn: 'ensure',
    error: new CdpError('no-browser', '没找到 Chrome / Edge', '装一个，或把 chromePath 填成绝对路径'),
  });
  const built = await makeWorld({ cfg: { maxScrolls: 0 }, engine });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '连不上浏览器');
    assert.match(receipt.text, /浏览器没开|没带远程调试口/, '要告诉人去开什么');
    assert.match(receipt.text, /--remote-debugging-port/, 'attach 模式该带什么参数也写清楚');
    assert.ok(!receipt.text.includes('登录'), '连不上不等于让你登录');
  } finally {
    await built.cleanup();
  }
});

test('① 连不上浏览器：端口不通（no-port）也是同一类', async () => {
  const engine = makeScriptedEngine({ failOn: 'ensure', error: new CdpError('no-port', '端口 9223 没有在听') });
  const built = await makeWorld({ engine });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assertOnlyClass(receipt.text, '连不上浏览器');
  } finally {
    await built.cleanup();
  }
});

test('② 连上了但没接住：ws-failed / not-connected 都归这里', async () => {
  const ws = makeScriptedEngine({ failOn: 'newPage', error: new CdpError('ws-failed', 'WebSocket 握手被拒') });
  const built = await makeWorld({ engine: ws });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '连上了但没接住');
    assert.match(receipt.text, /重试|重启/, '要给重试/重启的动作');
  } finally {
    await built.cleanup();
  }

  const notConnected = makeScriptedEngine({ failOn: 'newPage', error: new CdpError('not-connected', '还没连上') });
  const other = await makeWorld({ engine: notConnected });
  try {
    const receipt = await callTool(other.world, 'x_look');
    assertOnlyClass(receipt.text, '连上了但没接住');
  } finally {
    await other.cleanup();
  }
});

test('③ 命令没回话：timeout / cdp-failed', async () => {
  const engine = makeScriptedEngine({ failOn: 'goto', error: new CdpError('timeout', 'Page.navigate 没回话') });
  const built = await makeWorld({ engine });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '命令没回话');
    assert.match(receipt.text, /稍后重试/, '超时先让人重试，不要叫人换浏览器');
  } finally {
    await built.cleanup();
  }
  assert.equal(classifyFailure(new CdpError('cdp-failed', 'x')), 'cmd-silent', 'cdp-failed 也归「命令没回话」');
  assert.equal(classifyFailure(new CdpError('timeout', 'x')), 'cmd-silent');
});

test('④ 页面没打开：X 让登录时说清「不是浏览器坏了」', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '页面没打开');
    assert.match(receipt.text, /不是浏览器坏了/, '必须明说这句：这是这个包最容易毁掉体验的地方');
    assert.match(receipt.text, /登录 X/, '要说清是登录 X，不是别的事');
    assert.match(receipt.text, /登录完再叫我|只需一次/, '要给人一句能照做的话');
    assert.ok(!receipt.text.includes('连不上浏览器'));
  } finally {
    await built.cleanup();
  }
});

test('④ 页面没打开：CdpError(page-failed) 与限流都归这里，且不说成浏览器坏了', async () => {
  const target = makeScriptedEngine({ failOn: 'newPage', error: new CdpError('page-failed', '页面已经关了') });
  const built = await makeWorld({ engine: target });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assertOnlyClass(receipt.text, '页面没打开');
  } finally {
    await built.cleanup();
  }
  assert.equal(classifyFailure(new (class extends Error {})()), 'browser-error', '认不出来的异常不许冒充前四类');
});

test('⑤ 浏览器报错：预想不到的异常才归这里', async () => {
  const engine = makeScriptedEngine({ failOn: 'newPage', error: new Error('boom: 未知故障') });
  const built = await makeWorld({ engine });
  try {
    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '浏览器报错');
    assert.match(receipt.text, /core\.log/, '意料之外的错要指向日志');
  } finally {
    await built.cleanup();
  }
});

test('参数错误单独一类：不许冒充 5 类里的任何一类', async () => {
  const built = await makeWorld({ engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    const receipt = await callTool(built.world, 'x_watch', { action: 'destroy' });
    assert.equal(receipt.failed, true);
    assert.match(receipt.text, /\[参数不对\]/);
    for (const label of LABELS) assert.ok(!receipt.text.includes(label), '参数错误里混进了「' + label + '」');
  } finally {
    await built.cleanup();
  }
});

test('x_read：登录墙也走 ④，不是 ①', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')] });
  const built = await makeWorld({ engine });
  try {
    const receipt = await callTool(built.world, 'x_read', { url: 'https://x.com/elonmusk/status/1847000000000000001' });
    assert.equal(receipt.failed, true);
    assertOnlyClass(receipt.text, '页面没打开');
  } finally {
    await built.cleanup();
  }
});

test('对齐 TOOL_SPECS：名字、description、parameters、tags 逐字一致', async () => {
  const built = await makeWorld({ engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    const decls = built.world.tools();
    assert.equal(decls.length, TOOL_SPECS.length, 'PLAN 第 5 节的 7 个工具');
    assert.deepEqual(
      decls.map((one) => one.name),
      TOOL_SPECS.map((one) => one.name),
      '名字与顺序都要跟 TOOL_SPECS 一致',
    );
    for (const spec of TOOL_SPECS) {
      const decl = decls.find((one) => one.name === spec.name);
      assert.ok(decl, '缺工具：' + spec.name);
      assert.equal(decl.description, spec.description, spec.name + ' 的 description 必须逐字相同');
      assert.deepEqual(decl.parameters, spec.parameters, spec.name + ' 的 parameters 必须逐字相同');
      assert.deepEqual([...decl.tags], [...spec.tags], spec.name + ' 的 tags 必须逐字相同');
      assert.equal(typeof decl.handler, 'function', spec.name + ' 要挂 handler');
    }
  } finally {
    await built.cleanup();
  }
});

test('对齐 describe.json：每个工具都在自描述里，一个不多一个不少', async () => {
  const built = await makeWorld({ engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    const describe = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
    const described = describe.tools.map((one: { name: string }) => one.name);
    assert.deepEqual(
      [...described].sort(),
      [...built.world.tools().map((one) => one.name)].sort(),
      'describe.json 与实例工具表必须是同一批名字',
    );
  } finally {
    await built.cleanup();
  }
});
