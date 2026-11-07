/**
 * Inspector 属性面板：显示/编辑选中组件的 props（key-value）。
 */

import type { Controller } from './Controller.js';

export interface InspectorHandle {
  refresh(): void;
}

export function buildInspector(root: HTMLElement, controller: Controller): InspectorHandle {
  const panel = document.createElement('div');
  panel.className = 'cir-inspector';

  const title = document.createElement('div');
  title.className = 'cir-panel-title';
  title.textContent = '属性';
  panel.appendChild(title);

  const body = document.createElement('div');
  body.className = 'cir-inspector-body';
  panel.appendChild(body);

  root.appendChild(panel);

  function render(): void {
    body.textContent = '';
    const sel = [...controller.doc.selection.components];
    if (sel.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'cir-hint';
      hint.textContent = '未选中组件。点击组件查看属性；点击输入引脚翻转电平。';
      body.appendChild(hint);
      return;
    }
    if (sel.length > 1) {
      const info = document.createElement('div');
      info.className = 'cir-hint';
      info.textContent = '已选中 ' + sel.length + ' 个组件（显示第一个的属性）';
      body.appendChild(info);
    }
    const comp = controller.doc.findComponent(sel[0]!);
    if (!comp) return;

    const head = document.createElement('div');
    head.className = 'cir-comp-head';
    head.textContent = comp.id + ' · ' + comp.kind + ' @ (' + comp.pos.x + ', ' + comp.pos.y + ')';
    body.appendChild(head);

    const keys = Object.keys(comp.props);
    if (keys.length === 0) {
      const none = document.createElement('div');
      none.className = 'cir-hint';
      none.textContent = '（无自定义属性）';
      body.appendChild(none);
    }
    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'cir-prop-row';
      const keySpan = document.createElement('span');
      keySpan.className = 'cir-prop-key';
      keySpan.textContent = key;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = String(comp.props[key]);
      input.addEventListener('change', () => {
        const raw = input.value;
        const num = Number(raw);
        const value: number | string = raw !== '' && Number.isFinite(num) ? num : raw;
        controller.doc.patchComponentProps(comp.id, { [key]: value });
      });
      row.appendChild(keySpan);
      row.appendChild(input);
      body.appendChild(row);
    }
  }

  render();
  return { refresh: render };
}
