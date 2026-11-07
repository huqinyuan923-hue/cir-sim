/**
 * 网表构建与静态校验诊断测试。
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import { validateNetlist } from '../../src/engine/netlist';
import { PRIMITIVES } from '../../src/engine/primitives';
import type { Diagnostic, Netlist } from '../../src/contract';
import { NetlistBuilder, comp, ref, wire } from './helpers';

const behaviors = new Map(Object.entries(PRIMITIVES));

function validate(n: Netlist): Diagnostic[] {
  return validateNetlist(n, behaviors);
}

function kindsOf(diags: Diagnostic[]): string[] {
  return diags.map((d) => d.kind);
}

describe('静态校验：unknown-kind', () => {
  it('未知 kind 报 error 诊断', () => {
    const diags = validate({
      components: [comp('a', 'PIN_IN'), comp('x', 'Clockwork')],
      wires: [],
    });
    const d = diags.find((x) => x.kind === 'unknown-kind');
    expect(d).toBeDefined();
    expect(d!.level).toBe('error');
    expect(d!.componentIds).toEqual(['x']);
  });

  it('未知 kind 的组件保持惰性：指向它的连线报断线，其余电路不受影响', () => {
    const e = createEngine();
    e.load({
      components: [
        comp('a', 'PIN_IN'),
        comp('x', 'Mystery'),
        comp('g', 'NOT'),
        comp('o', 'PIN_OUT'),
      ],
      wires: [
        wire('w1', { c: 'a', p: 'y' }, { c: 'x', p: 'a' }), // 端点不存在
        wire('w2', { c: 'a', p: 'y' }, { c: 'g', p: 'a' }), // 正常
        wire('w3', { c: 'g', p: 'y' }, { c: 'o', p: 'a' }),
      ],
    });
    const ks = kindsOf(e.diagnostics());
    expect(ks).toContain('unknown-kind');
    expect(ks).toContain('floating');
    e.setInput(ref('a', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0); // NOT(1) = 0
  });
});

describe('静态校验：id 与连线', () => {
  it('重复组件 id 报 conflict（error），保留首个定义', () => {
    const diags = validate({
      components: [comp('g', 'AND', { width: 1 }), comp('g', 'OR', { width: 4 })],
      wires: [],
    });
    const d = diags.find((x) => x.kind === 'conflict');
    expect(d).toBeDefined();
    expect(d!.level).toBe('error');
  });

  it('重复 id 时首个定义生效（宽度为 1 而非 4）', () => {
    const e = createEngine();
    e.load({
      components: [
        comp('pin', 'PIN_IN', { width: 4 }),
        comp('g', 'AND', { width: 1 }),
        comp('g', 'NOT', { width: 4 }),
        comp('o', 'PIN_OUT', { width: 4 }),
      ],
      wires: [
        wire('w1', { c: 'pin', p: 'y' }, { c: 'g', p: 'a' }),
        wire('w2', { c: 'pin', p: 'y' }, { c: 'g', p: 'b' }),
        wire('w3', { c: 'g', p: 'y' }, { c: 'o', p: 'a' }),
      ],
    });
    e.setInput(ref('pin', 'y'), 0b1010);
    e.tick();
    // 保留的 AND(1 位)：0b1010 & 0b1010 = 0b1010，掩码 1 位 → 0
    expect(e.read(ref('o', 'a'))).toBe(0);
  });

  it('连线端点引用未知组件 → floating（error）', () => {
    const diags = validate({
      components: [comp('a', 'PIN_IN')],
      wires: [wire('w1', { c: 'a', p: 'y' }, { c: 'ghost', p: 'y' })],
    });
    const d = diags.find((x) => x.kind === 'floating');
    expect(d).toBeDefined();
    expect(d!.level).toBe('error');
    expect(d!.wireIds).toEqual(['w1']);
  });

  it('连线端点引用未知端口 → floating（error）', () => {
    const diags = validate({
      components: [comp('a', 'PIN_IN'), comp('g', 'AND')],
      wires: [wire('w1', { c: 'a', p: 'y' }, { c: 'g', p: 'c' })],
    });
    expect(kindsOf(diags)).toContain('floating');
  });

  it('自环连线（两端同一端口）→ floating（warning），无连接效果', () => {
    const diags = validate({
      components: [comp('a', 'PIN_IN')],
      wires: [wire('w1', { c: 'a', p: 'y' }, { c: 'a', p: 'y' })],
    });
    const d = diags.find((x) => x.kind === 'floating');
    expect(d).toBeDefined();
    expect(d!.level).toBe('warning');
  });

  it('重复连线 id → conflict（warning）', () => {
    const diags = validate({
      components: [comp('a', 'PIN_IN'), comp('o', 'PIN_OUT')],
      wires: [
        wire('w1', { c: 'a', p: 'y' }, { c: 'o', p: 'a' }),
        wire('w1', { c: 'a', p: 'y' }, { c: 'o', p: 'a' }),
      ],
    });
    const d = diags.find((x) => x.kind === 'conflict');
    expect(d).toBeDefined();
    expect(d!.level).toBe('warning');
  });

  it('同一端口允许多条连线（扇出/扇入合法）', () => {
    const diags = validate({
      components: [
        comp('p', 'PIN_IN'),
        comp('g1', 'AND'),
        comp('g2', 'OR'),
        comp('o', 'PIN_OUT'),
      ],
      wires: [
        wire('w1', { c: 'p', p: 'y' }, { c: 'g1', p: 'a' }),
        wire('w2', { c: 'p', p: 'y' }, { c: 'g1', p: 'b' }),
        wire('w3', { c: 'p', p: 'y' }, { c: 'g2', p: 'a' }),
        wire('w6', { c: 'p', p: 'y' }, { c: 'g2', p: 'b' }),
        wire('w4', { c: 'g1', p: 'y' }, { c: 'o', p: 'a' }),
        wire('w5', { c: 'g2', p: 'y' }, { c: 'o', p: 'a' }),
      ],
    });
    // 只有 g2 输出与 g1 输出同 net（线与）；p 有驱动，无 floating
    expect(diags.filter((d) => d.kind === 'floating' && d.level === 'warning')).toHaveLength(0);
  });
});

describe('静态校验：floating', () => {
  it('无任何驱动的 net → floating（warning）', () => {
    const diags = validate({
      components: [comp('g1', 'AND'), comp('g2', 'OR')],
      wires: [wire('w1', { c: 'g1', p: 'y' }, { c: 'g2', p: 'a' })],
    });
    // g1.y — g2.a：g1.y 是驱动 → 不 floating；g1.a/g1.b/g2.b 单端口 net 无驱动 → floating
    const floats = diags.filter((d) => d.kind === 'floating' && d.level === 'warning');
    expect(floats.length).toBe(3);
  });

  it('PIN_IN 是驱动：pin→out 的 net 不 floating', () => {
    const diags = validate({
      components: [comp('p', 'PIN_IN'), comp('o', 'PIN_OUT')],
      wires: [wire('w1', { c: 'p', p: 'y' }, { c: 'o', p: 'a' })],
    });
    expect(diags).toHaveLength(0);
  });

  it('干净网表零诊断', () => {
    const b = new NetlistBuilder();
    b.add('a', 'PIN_IN');
    b.add('b', 'PIN_IN');
    b.add('g', 'AND');
    b.add('o', 'PIN_OUT');
    b.connect(ref('a', 'y'), ref('g', 'a'));
    b.connect(ref('b', 'y'), ref('g', 'b'));
    b.connect(ref('g', 'y'), ref('o', 'a'));
    expect(validate(b.build())).toHaveLength(0);
  });
});
