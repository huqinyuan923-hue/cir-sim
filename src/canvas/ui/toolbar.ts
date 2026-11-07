/**
 * 工具栏：选择工具 + 组件放置工具（快捷键 1-9）。
 */

import { listShapeKinds, getShape } from '../model/shapes.js';
import type { Controller } from './Controller.js';
import { SELECT_TOOL } from './Controller.js';

export interface ToolbarHandle {
  setActive(kind: string | null): void;
}

export function buildToolbar(root: HTMLElement, controller: Controller): ToolbarHandle {
  const bar = document.createElement('div');
  bar.className = 'cir-toolbar';

  const buttons = new Map<string, HTMLButtonElement>();

  const selectBtn = document.createElement('button');
  selectBtn.textContent = '1 选择';
  selectBtn.title = '选择/移动/框选（快捷键 1）';
  buttons.set(SELECT_TOOL, selectBtn);
  bar.appendChild(selectBtn);

  const kinds = listShapeKinds().slice(0, 8);
  kinds.forEach((kind, i) => {
    const btn = document.createElement('button');
    const def = getShape(kind);
    btn.textContent = i + 2 + ' ' + def.label;
    btn.title = '放置 ' + kind + '（快捷键 ' + (i + 2) + '）';
    buttons.set(kind, btn);
    bar.appendChild(btn);
  });

  const apply = (kind: string | null): void => {
    controller.setTool(kind);
  };

  for (const [key, btn] of buttons) {
    btn.addEventListener('click', () => {
      apply(key === SELECT_TOOL ? null : key);
    });
  }

  root.appendChild(bar);

  const setActive = (kind: string | null): void => {
    const active = kind === null ? SELECT_TOOL : kind;
    for (const [key, btn] of buttons) {
      if (key === active) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  };
  setActive(null);
  return { setActive };
}
