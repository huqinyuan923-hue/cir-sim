/**
 * M1 几何测试 · 视图变换（pan/zoom 到像素）
 */
import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  panForZoomAt,
  screenToWorld,
  worldToScreen,
} from '../../src/canvas/geometry/view.js';

describe('clampZoom', () => {
  it('范围内不变', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.5)).toBe(0.5);
    expect(clampZoom(3)).toBe(3);
  });

  it('越界钳制', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
  });

  it('边界值保留', () => {
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
  });

  it('非有限回退最小', () => {
    expect(clampZoom(NaN)).toBe(ZOOM_MIN);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
    expect(clampZoom(-Infinity)).toBe(ZOOM_MIN);
  });

  it('自定义范围', () => {
    expect(clampZoom(2, 0.5, 1.5)).toBe(1.5);
    expect(clampZoom(0.2, 0.5, 1.5)).toBe(0.5);
  });
});

describe('worldToScreen / screenToWorld 往返', () => {
  it('恒等变换（pan=0, zoom=1）', () => {
    const p = { x: 123, y: 456 };
    expect(worldToScreen(p, { x: 0, y: 0 }, 1)).toEqual(p);
    expect(screenToWorld(p, { x: 0, y: 0 }, 1)).toEqual(p);
  });

  it('平移', () => {
    const s = worldToScreen({ x: 10, y: 20 }, { x: 100, y: 200 }, 1);
    expect(s).toEqual({ x: 110, y: 220 });
    expect(screenToWorld(s, { x: 100, y: 200 }, 1)).toEqual({ x: 10, y: 20 });
  });

  it('缩放', () => {
    const s = worldToScreen({ x: 10, y: 10 }, { x: 0, y: 0 }, 2);
    expect(s).toEqual({ x: 20, y: 20 });
    expect(screenToWorld(s, { x: 0, y: 0 }, 2)).toEqual({ x: 10, y: 10 });
  });

  it('平移 + 缩放往返（随机抽样）', () => {
    const cases = [
      { p: { x: 37, y: -11 }, pan: { x: 55, y: -80 }, zoom: 1.75 },
      { p: { x: -200, y: 640 }, pan: { x: 1000, y: 1000 }, zoom: 0.4 },
      { p: { x: 0, y: 0 }, pan: { x: -30, y: 70 }, zoom: 3.2 },
    ];
    for (const c of cases) {
      const s = worldToScreen(c.p, c.pan, c.zoom);
      const w = screenToWorld(s, c.pan, c.zoom);
      expect(w.x).toBeCloseTo(c.p.x, 10);
      expect(w.y).toBeCloseTo(c.p.y, 10);
    }
  });

  it('负坐标往返', () => {
    const p = { x: -80, y: -120 };
    const s = worldToScreen(p, { x: 40, y: 50 }, 0.75);
    const w = screenToWorld(s, { x: 40, y: 50 }, 0.75);
    expect(w.x).toBeCloseTo(p.x, 10);
    expect(w.y).toBeCloseTo(p.y, 10);
  });

  it('zoom 0.2 与 5 的往返仍精确到 1e-9', () => {
    for (const z of [ZOOM_MIN, ZOOM_MAX]) {
      const p = { x: 300, y: -700 };
      const w = screenToWorld(worldToScreen(p, { x: 12, y: 34 }, z), { x: 12, y: 34 }, z);
      expect(w.x).toBeCloseTo(p.x, 9);
      expect(w.y).toBeCloseTo(p.y, 9);
    }
  });
});

describe('panForZoomAt 锚点缩放', () => {
  it('锚点世界坐标保持不动', () => {
    const pan = { x: 100, y: 50 };
    const zoom = 1;
    const anchor = { x: 300, y: 200 };
    const world = screenToWorld(anchor, pan, zoom);
    const pan2 = panForZoomAt(anchor, world, 2);
    const world2 = screenToWorld(anchor, pan2, 2);
    expect(world2.x).toBeCloseTo(world.x, 10);
    expect(world2.y).toBeCloseTo(world.y, 10);
  });

  it('pan 公式直验', () => {
    // world=(10,10), anchor=(150,150), zoom'=2 → pan = (150-20, 150-20)
    expect(panForZoomAt({ x: 150, y: 150 }, { x: 10, y: 10 }, 2)).toEqual({
      x: 130,
      y: 130,
    });
  });

  it('缩小时锚点仍不动', () => {
    const anchor = { x: 400, y: 300 };
    const world = { x: 100, y: 80 };
    const pan2 = panForZoomAt(anchor, world, 0.5);
    const back = screenToWorld(anchor, pan2, 0.5);
    expect(back.x).toBeCloseTo(100, 10);
    expect(back.y).toBeCloseTo(80, 10);
  });

  it('zoom=1 时 pan = anchor - world', () => {
    expect(panForZoomAt({ x: 500, y: 400 }, { x: 120, y: 90 }, 1)).toEqual({
      x: 380,
      y: 310,
    });
  });
});
