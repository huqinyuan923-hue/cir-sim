/**
 * 仿真控制条：单步 tick / 时钟沿 edge / 复位 reset / 运行暂停 run / 调速。
 */

import type { Controller } from './Controller.js';
import type { SpeedFactor } from '../sim/SimController.js';

export interface ControlBarHandle {
  refresh(): void;
}

export function buildControlBar(root: HTMLElement, controller: Controller): ControlBarHandle {
  const bar = document.createElement('div');
  bar.className = 'cir-controlbar';

  const mkBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };

  mkBtn('单步', '组合传播至稳定（tick）', () => {
    controller.sim.tick();
  });
  mkBtn('时钟沿', '所有 DFF 采样（clockEdge）', () => {
    controller.sim.clockEdge();
  });
  mkBtn('复位', '清时序状态并重算（reset）', () => {
    controller.sim.reset();
  });
  const runBtn = mkBtn('运行', '60Hz 定时 tick+edge（可调速）', () => {
    if (controller.sim.running) controller.sim.pause();
    else controller.sim.run();
  });

  const speedSel = document.createElement('select');
  speedSel.title = '运行速度倍率';
  for (const s of [0.5, 1, 2, 4] as const) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = s + '×';
    speedSel.appendChild(opt);
  }
  speedSel.addEventListener('change', () => {
    controller.sim.setSpeed(Number(speedSel.value) as SpeedFactor);
  });
  bar.appendChild(speedSel);

  const tickInfo = document.createElement('span');
  tickInfo.className = 'cir-tick-info';
  bar.appendChild(tickInfo);

  root.appendChild(bar);

  function refresh(): void {
    runBtn.textContent = controller.sim.running ? '暂停' : '运行';
    const lt = controller.sim.lastTick;
    if (lt === null) {
      tickInfo.textContent = '';
      return;
    }
    const state = lt.oscillated ? '振荡!' : lt.stable ? '稳定' : '未稳定';
    tickInfo.textContent = 'tick: ' + state + ' · ' + lt.steps + ' 步';
    if (lt.oscillated) tickInfo.classList.add('oscillating');
    else tickInfo.classList.remove('oscillating');
  }

  refresh();
  return { refresh };
}
