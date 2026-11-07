/**
 * 状态条：操作反馈 + 诊断摘要 + 视图信息。
 */

import type { Controller } from './Controller.js';

export interface StatusbarHandle {
  setMessage(msg: string): void;
  refresh(): void;
}

export function buildStatusbar(root: HTMLElement, controller: Controller): StatusbarHandle {
  const bar = document.createElement('div');
  bar.className = 'cir-statusbar';

  const message = document.createElement('span');
  message.className = 'cir-status-msg';
  message.textContent = '就绪 · 空格拖拽平移 · 滚轮缩放 · 数字键切换工具';

  const diag = document.createElement('span');
  diag.className = 'cir-status-diag';

  const viewInfo = document.createElement('span');
  viewInfo.className = 'cir-status-view';

  bar.appendChild(message);
  bar.appendChild(diag);
  bar.appendChild(viewInfo);
  root.appendChild(bar);

  let msgTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    setMessage(msg: string): void {
      message.textContent = msg;
      if (msgTimer !== null) clearTimeout(msgTimer);
      msgTimer = setTimeout(() => {
        message.textContent = '就绪';
      }, 3000);
    },
    refresh(): void {
      const diags = controller.sim.diagnostics();
      const errors = diags.filter((d) => d.level === 'error').length;
      const warns = diags.length - errors;
      diag.textContent = '诊断: ' + errors + ' 错误 / ' + warns + ' 警告';
      diag.classList.toggle('has-error', errors > 0);
      viewInfo.textContent = 'zoom ' + controller.view.zoom.toFixed(2) + '× · ' + controller.doc.netlist.components.length + ' 组件';
    },
  };
}
