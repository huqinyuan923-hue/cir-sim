/**
 * 外设/存储句柄注册表。
 *
 * 背景：契约的 ChipBehavior 是"原型对象"，引擎按组件实例化状态（initState 产物），
 * 外部拿不到状态引用。但 ROM 烧程序、屏幕取帧、键盘注入、RAM 读写种子这些能力
 * 是 Hack 总装与画布集成的刚需。解法（本部核心决策 D3，详见 REPORT.md）：
 *
 *   芯片 initState(props) 时按 props.id 到本注册表"认领"既有状态；
 *   认领不到才新建并登记。因此：
 *   - 载入前先经本表写入的程序/种子，在 engine.load() 后立即生效；
 *   - engine.reset() 重建运行时会再次 initState → 重新认领同一对象 →
 *     程序、屏幕内容、RAM 数据、键值全部幸存（对齐"reset 线只复位 PC"的 Hack 语义）；
 *   - 测试想要干净环境时调用 clearAllHandles()。
 */

/** ROM32K 状态：32768 个 16 位字（纯组合读出，无时钟状态） */
export interface RomState {
  words: number[];
  [k: string]: unknown;
}

/** RAM16K 状态：16384 个 16 位字 */
export interface RamState {
  mem: number[];
  lastAddr: number;
  [k: string]: unknown;
}

/** SCREEN 状态：8192 个 16 位字（512×256 单色帧缓冲，w = y*32 + (x>>4)，位 15-(x&15)） */
export interface ScreenState {
  words: number[];
  lastAddr: number;
  [k: string]: unknown;
}

/** KEYBOARD 状态：当前键码（0 = 无键） */
export interface KeyboardState {
  key: number;
  [k: string]: unknown;
}

const romRegistry = new Map<string, RomState>();
const ramRegistry = new Map<string, RamState>();
const screenRegistry = new Map<string, ScreenState>();
const kbdRegistry = new Map<string, KeyboardState>();

/** initState 通用逻辑：按 id 认领，认领不到则新建登记 */
function adopt<T extends object>(registry: Map<string, T>, id: string, make: () => T): T {
  const found = registry.get(id);
  if (found) return found;
  const fresh = make();
  registry.set(id, fresh);
  return fresh;
}

// ── 认领入口（芯片 initState 调用） ────────────────────────────────────────

export function adoptRom(props: Readonly<Record<string, number | string>>): RomState {
  return adopt(romRegistry, String(props['id'] ?? ''), () => ({
    words: new Array<number>(32768).fill(0),
    lastAddr: 0,
  }));
}

export function adoptRam16K(props: Readonly<Record<string, number | string>>): RamState {
  return adopt(ramRegistry, String(props['id'] ?? ''), () => ({
    mem: new Array<number>(16384).fill(0),
    lastAddr: 0,
  }));

}

export function adoptScreen(props: Readonly<Record<string, number | string>>): ScreenState {
  return adopt(screenRegistry, String(props['id'] ?? ''), () => ({
    words: new Array<number>(8192).fill(0),
    lastAddr: 0,
  }));
}

export function adoptKeyboard(props: Readonly<Record<string, number | string>>): KeyboardState {
  return adopt(kbdRegistry, String(props['id'] ?? ''), () => ({ key: 0 }));
}

// ── 外部句柄（总装/画布/测试使用） ────────────────────────────────────────

export function getRom(id: string): RomState | undefined {
  return romRegistry.get(id);
}

export function getRam16K(id: string): RamState | undefined {
  return ramRegistry.get(id);
}

export function getScreen(id: string): ScreenState | undefined {
  return screenRegistry.get(id);
}

export function getKeyboard(id: string): KeyboardState | undefined {
  return kbdRegistry.get(id);
}

/** 清空全部句柄（测试隔离用；引擎里的旧状态对象会随之脱管） */
export function clearAllHandles(): void {
  romRegistry.clear();
  ramRegistry.clear();
  screenRegistry.clear();
  kbdRegistry.clear();
}

// ── 屏幕像素工具（SPEC 口径：w = y*32 + (x>>4)，位 = 15-(x&15)，1=点亮） ──

/** 读屏幕像素 (x, y)：返回 0/1 */
export function screenPixel(words: number[], x: number, y: number): number {
  const w = y * 32 + (x >> 4);
  return (words[w] ?? 0) >>> (15 - (x & 15)) & 1;
}

/** 写屏幕像素 (x, y)（只改句柄数组，不触发仿真传播——画布侧工具） */
export function setScreenPixel(words: number[], x: number, y: number, on: 0 | 1): void {
  const w = y * 32 + (x >> 4);
  const bit = 15 - (x & 15);
  const cur = words[w] ?? 0;
  words[w] = on ? cur | (1 << bit) : cur & ~(1 << bit);
}
