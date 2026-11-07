/**
 * M4 · 外设芯片：SCREEN（屏幕帧缓冲）与 KEYBOARD（键盘）。
 *
 * SCREEN：内存映射 0x4000–0x5FFF（8192 字），端口与 RAM 同构（in/load/address/out），
 * 写入在时钟沿采样；帧数据经句柄注册表（props.id）暴露给画布——画布每帧读
 * words[] 渲染 512×256 单色位图（w = y*32+(x>>4)，位 15-(x&15)）。
 *
 * KEYBOARD：映射 0x6000 的单字只读外设。库形态为无输入的原生芯片（evaluate 只读
 * state.key，键值经句柄注入）；在 Hack 总装网表中，键盘实际由 PIN_IN 建模
 * （契约的外部输入唯一入口是 engine.setInput，见 REPORT 决策 D4），
 * KEYBOARD 芯片保留用于独立小电路与教学场景。
 */

import type { ChipBehavior } from '../contract';
import { p, v } from './bits';
import { adoptKeyboard, adoptScreen, type KeyboardState, type ScreenState } from './handles';

export const SCREEN_BEHAVIOR: ChipBehavior = {
  ports: [
    p('in', 'in', 16),
    p('load', 'in', 1),
    p('address', 'in', 13),
    p('out', 'out', 16),
  ],
  initState: (props): ScreenState => adoptScreen(props),
  evaluate: (inputs, state) => {
    const s = state as ScreenState;
    const addr = 'address' in inputs ? v(inputs['address'], 0x1fff) : v(s.lastAddr, 0x1fff);
    s.lastAddr = addr;
    return { out: v(s.words[addr]) };
  },
  onClockEdge: (inputs, state) => {
    const s = state as ScreenState;
    const addr = v(inputs['address'], 0x1fff);
    s.lastAddr = addr;
    if (v(inputs['load'], 1)) s.words[addr] = v(inputs['in']);
  },
};

export const KEYBOARD_BEHAVIOR: ChipBehavior = {
  ports: [p('out', 'out', 16)],
  initState: (props): KeyboardState => adoptKeyboard(props),
  evaluate: (_inputs, state) => ({ out: v((state as KeyboardState).key) }),
};

export function peripheralChips(): Record<string, ChipBehavior> {
  return { SCREEN: SCREEN_BEHAVIOR, KEYBOARD: KEYBOARD_BEHAVIOR };
}
