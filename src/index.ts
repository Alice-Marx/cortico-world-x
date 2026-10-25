/**
 * 包入口。装配层只取默认导出（extensions.ts:335），再按 isWorldDefinition 校验形状
 * （extensions.ts:132-139、344-358）。这里除了 re-export 不做别的事：入门面越平越好。
 *
 * 对框架只 import type，运行时零依赖——裸 node 就能 import 这个文件（测试依赖这一点）。
 */
import type { WorldDefinition } from 'cortico/world.ts';
import { X_FEED } from './definition.ts';
import type { XFeedConfigSection } from './config.ts';

/** 定义本身。annotation 在 definition.ts 里，这里再钉一次同一个类型。 */
const definition: WorldDefinition<XFeedConfigSection> = X_FEED;

export default definition;
export { X_FEED };
export { XWorld, ENV_PROMPT_FILE, ENV_PROMPT_KEY } from './world.ts';
export { TOOL_SPECS } from './definition.ts';
export { WORLD_ID, X_FEED_DEFAULTS, X_FEED_DECLARED_KEYS, sourceLines, parseSourceLine } from './config.ts';
export type { SourceLineResult, XFeedConfigSection } from './config.ts';
export type { XSource, XSourceKind } from './x/index.ts';
