/**
 * 入口：本部公开 API。
 * 契约类型从 ./contract 引入（冻结）；引擎来自第一部（M5 拷入 src/engine）。
 */

export * from './contract';
export { createEngine } from './engine/createEngine';
export { serializeNetlist, parseNetlist } from './engine/serialize';
export { validateNetlist } from './engine/netlist';

// 芯片库
export { chipLibrary, registerChipLibrary } from './chips/registerAll';
export { ALU_BEHAVIOR } from './chips/alu';
export { MEMDECODE_BEHAVIOR } from './chips/memdecode';
export { SCREEN_BEHAVIOR, KEYBOARD_BEHAVIOR } from './chips/io';
export { makeRam, ROM32K_BEHAVIOR } from './chips/memory';
export { makeRegister, PC_BEHAVIOR, sequentialChips } from './chips/seq';
export {
  adoptRom, adoptRam16K, adoptScreen, adoptKeyboard,
  getRom, getRam16K, getScreen, getKeyboard, clearAllHandles,
  screenPixel, setScreenPixel,
  type RomState, type RamState, type ScreenState, type KeyboardState,
} from './chips/handles';

// 展开器
export { expand } from './expand/expand';
export { NetlistBuilder, port } from './expand/builder';
export type { CompHandle } from './expand/builder';

// Hack 总装
export { HackMachine, buildComputerNetlist, HACK_IDS, type HackMachineOptions } from './hack/computer';
export { buildCpuTemplate, CPU_KIND } from './hack/cpu';
export { parseHack, toHackText, ROM_SIZE } from './hack/rom';
