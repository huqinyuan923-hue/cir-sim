/**
 * Hack CPU 子电路模板：数据通路 + 控制译码，用 16 位芯片与原语拼装。
 *
 * 边界端口（模板 PIN 约定，见 expand.ts）：
 *   输入  instr[16]（来自 ROM32K）、inM[16]（来自内存系统）、reset[1]
 *   输出  pc[16]、a[16]、d[16]、outM[16]（=ALU 输出）、writeM[1]
 *
 * 数据通路：
 *   A 寄存器输入 = MUX(instr, ALU out, sel=instr[15])（A 指令高位本就为 0，直接喂 16 位）
 *   ALU.y        = MUX(A, inM, sel=instr[12])
 *   PC.in        = A（跳转目标）；PC.reset ← 外部复位线
 *
 * 控制译码（instr 位 → 信号，全部用 1 位原语门）：
 *   loadA   = !instr[15] | instr[5]      （A 指令 或 dest 含 A）
 *   loadD   = instr[15] & instr[4]
 *   writeM  = instr[15] & instr[3]
 *   pcLoad  = instr[15] & (jlt|jeq|jgt)  （j2&ng | j1&zr | j0&!(zr|ng)）
 *   ALU 控制位 zx..no = instr[11..6] 直连
 */

import type { Netlist, PortRef } from '../contract';
import { NetlistBuilder, port } from '../expand/builder';

/** CPU 模板的 kind 名（注册进展开器 templates 表） */
export const CPU_KIND = 'HACK_CPU';

/** 构建 CPU 模板网表（模板边界：instr/inM/reset → pc/a/d/outM/writeM） */
export function buildCpuTemplate(): Netlist {
  const b = new NetlistBuilder();

  // 边界 pin
  const pInstr = b.pinIn('b_instr', 'instr');
  const pInM = b.pinIn('b_inm', 'inM');
  const pReset = b.pinIn('b_reset', 'reset');
  const oPc = b.pinOut('o_pc', 'pc');
  const oA = b.pinOut('o_a', 'a');
  const oD = b.pinOut('o_d', 'd');
  const oOutM = b.pinOut('o_outm', 'outM');
  const oWriteM = b.pinOut('o_writem', 'writeM');

  // 指令逐位拆分
  const bit = (i: number): PortRef => {
    const s = b.add(`si${i}`, 'SPLIT', { index: i });
    b.connect(pInstr, port(s, 'bus'));
    return port(s, 'bit');
  };
  const i0 = bit(0);
  const i1 = bit(1);
  const i2 = bit(2);
  const i3 = bit(3);
  const i4 = bit(4);
  const i5 = bit(5);
  const i6 = bit(6);
  const i7 = bit(7);
  const i8 = bit(8);
  const i9 = bit(9);
  const i10 = bit(10);
  const i11 = bit(11);
  const i12 = bit(12);
  const i15 = bit(15);

  // 数据通路
  const ysel = b.add('mux_y', 'MUX16'); // y = sel ? inM : A
  b.connect(i12, port(ysel, 'sel'));
  b.connect(pInM, port(ysel, 'b'));
  const alu = b.add('alu', 'ALU');
  b.connect(port(ysel, 'out'), port(alu, 'y'));
  const dreg = b.add('dreg', 'DREGISTER');
  b.connect(port(dreg, 'out'), port(alu, 'x'));
  b.connect(port(alu, 'out'), port(dreg, 'in'));

  const aselect = b.add('mux_ain', 'MUX16'); // A 输入 = i15 ? ALU out : instr
  b.connect(i15, port(aselect, 'sel'));
  b.connect(pInstr, port(aselect, 'a'));
  b.connect(port(alu, 'out'), port(aselect, 'b'));
  const areg = b.add('areg', 'AREGISTER');
  b.connect(port(aselect, 'out'), port(areg, 'in'));
  b.connect(port(areg, 'out'), port(ysel, 'a')); // A → ALU.y（a 位=0 时）
  b.connect(port(areg, 'out'), oA);

  const pc = b.add('pc', 'PC');
  b.connect(port(areg, 'out'), port(pc, 'in')); // 跳转目标 = A
  const one = b.add('const1', 'CONST', { value: 1 });
  b.connect(port(one, 'y'), port(pc, 'inc'));
  b.connect(pReset, port(pc, 'reset'));
  b.connect(port(pc, 'out'), oPc);

  // 控制译码
  const g = (id: string, kind: string): PortRef => port(b.add(id, kind), 'y');
  const n15 = g('not_c', 'NOT');
  b.connect(i15, { componentId: n15.componentId, port: 'a' });
  const loadA = g('or_a', 'OR');
  b.connect(n15, { componentId: loadA.componentId, port: 'a' });
  b.connect(i5, { componentId: loadA.componentId, port: 'b' });
  b.connect(loadA, port(areg, 'load'));

  const loadD = g('and_d', 'AND');
  b.connect(i15, { componentId: loadD.componentId, port: 'a' });
  b.connect(i4, { componentId: loadD.componentId, port: 'b' });
  b.connect(loadD, port(dreg, 'load'));

  const writeM = g('and_m', 'AND');
  b.connect(i15, { componentId: writeM.componentId, port: 'a' });
  b.connect(i3, { componentId: writeM.componentId, port: 'b' });
  b.connect(writeM, oWriteM);

  // 跳转：jlt = j2&ng；jeq = j1&zr；jgt = j0&!(zr|ng)
  const zrNg = g('or_zn', 'OR');
  b.connect(port(alu, 'zr'), { componentId: zrNg.componentId, port: 'a' });
  b.connect(port(alu, 'ng'), { componentId: zrNg.componentId, port: 'b' });
  const notZn = g('not_zn', 'NOT');
  b.connect(zrNg, { componentId: notZn.componentId, port: 'a' });
  const jgt = g('and_gt', 'AND');
  b.connect(i0, { componentId: jgt.componentId, port: 'a' });
  b.connect(notZn, { componentId: jgt.componentId, port: 'b' });
  const jlt = g('and_lt', 'AND');
  b.connect(i2, { componentId: jlt.componentId, port: 'a' });
  b.connect(port(alu, 'ng'), { componentId: jlt.componentId, port: 'b' });
  const jeq = g('and_eq', 'AND');
  b.connect(i1, { componentId: jeq.componentId, port: 'a' });
  b.connect(port(alu, 'zr'), { componentId: jeq.componentId, port: 'b' });
  const j01 = g('or_j01', 'OR');
  b.connect(jlt, { componentId: j01.componentId, port: 'a' });
  b.connect(jeq, { componentId: j01.componentId, port: 'b' });
  const jumpAny = g('or_j', 'OR');
  b.connect(j01, { componentId: jumpAny.componentId, port: 'a' });
  b.connect(jgt, { componentId: jumpAny.componentId, port: 'b' });
  const pcLoad = g('and_pc', 'AND');
  b.connect(i15, { componentId: pcLoad.componentId, port: 'a' });
  b.connect(jumpAny, { componentId: pcLoad.componentId, port: 'b' });
  b.connect(pcLoad, port(pc, 'load'));

  // ALU 控制位直连
  const ctrl: [PortRef, string][] = [
    [i11, 'zx'], [i10, 'nx'], [i9, 'zy'], [i8, 'ny'], [i7, 'f'], [i6, 'no'],
  ];
  for (const [src, dst] of ctrl) b.connect(src, port(alu, dst));

  // 观察输出
  b.connect(port(alu, 'out'), oOutM);
  b.connect(port(dreg, 'out'), oD);

  return b.build();
}
