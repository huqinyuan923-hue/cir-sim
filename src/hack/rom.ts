/**
 * Hack 程序装载：.hack 文本（每行一条 16 位二进制，自地址 0 递增）→ ROM 字数组。
 */

/** ROM 容量：32K 字 */
export const ROM_SIZE = 32768;

/**
 * 解析 .hack 文本：空白行与 `//` 注释行跳过；每行必须是 16 位 0/1 串。
 * 超过 32768 行抛错（ROM 溢出）。
 */
export function parseHack(text: string): number[] {
  const words: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;
    if (!/^[01]{16}$/.test(line)) {
      throw new Error(`parseHack：第 ${i + 1} 行不是 16 位二进制："${raw.trim().slice(0, 40)}"`);
    }
    if (words.length >= ROM_SIZE) {
      throw new Error(`parseHack：程序超过 ROM 容量（${ROM_SIZE} 字）`);
    }
    words.push(parseInt(line, 2));
  }
  return words;
}

/** 字数组 → .hack 文本（round-trip 工具） */
export function toHackText(words: number[]): string {
  return words.map((w) => (w & 0xffff).toString(2).padStart(16, '0')).join('\n') + '\n';
}
