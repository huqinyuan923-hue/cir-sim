/**
 * 屏幕帧哈希（nand-computer SPEC 口径）：8192 个字按大端展开成 16384 字节，
 * 取 SHA-256 小写十六进制。仅测试环境使用（Node crypto），不进 web 打包。
 */

import { createHash } from 'node:crypto';

export function screenHash(words: number[]): string {
  const bytes = Buffer.alloc(words.length * 2);
  for (let i = 0; i < words.length; i++) {
    const w = (words[i] ?? 0) & 0xffff;
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  }
  return createHash('sha256').update(bytes).digest('hex');
}
