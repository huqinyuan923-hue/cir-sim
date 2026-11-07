/**
 * 调色板与语义颜色（值 → 颜色、诊断 → 高亮色）
 */

/** 值语义：1 高电平、0 低电平、-1/其他 = floating（MockEngine 约定） */
export function valueColor(v: number): string {
  if (v === 1) return '#388e3c'; // 绿：高
  if (v === 0) return '#173d1f'; // 墨绿：低
  return '#9e9e9e'; // 灰：floating / 未知
}

export const COLORS = {
  background: '#fafafa',
  gridMinor: 'rgba(0,0,0,0.06)',
  gridMajor: 'rgba(0,0,0,0.14)',
  wireSelected: '#0288d1',
  body: '#ffffff',
  bodyStroke: '#37474f',
  bodyStrokeSelected: '#0288d1',
  label: '#37474f',
  portIn: '#1565c0',
  portOut: '#ef6c00',
  selectionBox: 'rgba(2,136,209,0.9)',
  selectionFill: 'rgba(2,136,209,0.06)',
  marqueeStroke: 'rgba(2,136,209,0.9)',
  marqueeFill: 'rgba(2,136,209,0.08)',
  ghostAlpha: 0.45,
  conflict: '#d32f2f',
  floating: '#9e9e9e',
  oscillation: '#f57c00',
  diagErrorFill: 'rgba(211,47,47,0.18)',
  diagWarnFill: 'rgba(245,124,0,0.14)',
} as const;
