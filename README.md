# cir-main

Logisim 风格可视化电路仿真器 · **第三部：芯片库与 Hack 集成**（纯 TypeScript、零运行时依赖、静态部署）。

- 任务书：`C:\works\cir-sim\第三部-芯片库与Hack集成任务书.md`
- 契约：`src/contract.ts`（冻结，三部字节一致）
- 实现报告：[REPORT.md](./REPORT.md)（对拍结果表、性能基准、集成记录、部署方案）
- 偏差记录：[README-偏差记录.md](./README-偏差记录.md)（14 条语义决策）
- 集成等待说明：见 INTEGRATION-WAIT.md（引擎已集成；画布待第二部交付）

## 快速开始

```bash
npm install
npm test            # 477 个测试全绿（本部 58 + 引擎 165 + 画布 254）
npm run typecheck   # TS strict 无错（三部源码同一配置）
npm run bench       # 三方性能基准（串行）：Hack 64.5k 周期/秒，帧当量 0.0155ms
npm run test:long   # 可选长测：tetris 与官方行为核逐字节差分（TETRIS_DIFF=1）
npm run build       # esbuild 单页打包 → dist/
npm run serve       # 本地预览 http://127.0.0.1:8080
```

## 本部职责

- **芯片库**（`src/chips/`，31 个 kind）：16 位算术全集、ALU、寄存器/PC、RAM 系列、
  ROM32K、SCREEN/KEYBOARD、MEMDECODE 地址译码器——全部经 `registerBehavior` 注册，
  nand-computer 黄金向量逐一对拍。
- **子电路展开器**（`src/expand/`）：复合芯片 = 网表模板 + PIN_IN/PIN_OUT 边界，
  递归扁平化 + 循环检测 + 边界对位校验。
- **Hack 总装**（`src/hack/`）：CPU 子电路模板 + 内存映射（RAM16K / SCREEN / KBD /
  ROM32K）→ `expand()` 扁平化 → 引擎整机运行；4 个 demo 程序（含 tetris）。
- **示例页**（`src/web/` + `index.html`）：Hack 屏幕帧缓冲渲染 + **电路画布**（cir-canvas
  渲染整机 53 组件网表，连线值实时着色）+ demo 菜单（弹跳方块 / tetris / 键盘回显 / 求和）
  + 键盘注入 + 机器状态面板；esbuild 单页打包，GitHub Pages 方案见 REPORT §7。

## 公开 API（常用）

```ts
import { createEngine } from './src/engine/createEngine';   // 第一部引擎（M5 集成）
import { registerChipLibrary } from './src/chips/registerAll';
import { expand } from './src/expand/expand';
import { HackMachine, buildComputerNetlist } from './src/hack/computer';
import { parseHack } from './src/hack/rom';
import { getScreen, screenPixel } from './src/chips/handles';

const machine = new HackMachine(createEngine(), { program: '...hack 文本' });
machine.setKbd(65);       // 键盘注入（SPEC 键码）
machine.cycle();          // 一个 Hack 周期（tick → 上升沿 → tick）
machine.screen.words;     // 8192 个屏幕字（w = y*32 + (x>>4)，位 15-(x&15)）
machine.ramValue(16);     // RAM 读出
```
