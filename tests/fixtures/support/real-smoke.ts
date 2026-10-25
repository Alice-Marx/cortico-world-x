import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEngine } from '../../../src/cdp/index.ts';
import { readSource } from '../../../src/x/index.ts';

const profileDir = join(tmpdir(), 'cortico-x-w3-smoke');
const engine = createEngine({
  mode: 'own',
  port: 9223,
  profileDir,
  backgroundTabs: false,
  readyTimeoutMs: 45000,
  commandTimeoutMs: 30000,
});

try {
  await engine.ensure();
  console.log('engine:', JSON.stringify(engine.status()));
  const posts = await readSource(engine, { kind: 'user', value: 'elonmusk' }, { limit: 5, scrolls: 1 });
  console.log('posts:', posts.length);
  for (const p of posts) {
    console.log(JSON.stringify({ id: p.id, handle: p.author && p.author.handle, date: p.createdAt, text: String(p.text).slice(0, 60) }));
  }
  const empty = posts.filter((p) => !p.text).length;
  console.log('empty-text rows:', empty);
} catch (err: any) {
  console.log('ERROR', err && err.code, '|', err && err.message);
} finally {
  try {
    await engine.dispose();
  } catch (e) {
    console.log('dispose failed', String(e));
  }
}
