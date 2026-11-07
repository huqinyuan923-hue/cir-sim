/**
 * M5 测试 · 存档 IO（序列化 round-trip / 上传下载注入桩 / localStorage）
 */
import { describe, expect, it } from 'vitest';
import { parseNetlist, roundTripEqual, serializeNetlist } from '../../src/canvas/io/serialize.js';
import {
  browserDownloadEnv,
  browserUploadEnv,
  clearLocal,
  downloadNetlist,
  loadLocal,
  saveLocal,
  uploadNetlist,
} from '../../src/canvas/io/fileio.js';
import type { DownloadEnv, KeyValueStorage, UploadEnv } from '../../src/canvas/io/fileio.js';
import type { Netlist } from '../../src/canvas/contract.js';

const SAMPLE: Netlist = {
  components: [
    { id: 'c1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: { label: '开关' } },
    { id: 'c2', kind: 'AND', pos: { x: 100, y: 40 }, props: {} },
  ],
  wires: [{ id: 'w1', from: { componentId: 'c1', port: 'OUT' }, to: { componentId: 'c2', port: 'A' } }],
};

describe('serializeNetlist / parseNetlist', () => {
  it('round-trip 无损（含中文属性与空 props）', () => {
    expect(roundTripEqual(SAMPLE)).toBe(true);
  });

  it('空网表 round-trip', () => {
    expect(roundTripEqual({ components: [], wires: [] })).toBe(true);
  });

  it('负坐标与 0 坐标 round-trip', () => {
    const nl: Netlist = {
      components: [{ id: 'c1', kind: 'OR', pos: { x: -40, y: -20 }, props: {} }],
      wires: [],
    };
    expect(roundTripEqual(nl)).toBe(true);
  });

  it('大数值精度保留', () => {
    const nl: Netlist = {
      components: [{ id: 'c1', kind: 'OR', pos: { x: 123456, y: 7890 }, props: { n: 1e12 } }],
      wires: [],
    };
    expect(roundTripEqual(nl)).toBe(true);
  });

  it('拒绝非 JSON 文本', () => {
    const r = parseNetlist('not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON 解析失败');
  });

  it('拒绝顶层非对象', () => {
    expect(parseNetlist('[1,2]').ok).toBe(false);
    expect(parseNetlist('42').ok).toBe(false);
  });

  it('拒绝缺少数组字段', () => {
    expect(parseNetlist('{"components":[]}').ok).toBe(false);
  });

  it('拒绝非法 pos（字符串坐标 / 非有限数）', () => {
    expect(parseNetlist('{"components":[{"id":"c1","kind":"AND","pos":{"x":"a","y":0},"props":{}}],"wires":[]}').ok).toBe(false);
    expect(
      parseNetlist('{"components":[{"id":"c1","kind":"AND","pos":{"x":1e999,"y":0},"props":{}}],"wires":[]}').ok,
    ).toBe(false);
  });

  it('拒绝重复组件 id', () => {
    const text = JSON.stringify({
      components: [
        { id: 'c1', kind: 'AND', pos: { x: 0, y: 0 }, props: {} },
        { id: 'c1', kind: 'OR', pos: { x: 1, y: 1 }, props: {} },
      ],
      wires: [],
    });
    const r = parseNetlist(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('重复');
  });

  it('拒绝非法 props 值类型', () => {
    const text = JSON.stringify({
      components: [{ id: 'c1', kind: 'AND', pos: { x: 0, y: 0 }, props: { bad: [1] } }],
      wires: [],
    });
    expect(parseNetlist(text).ok).toBe(false);
  });

  it('拒绝连线引用缺字段', () => {
    const text = JSON.stringify({
      components: [],
      wires: [{ id: 'w1', from: { componentId: 'c1' }, to: { componentId: 'c2', port: 'A' } }],
    });
    expect(parseNetlist(text).ok).toBe(false);
  });
});

describe('downloadNetlist（注入桩）', () => {
  it('生成 Blob 下载并回收 URL，文件名带日期与扩展名', () => {
    const captured: { url: string; filename: string }[] = [];
    const env: DownloadEnv = {
      createObjectURL(blob) {
        return 'blob:fake-1';
      },
      revokeObjectURL(url) {
        captured.push({ url: `revoked:${url}`, filename: '' });
      },
      triggerDownload(url, filename) {
        captured.push({ url, filename });
      },
    };
    const name = downloadNetlist(SAMPLE, env);
    expect(name.endsWith('.cir.json')).toBe(true);
    expect(captured.some((c) => c.filename === name)).toBe(true);
    expect(captured.some((c) => c.url === 'revoked:blob:fake-1')).toBe(true);
  });

  it('下载内容与序列化一致（Blob 可回读）', async () => {
    let captured: Blob | null = null;
    const env: DownloadEnv = {
      createObjectURL(blob) {
        captured = blob;
        return 'blob:x';
      },
      revokeObjectURL() {},
      triggerDownload() {},
    };
    downloadNetlist(SAMPLE, env);
    expect(captured).not.toBeNull();
    const text = await captured!.text();
    const r = parseNetlist(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.netlist.components).toHaveLength(2);
  });
});

describe('uploadNetlist（注入桩）', () => {
  it('合法文件 → ok + netlist', async () => {
    const env: UploadEnv = { readAsText: async () => serializeNetlist(SAMPLE) };
    const r = await uploadNetlist(new File([serializeNetlist(SAMPLE)], 'x.cir.json'), env);
    expect(r.ok).toBe(true);
  });

  it('非法内容 → error', async () => {
    const env: UploadEnv = { readAsText: async () => 'garbage' };
    const r = await uploadNetlist(new File(['garbage'], 'x.cir.json'), env);
    expect(r.ok).toBe(false);
  });

  it('读取失败 → error', async () => {
    const env: UploadEnv = { readAsText: async () => Promise.reject(new Error('disk error')) };
    const r = await uploadNetlist(new File([], 'x'), env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('读取失败');
  });

  it('browserUploadEnv 用 FileReader（构造 File 对象直测）', async () => {
    const file = new File([serializeNetlist(SAMPLE)], 'a.cir.json', { type: 'application/json' });
    const r = await uploadNetlist(file, browserUploadEnv);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.netlist.components).toHaveLength(2);
  });
});

describe('localStorage 自动保存（注入桩存储）', () => {
  function fakeStorage(): KeyValueStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  }

  it('saveLocal → loadLocal round-trip', () => {
    const s = fakeStorage();
    expect(saveLocal(SAMPLE, s)).toBe(true);
    const back = loadLocal(s);
    expect(back).not.toBeNull();
    expect(back!.components).toEqual(SAMPLE.components);
    expect(back!.wires).toEqual(SAMPLE.wires);
  });

  it('损坏存档 loadLocal 返回 null 而非抛错', () => {
    const s = fakeStorage();
    s.setItem('cir-canvas.autosave', '{broken');
    expect(loadLocal(s)).toBeNull();
  });

  it('空存储返回 null', () => {
    expect(loadLocal(fakeStorage())).toBeNull();
  });

  it('clearLocal 清除', () => {
    const s = fakeStorage();
    saveLocal(SAMPLE, s);
    clearLocal(s);
    expect(loadLocal(s)).toBeNull();
  });

  it('隐私模式写入失败静默返回 false', () => {
    const throwing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(saveLocal(SAMPLE, throwing)).toBe(false);
  });
});
