/**
 * 浏览器入口：装配 NetlistDoc / MockEngine / SimController / CanvasView / Controller
 * 与四个面板（工具栏/控制条/Inspector/状态条），挂接存档按钮。
 */

import { MockEngine } from './mock/MockEngine.js';
import { SimController } from './sim/SimController.js';
import { NetlistDoc } from './state/doc.js';
import { CanvasView } from './ui/CanvasView.js';
import { Controller } from './ui/Controller.js';
import { buildToolbar, type ToolbarHandle } from './ui/toolbar.js';
import { buildInspector, type InspectorHandle } from './ui/inspector.js';
import { buildControlBar, type ControlBarHandle } from './ui/controlbar.js';
import { buildStatusbar, type StatusbarHandle } from './ui/statusbar.js';
import { downloadNetlist, uploadNetlist, browserUploadEnv } from './io/fileio.js';
import { loadLocal } from './io/fileio.js';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error('缺少元素 #' + id);
  return node;
}

function boot(): void {
  const doc = new NetlistDoc(loadLocal() ?? { components: [], wires: [] });
  const sim = new SimController(new MockEngine());
  const canvas = el('cir-canvas') as HTMLCanvasElement;
  const view = new CanvasView(canvas);

  let toolbar: ToolbarHandle;
  let inspector: InspectorHandle;
  let controlbar: ControlBarHandle;
  let statusbar: StatusbarHandle;

  const controller = new Controller(doc, sim, view, {
    onStatus: (msg) => statusbar.setMessage(msg),
    onSelectionChanged: () => {
      inspector.refresh();
      statusbar.refresh();
    },
    onToolChanged: (kind) => toolbar.setActive(kind),
    onSimEvent: () => {
      controlbar.refresh();
      statusbar.refresh();
    },
  });

  toolbar = buildToolbar(el('cir-toolbar'), controller);
  inspector = buildInspector(el('cir-inspector'), controller);
  controlbar = buildControlBar(el('cir-control'), controller);
  statusbar = buildStatusbar(el('cir-status'), controller);
  statusbar.refresh();

  // 存档按钮
  el('cir-save').addEventListener('click', () => {
    downloadNetlist(doc.netlist);
    statusbar.setMessage('已下载存档 JSON');
  });

  el('cir-load').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void uploadNetlist(file, browserUploadEnv).then((r) => {
        if (r.ok) {
          doc.commit(r.netlist);
          statusbar.setMessage('存档已载入');
        } else {
          statusbar.setMessage('载入失败：' + r.error);
        }
      });
    });
    input.click();
  });

  el('cir-clear').addEventListener('click', () => {
    doc.commit({ components: [], wires: [] });
    statusbar.setMessage('画布已清空');
  });

  // 面板与诊断的联动刷新（文档变更也可能影响诊断摘要）
  doc.onChange(() => {
    inspector.refresh();
    statusbar.refresh();
  });
}

boot();
