/**
 * M1 · ALU（Hack 算术逻辑单元）。
 *
 * 六控制位 + 两状态位的 Hack 真值表（与 nand-computer SPEC 一致）：
 *   zx nx：x 先归零再取反；zy ny：y 先归零再取反；
 *   f=1 算术加法 x+y，f=0 按位与 x&y；no=1 输出取反。
 *   zr=1 ⇔ out==0；ng=1 ⇔ out 最高位（符号位）为 1。
 *
 * 黄金向量 alu.json 覆盖全部 512 组控制位组合 × 若干 (x,y) 采样，共 1536 用例。
 */

import type { ChipBehavior } from '../contract';
import { v } from './bits';

const W16 = 0xffff;

export const ALU_BEHAVIOR: ChipBehavior = {
  ports: [
    { name: 'x', dir: 'in', width: 16 },
    { name: 'y', dir: 'in', width: 16 },
    { name: 'zx', dir: 'in', width: 1 },
    { name: 'nx', dir: 'in', width: 1 },
    { name: 'zy', dir: 'in', width: 1 },
    { name: 'ny', dir: 'in', width: 1 },
    { name: 'f', dir: 'in', width: 1 },
    { name: 'no', dir: 'in', width: 1 },
    { name: 'out', dir: 'out', width: 16 },
    { name: 'zr', dir: 'out', width: 1 },
    { name: 'ng', dir: 'out', width: 1 },
  ],
  evaluate: (inputs) => {
    let x = v(inputs['x']);
    let y = v(inputs['y']);
    if (v(inputs['zx'], 1)) x = 0;
    if (v(inputs['nx'], 1)) x = ~x & W16;
    if (v(inputs['zy'], 1)) y = 0;
    if (v(inputs['ny'], 1)) y = ~y & W16;
    let out = v(inputs['f'], 1) ? (x + y) & W16 : x & y;
    if (v(inputs['no'], 1)) out = ~out & W16;
    return { out, zr: out === 0 ? 1 : 0, ng: (out >>> 15) & 1 };
  },
};
