/**
 * 原语逐个边界测试：全部通过引擎端到端驱动（pin → 原语 → pinout），
 * 保证"行为表 + 传播 + 掩码"整条链路符合语义。
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import type { SimEngine } from '../../src/contract';
import { NetlistBuilder, ref } from './helpers';

/** 搭一个"输入 pin → 被测芯片 → 输出 pin"的最小电路 */
function evalChip(
  kind: string,
  props: Record<string, number | string>,
  drive: Record<string, number>,
  inputWidths: Record<string, number> = {},
): { engine: SimEngine; out: number } {
  const b = new NetlistBuilder();
  const inNames = Object.keys(drive);
  for (const name of inNames) {
    // pin 宽度：显式指定优先；否则按驱动值自适应（0/1 → 1 位）
    const auto = Math.max(1, 32 - Math.clz32((drive[name] ?? 0) >>> 0));
    b.add(`pin_${name}`, 'PIN_IN', { width: inputWidths[name] ?? auto });
  }
  b.add('chip', kind, props);
  b.add('po', 'PIN_OUT', { width: 31 });
  for (const name of inNames) {
    b.connect(ref(`pin_${name}`, 'y'), ref('chip', name));
  }
  const outPort = outPortOf(kind);
  b.connect(ref('chip', outPort), ref('po', 'a'));
  const e = createEngine();
  e.load(b.build());
  for (const [name, v] of Object.entries(drive)) {
    e.setInput(ref(`pin_${name}`, 'y'), v);
  }
  e.tick();
  return { engine: e, out: e.read(ref('po', 'a')) };
}

function outPortOf(kind: string): string {
  switch (kind) {
    case 'SPLIT':
      return 'bit';
    case 'JOIN':
      return 'bus';
    default:
      return 'y';
  }
}

describe('AND', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 1],
  ])('真值表 %i & %i = %i', (a, b, y) => {
    expect(evalChip('AND', {}, { a, b }).out).toBe(y);
  });

  it('宽度 4：按位与', () => {
    expect(evalChip('AND', { width: 4 }, { a: 0b1100, b: 0b1010 }).out).toBe(0b1000);
  });

  it('宽度 16：全 1 与全 1', () => {
    expect(evalChip('AND', { width: 16 }, { a: 0xffff, b: 0xffff }).out).toBe(0xffff);
  });

  it('输入超出端口宽度时输出按宽度掩码', () => {
    // net 上有 16 位驱动（pin width=16），门宽 4 → 输出截到 4 位
    expect(evalChip('AND', { width: 4 }, { a: 0xffff, b: 0xffff }, { a: 16, b: 16 }).out).toBe(0xf);
  });

  it('width 写成字符串 "4" 也能生效', () => {
    expect(evalChip('AND', { width: '4' }, { a: 0b1111, b: 0b0110 }).out).toBe(0b0110);
  });
});

describe('NAND', () => {
  it.each([
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ])('真值表 ~( %i & %i ) = %i', (a, b, y) => {
    expect(evalChip('NAND', {}, { a, b }).out).toBe(y);
  });

  it('宽度 4：取反后掩码收回非负', () => {
    expect(evalChip('NAND', { width: 4 }, { a: 0b0000, b: 0b0000 }).out).toBe(0b1111);
    expect(evalChip('NAND', { width: 4 }, { a: 0b1111, b: 0b1111 }).out).toBe(0b0000);
    expect(evalChip('NAND', { width: 4 }, { a: 0b1100, b: 0b1010 }).out).toBe(0b0111);
  });

  it('宽度 31（上限）：0 与 0 得全 1', () => {
    expect(evalChip('NAND', { width: 31 }, { a: 0, b: 0 }).out).toBe(0x7fffffff);
  });

  it('width 越界被钳制到 31', () => {
    const r = evalChip('NAND', { width: 999 }, { a: 0, b: 0 });
    expect(r.out).toBe(0x7fffffff);
  });
});

describe('OR', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ])('真值表 %i | %i = %i', (a, b, y) => {
    expect(evalChip('OR', {}, { a, b }).out).toBe(y);
  });

  it('宽度 8：按位或', () => {
    expect(evalChip('OR', { width: 8 }, { a: 0x0f, b: 0xf0 }).out).toBe(0xff);
  });
});

describe('XOR', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ])('真值表 %i ^ %i = %i', (a, b, y) => {
    expect(evalChip('XOR', {}, { a, b }).out).toBe(y);
  });

  it('宽度 4：按位异或', () => {
    expect(evalChip('XOR', { width: 4 }, { a: 0b1100, b: 0b1010 }).out).toBe(0b0110);
  });

  it('自反律：x ^ x = 0', () => {
    expect(evalChip('XOR', { width: 8 }, { a: 0xa5, b: 0xa5 }).out).toBe(0);
  });
});

describe('NOT', () => {
  it.each([
    [0, 1],
    [1, 0],
  ])('真值表 ~%i = %i', (a, y) => {
    expect(evalChip('NOT', {}, { a }).out).toBe(y);
  });

  it('宽度 4：按位取反并掩码（~0x5 = 0xA）', () => {
    expect(evalChip('NOT', { width: 4 }, { a: 0x5 }).out).toBe(0xa);
  });

  it('宽度 1 时 net 上残留高位不泄漏：取反仅限 1 位', () => {
    // pin 宽 16 驱动 0xFFFE，NOT 宽 1 → 只对第 0 位取反 → 1
    expect(evalChip('NOT', { width: 1 }, { a: 0xfffe }, { a: 16 }).out).toBe(1);
  });

  it('宽度 31：~0 = 0x7fffffff', () => {
    expect(evalChip('NOT', { width: 31 }, { a: 0 }).out).toBe(0x7fffffff);
  });
});

describe('MUX', () => {
  it('sel=0 选 in0', () => {
    expect(evalChip('MUX', {}, { in0: 1, in1: 0, sel: 0 }).out).toBe(1);
  });
  it('sel=1 选 in1', () => {
    expect(evalChip('MUX', {}, { in0: 1, in1: 0, sel: 1 }).out).toBe(0);
  });
  it('sel=2 只看 bit0（=0）→ 选 in0', () => {
    expect(evalChip('MUX', {}, { in0: 1, in1: 0, sel: 2 }).out).toBe(1);
  });
  it('sel=3（bit0=1）→ 选 in1', () => {
    expect(evalChip('MUX', {}, { in0: 1, in1: 0, sel: 3 }).out).toBe(0);
  });
  it('数据宽度 8：整字选择', () => {
    expect(evalChip('MUX', { width: 8 }, { in0: 0x12, in1: 0x34, sel: 1 }).out).toBe(0x34);
    expect(evalChip('MUX', { width: 8 }, { in0: 0x12, in1: 0x34, sel: 0 }).out).toBe(0x12);
  });
  it('sel 固定 1 位：不随 props.width 缩放', () => {
    // width=4 时 sel 仍按 bit0；in 数据宽 4
    expect(evalChip('MUX', { width: 4 }, { in0: 0xf, in1: 0x0, sel: 8 }).out).toBe(0xf);
  });
});

describe('CONST', () => {
  it('默认输出 props.value=0', () => {
    expect(evalChip('CONST', {}, {}).out).toBe(0);
  });
  it('数值 value', () => {
    expect(evalChip('CONST', { value: 5 }, {}).out).toBe(5);
  });
  it('字符串 value', () => {
    expect(evalChip('CONST', { value: '7' }, {}).out).toBe(7);
  });
  it('负值按宽度掩码收回（width 4，value -1 → 0xF）', () => {
    expect(evalChip('CONST', { value: -1, width: 4 }, {}).out).toBe(0xf);
  });
  it('value 超出宽度被掩码（width 4，value 0xFF → 0xF）', () => {
    expect(evalChip('CONST', { value: 0xff, width: 4 }, {}).out).toBe(0xf);
  });
});

describe('PIN_IN / PIN_OUT', () => {
  it('未设置时 PIN_IN 输出 0', () => {
    const b = new NetlistBuilder();
    b.add('pin', 'PIN_IN');
    b.add('po', 'PIN_OUT');
    b.connect(ref('pin', 'y'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    expect(e.read(ref('po', 'a'))).toBe(0);
    expect(e.read(ref('pin', 'y'))).toBe(0);
  });
  it('setInput 后读回设置值（load 时已 settle）', () => {
    const b = new NetlistBuilder();
    b.add('pin', 'PIN_IN');
    b.add('po', 'PIN_OUT');
    b.connect(ref('pin', 'y'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('pin', 'y'), 1);
    expect(e.read(ref('pin', 'y'))).toBe(1);
    expect(e.read(ref('po', 'a'))).toBe(1);
  });
  it('PIN_IN 宽度 16：可设 16 位值', () => {
    const b = new NetlistBuilder();
    b.add('pin', 'PIN_IN', { width: 16 });
    b.add('po', 'PIN_OUT', { width: 16 });
    b.connect(ref('pin', 'y'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('pin', 'y'), 0xabcd);
    expect(e.read(ref('po', 'a'))).toBe(0xabcd);
  });
  it('setInput 超宽值按 pin 宽度掩码', () => {
    const b = new NetlistBuilder();
    b.add('pin', 'PIN_IN', { width: 4 });
    b.add('po', 'PIN_OUT', { width: 31 });
    b.connect(ref('pin', 'y'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('pin', 'y'), 0xff);
    expect(e.read(ref('po', 'a'))).toBe(0xf);
  });
  it('setInput 负值按补码掩码（-1, 宽 4 → 0xF）', () => {
    const b = new NetlistBuilder();
    b.add('pin', 'PIN_IN', { width: 4 });
    b.add('po', 'PIN_OUT', { width: 31 });
    b.connect(ref('pin', 'y'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('pin', 'y'), -1);
    expect(e.read(ref('po', 'a'))).toBe(0xf);
  });
});

describe('SPLIT', () => {
  const bus = 0b1011001110001111; // 0xB38F
  // 期望值直接由"取第 index 位"的规格表达式生成（被测对象是引擎链路，不是位运算本身）
  it.each([...Array(16).keys()].map((i) => [i, (bus >>> i) & 1]))(
    '取第 %i 位 = %i',
    (index, bit) => {
      expect(evalChip('SPLIT', { width: 16, index }, { bus }, { bus: 16 }).out).toBe(bit);
    },
  );
  it('index 超出总线宽度 → 0', () => {
    expect(evalChip('SPLIT', { width: 16, index: 16 }, { bus: 0xffff }, { bus: 16 }).out).toBe(0);
  });
  it('index 为负被钳制为 0', () => {
    expect(evalChip('SPLIT', { width: 16, index: -3 }, { bus }, { bus: 16 }).out).toBe(1);
  });
  it('index 是字符串 "3"', () => {
    expect(evalChip('SPLIT', { width: 16, index: '3' }, { bus }, { bus: 16 }).out).toBe(1);
  });
  it('缺 index 默认取第 0 位', () => {
    expect(evalChip('SPLIT', { width: 16 }, { bus: 2 }, { bus: 16 }).out).toBe(0);
  });
});

describe('JOIN', () => {
  it('high=0：bit 放到第 0 位', () => {
    expect(evalChip('JOIN', { width: 16 }, { bit: 1 }).out).toBe(1);
  });
  it('high=5：bit 放到第 5 位', () => {
    expect(evalChip('JOIN', { width: 16, high: 5 }, { bit: 1 }).out).toBe(32);
  });
  it('bit=0 时输出 0', () => {
    expect(evalChip('JOIN', { width: 16, high: 5 }, { bit: 0 }).out).toBe(0);
  });
  it('high 超出宽度被钳制（width 4, high 9 → 第 3 位）', () => {
    expect(evalChip('JOIN', { width: 4, high: 9 }, { bit: 1 }).out).toBe(8);
  });
  it('默认 width=16 / high=0', () => {
    expect(evalChip('JOIN', {}, { bit: 1 }).out).toBe(1);
  });
  it('两条 JOIN 拼总线：不同位不冲突，合并为完整总线', () => {
    const b = new NetlistBuilder();
    b.add('b0', 'PIN_IN'); // 拼第 0 位
    b.add('b4', 'PIN_IN'); // 拼第 4 位
    b.add('j0', 'JOIN', { width: 16, high: 0 });
    b.add('j4', 'JOIN', { width: 16, high: 4 });
    b.add('po', 'PIN_OUT', { width: 31 });
    b.connect(ref('b0', 'y'), ref('j0', 'bit'));
    b.connect(ref('b4', 'y'), ref('j4', 'bit'));
    b.connect(ref('j0', 'bus'), ref('po', 'a'));
    b.connect(ref('j4', 'bus'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('b0', 'y'), 1);
    e.setInput(ref('b4', 'y'), 1);
    e.tick();
    expect(e.read(ref('po', 'a'))).toBe(0b10001);
    expect(e.diagnostics().filter((d) => d.kind === 'conflict')).toHaveLength(0);
  });
  it('两条 JOIN 同一位都驱动 1：同值不算冲突', () => {
    const b = new NetlistBuilder();
    b.add('b1', 'PIN_IN');
    b.add('b2', 'PIN_IN');
    b.add('j1', 'JOIN', { width: 16, high: 3 });
    b.add('j2', 'JOIN', { width: 16, high: 3 });
    b.add('po', 'PIN_OUT', { width: 31 });
    b.connect(ref('b1', 'y'), ref('j1', 'bit'));
    b.connect(ref('b2', 'y'), ref('j2', 'bit'));
    b.connect(ref('j1', 'bus'), ref('po', 'a'));
    b.connect(ref('j2', 'bus'), ref('po', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('b1', 'y'), 1);
    e.setInput(ref('b2', 'y'), 1);
    e.tick();
    expect(e.read(ref('po', 'a'))).toBe(8);
    expect(e.diagnostics().filter((d) => d.kind === 'conflict')).toHaveLength(0);
  });
});

describe('DFF（行为层）', () => {
  function dffCircuit(): SimEngine {
    const b = new NetlistBuilder();
    b.add('d', 'PIN_IN');
    b.add('f', 'DFF');
    b.add('q', 'PIN_OUT');
    b.connect(ref('d', 'y'), ref('f', 'd'));
    b.connect(ref('f', 'q'), ref('q', 'a'));
    const e = createEngine();
    e.load(b.build());
    return e;
  }
  it('初始 q=0，无论 d 是什么', () => {
    const e = dffCircuit();
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    expect(e.read(ref('q', 'a'))).toBe(0);
  });
  it('clockEdge 采样 d=1 → q=1', () => {
    const e = dffCircuit();
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    e.clockEdge();
    expect(e.read(ref('q', 'a'))).toBe(1);
  });
  it('clockEdge 采样 d=0 → q=0', () => {
    const e = dffCircuit();
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    e.clockEdge();
    e.setInput(ref('d', 'y'), 0);
    e.tick();
    e.clockEdge();
    expect(e.read(ref('q', 'a'))).toBe(0);
  });
  it('不 tick 也能读沿后立即写下的 q 值', () => {
    const e = dffCircuit();
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    e.clockEdge();
    expect(e.read(ref('q', 'a'))).toBe(1); // clockEdge 立即写 net
  });
  it('连续 4 个沿：按沿前 d 值依次翻转（T 触发器接法）', () => {
    // d = ~q（经 NOT 反馈）→ 每沿翻转
    const b = new NetlistBuilder();
    b.add('d', 'PIN_IN'); // 使能
    b.add('f', 'DFF');
    b.add('n', 'NOT');
    b.add('m', 'MUX', { width: 1 });
    b.add('q', 'PIN_OUT');
    b.connect(ref('d', 'y'), ref('m', 'sel'));
    b.connect(ref('f', 'q'), ref('m', 'in0'));
    b.connect(ref('f', 'q'), ref('n', 'a'));
    b.connect(ref('n', 'y'), ref('m', 'in1'));
    b.connect(ref('m', 'y'), ref('f', 'd'));
    b.connect(ref('f', 'q'), ref('q', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('d', 'y'), 1); // 使能翻转
    e.tick();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      e.clockEdge();
      e.tick();
      seen.push(e.read(ref('q', 'a')));
    }
    expect(seen).toEqual([1, 0, 1, 0, 1, 0]);
  });
  it('使能关闭时（sel=0）q 保持', () => {
    const b = new NetlistBuilder();
    b.add('d', 'PIN_IN');
    b.add('f', 'DFF');
    b.add('n', 'NOT');
    b.add('m', 'MUX', { width: 1 });
    b.add('q', 'PIN_OUT');
    b.connect(ref('d', 'y'), ref('m', 'sel'));
    b.connect(ref('f', 'q'), ref('m', 'in0'));
    b.connect(ref('f', 'q'), ref('n', 'a'));
    b.connect(ref('n', 'y'), ref('m', 'in1'));
    b.connect(ref('m', 'y'), ref('f', 'd'));
    b.connect(ref('f', 'q'), ref('q', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    e.clockEdge();
    e.tick();
    e.setInput(ref('d', 'y'), 0); // 关闭使能
    e.tick();
    e.clockEdge();
    e.tick();
    e.clockEdge();
    e.tick();
    expect(e.read(ref('q', 'a'))).toBe(1); // 保持
  });
});

describe('registerBehavior：自定义芯片与覆盖', () => {
  it('注册自定义组合芯片并使用', () => {
    const e = createEngine();
    e.registerBehavior('FULLADD', {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'b', dir: 'in', width: 1 },
        { name: 'cin', dir: 'in', width: 1 },
        { name: 'sum', dir: 'out', width: 1 },
        { name: 'cout', dir: 'out', width: 1 },
      ],
      evaluate: (i) => {
        const s = (i['a'] ?? 0) ^ (i['b'] ?? 0) ^ (i['cin'] ?? 0);
        const c =
          ((i['a'] ?? 0) & (i['b'] ?? 0)) | ((i['cin'] ?? 0) & ((i['a'] ?? 0) ^ (i['b'] ?? 0)));
        return { sum: s & 1, cout: c & 1 };
      },
    });
    b_fulladd(e);
    e.setInput(ref('a', 'y'), 1);
    e.setInput(ref('b', 'y'), 1);
    e.setInput(ref('ci', 'y'), 1);
    e.tick();
    expect(e.read(ref('s', 'a'))).toBe(1);
    expect(e.read(ref('co', 'a'))).toBe(1);
  });

  function b_fulladd(e: ReturnType<typeof createEngine>): void {
    e.load({
      components: [
        { id: 'a', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'b', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'ci', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'fa', kind: 'FULLADD', pos: { x: 0, y: 0 }, props: {} },
        { id: 's', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} },
        { id: 'co', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} },
      ],
      wires: [
        { id: 'w1', from: ref('a', 'y'), to: ref('fa', 'a') },
        { id: 'w2', from: ref('b', 'y'), to: ref('fa', 'b') },
        { id: 'w3', from: ref('ci', 'y'), to: ref('fa', 'cin') },
        { id: 'w4', from: ref('fa', 'sum'), to: ref('s', 'a') },
        { id: 'w5', from: ref('fa', 'cout'), to: ref('co', 'a') },
      ],
    });
  }

  it('覆盖内置原语：把 AND 换成 OR 后行为随之改变', () => {
    const e = createEngine();
    e.registerBehavior('AND', {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'b', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ y: (i['a'] ?? 0) | (i['b'] ?? 0) }),
    });
    e.load({
      components: [
        { id: 'a', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'b', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'g', kind: 'AND', pos: { x: 0, y: 0 }, props: {} },
        { id: 'o', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} },
      ],
      wires: [
        { id: 'w1', from: ref('a', 'y'), to: ref('g', 'a') },
        { id: 'w2', from: ref('b', 'y'), to: ref('g', 'b') },
        { id: 'w3', from: ref('g', 'y'), to: ref('o', 'a') },
      ],
    });
    e.setInput(ref('a', 'y'), 0);
    e.setInput(ref('b', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(1); // 覆盖后变成 OR
  });

  it('load 后再 registerBehavior：此前未知 kind 的组件被激活', () => {
    const e = createEngine();
    e.load({
      components: [
        { id: 'a', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'x', kind: 'Mystery', pos: { x: 0, y: 0 }, props: {} },
        { id: 'o', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} },
      ],
      wires: [
        { id: 'w1', from: ref('a', 'y'), to: ref('x', 'a') },
        { id: 'w2', from: ref('x', 'y'), to: ref('o', 'a') },
      ],
    });
    expect(e.diagnostics().some((d) => d.kind === 'unknown-kind')).toBe(true);
    e.registerBehavior('Mystery', {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ y: ((i['a'] ?? 0) + 1) & 1 }),
    });
    expect(e.diagnostics().some((d) => d.kind === 'unknown-kind')).toBe(false);
    e.setInput(ref('a', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0); // a+1 取反
  });

  it('自定义时序芯片（T 触发器）走同一条 clockEdge 通路', () => {
    const e = createEngine();
    e.registerBehavior('TDFF', {
      ports: [
        { name: 't', dir: 'in', width: 1 },
        { name: 'q', dir: 'out', width: 1 },
      ],
      initState: () => ({ q: 0 }),
      evaluate: (_i, s) => ({ q: (s['q'] as number) & 1 }),
      onClockEdge: (i, s) => {
        if ((i['t'] ?? 0) & 1) s['q'] = ((s['q'] as number) ^ 1) & 1;
      },
    });
    e.load({
      components: [
        { id: 't', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} },
        { id: 'f', kind: 'TDFF', pos: { x: 0, y: 0 }, props: {} },
        { id: 'o', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} },
      ],
      wires: [
        { id: 'w1', from: ref('t', 'y'), to: ref('f', 't') },
        { id: 'w2', from: ref('f', 'q'), to: ref('o', 'a') },
      ],
    });
    e.setInput(ref('t', 'y'), 1);
    e.tick();
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      e.clockEdge();
      e.tick();
      seq.push(e.read(ref('o', 'a')));
    }
    expect(seq).toEqual([1, 0, 1, 0]);
  });
});
