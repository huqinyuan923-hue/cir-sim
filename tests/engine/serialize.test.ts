/**
 * 序列化测试：round-trip 无损、结构容错、幂等性。
 * 大规模随机 round-trip 属性测试在 fuzz.test.ts（500 次）。
 */

import { describe, expect, it } from 'vitest';
import { parseNetlist, serializeNetlist } from '../../src/engine/serialize';
import { createEngine } from '../../src/engine/createEngine';
import type { Netlist } from '../../src/contract';
import { NetlistBuilder, ref } from './helpers';

function sampleNetlist(): Netlist {
  const b = new NetlistBuilder();
  b.add('a', 'PIN_IN', { width: 4 });
  b.add('b', 'PIN_IN');
  b.add('g', 'AND', { width: 4 });
  b.add('m', 'MUX', { width: 4 });
  b.add('f', 'DFF');
  b.add('sp', 'SPLIT', { width: 4, index: 2 });
  b.add('jn', 'JOIN', { width: 4, high: 3 });
  b.add('k', 'CONST', { value: 9 });
  b.add('o', 'PIN_OUT', { width: 4 });
  b.connect(ref('a', 'y'), ref('g', 'a'));
  b.connect(ref('b', 'y'), ref('g', 'b'));
  b.connect(ref('g', 'y'), ref('m', 'in0'));
  b.connect(ref('k', 'y'), ref('m', 'in1'));
  b.connect(ref('m', 'y'), ref('sp', 'bus'));
  b.connect(ref('f', 'q'), ref('jn', 'bit'));
  b.connect(ref('sp', 'bit'), ref('o', 'a'));
  return b.build();
}

describe('serializeNetlist / parseNetlist', () => {
  it('round-trip 无损（结构等值）', () => {
    const n = sampleNetlist();
    const { netlist, diagnostics } = parseNetlist(serializeNetlist(n));
    expect(diagnostics).toHaveLength(0);
    expect(netlist).toEqual(n);
  });

  it('round-trip 幂等：二次序列化结果一致', () => {
    const n = sampleNetlist();
    const s1 = serializeNetlist(n);
    const parsed = parseNetlist(s1).netlist!;
    expect(serializeNetlist(parsed)).toBe(s1);
  });

  it('load → serialize → parse → load：语义等值', () => {
    const n = sampleNetlist();
    const e1 = createEngine();
    e1.load(n);
    e1.setInput(ref('a', 'y'), 0xa);
    e1.setInput(ref('b', 'y'), 0xf);
    e1.tick();

    const s = serializeNetlist(n);
    const e2 = createEngine();
    e2.load(parseNetlist(s).netlist!);
    e2.setInput(ref('a', 'y'), 0xa);
    e2.setInput(ref('b', 'y'), 0xf);
    e2.tick();

    expect(e2.read(ref('o', 'a'))).toBe(e1.read(ref('o', 'a')));
    expect(e2.read(ref('sp', 'bit'))).toBe(e1.read(ref('sp', 'bit')));
  });

  it('引擎深拷贝：load 后外部修改原网表不影响仿真', () => {
    const n = sampleNetlist();
    const e = createEngine();
    e.load(n);
    n.components[2]!.kind = 'OR'; // 破坏原对象
    e.setInput(ref('a', 'y'), 0xa);
    e.setInput(ref('b', 'y'), 0xf);
    e.tick();
    // 引擎里仍是 AND：0xa & 0xf = 0xa，经 MUX(in0) → SPLIT bit2 = 0
    expect(e.read(ref('o', 'a'))).toBe(0);
  });

  it('非法 JSON：诊断而不抛异常', () => {
    const { netlist, diagnostics } = parseNetlist('{not json');
    expect(netlist).toBeNull();
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.level).toBe('error');
  });

  it('缺 components 数组：诊断', () => {
    const { netlist, diagnostics } = parseNetlist('{"wires":[]}');
    expect(netlist).toBeNull();
    expect(diagnostics[0]!.kind).toBe('unknown-kind');
  });

  it('缺 wires 数组：诊断', () => {
    const { netlist, diagnostics } = parseNetlist('{"components":[]}');
    expect(netlist).toBeNull();
    expect(diagnostics.length).toBe(1);
  });

  it('顶层不是对象：诊断', () => {
    const { netlist } = parseNetlist('[1,2,3]');
    expect(netlist).toBeNull();
  });

  it('组件字段缺失：该组件被跳过并诊断，其余照常解析', () => {
    const { netlist, diagnostics } = parseNetlist(
      JSON.stringify({
        components: [
          { id: 'ok', kind: 'AND', pos: { x: 1, y: 2 }, props: {} },
          { id: 'bad', kind: 'AND' },
        ],
        wires: [],
      }),
    );
    expect(diagnostics.length).toBe(1);
    expect(netlist!.components).toHaveLength(1);
    expect(netlist!.components[0]!.id).toBe('ok');
  });

  it('props 中的非法值类型被丢弃（仅保留 number/string）', () => {
    const { netlist, diagnostics } = parseNetlist(
      JSON.stringify({
        components: [
          { id: 'k', kind: 'CONST', pos: { x: 0, y: 0 }, props: { value: 5, weird: true, obj: {} } },
        ],
        wires: [],
      }),
    );
    expect(diagnostics).toHaveLength(0);
    expect(netlist!.components[0]!.props).toEqual({ value: 5 });
  });

  it('pos 缺失：诊断并跳过该组件', () => {
    const { netlist, diagnostics } = parseNetlist(
      JSON.stringify({
        components: [{ id: 'k', kind: 'CONST', props: {} }],
        wires: [],
      }),
    );
    expect(diagnostics).toHaveLength(1);
    expect(netlist!.components).toHaveLength(0);
  });

  it('连线端点结构非法：诊断并跳过该连线', () => {
    const { netlist, diagnostics } = parseNetlist(
      JSON.stringify({
        components: [{ id: 'k', kind: 'CONST', pos: { x: 0, y: 0 }, props: {} }],
        wires: [{ id: 'w1', from: { componentId: 'k' }, to: { componentId: 'k', port: 'y' } }],
      }),
    );
    expect(diagnostics).toHaveLength(1);
    expect(netlist!.wires).toHaveLength(0);
  });

  it('空网表 round-trip', () => {
    const n: Netlist = { components: [], wires: [] };
    const { netlist, diagnostics } = parseNetlist(serializeNetlist(n));
    expect(diagnostics).toHaveLength(0);
    expect(netlist).toEqual(n);
  });

  it('字符串形式的数字 props 在 round-trip 中原样保留', () => {
    const n: Netlist = {
      components: [
        { id: 'k', kind: 'CONST', pos: { x: 0, y: 0 }, props: { value: '42' } },
      ],
      wires: [],
    };
    const { netlist, diagnostics } = parseNetlist(serializeNetlist(n));
    expect(diagnostics).toHaveLength(0);
    expect(netlist).toEqual(n);
  });
});
