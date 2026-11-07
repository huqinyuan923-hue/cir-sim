/**
 * 黄金向量文件读取（Node 测试环境专用，不进 src 打包）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldenFile } from '../../src/testkit/harness';

/** 读 golden/<name>.json */
export function loadGolden(name: string): GoldenFile {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', '..', 'golden', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as GoldenFile;
}

/** 读 golden/sw 下的软件产物（.hack 文本 / input.txt / checkpoints.json） */
export function loadSwText(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', 'golden', 'sw', name), 'utf-8');
}

export function loadSwJson(name: string): unknown {
  return JSON.parse(loadSwText(name));
}
