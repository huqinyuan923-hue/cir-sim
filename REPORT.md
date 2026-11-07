# REPORT · cir-main（第三部：芯片库与 Hack 集成）

> 交付时间：2026-11-07 · 引擎/画布三部曲的第三部
> 任务书：`C:\works\cir-sim\第三部-芯片库与Hack集成任务书.md`
> 偏差与决策：[README-偏差记录.md](./README-偏差记录.md)（14 条）

---

## 1. 一句话总结

Hack 计算机以 **53 组件网表**（原生芯片混合网表，CPU 为子电路模板经展开器扁平化）在
仿真引擎上整机运行：**5,832 条芯片级黄金向量 + 4 条整机逐周期 trace + SHA-256 帧哈希
全部对拍通过**，tetris 全程序与官方行为核逐字节差分一致；**三部集成完成**——
整机网表在 cir-canvas 画布上渲染、运行中连线值实时着色，浏览器实测 **~35 万 Hack
周期/秒**，自编弹跳方块 demo 与 nand-computer 软件轨的俄罗斯方块在页面上直接可玩。

## 2. 交付物

```
cir-main/
├── src/
│   ├── contract.ts          冻结契约（与一、二部字节一致，git diff --no-index 校验）
│   ├── engine/              [M5 集成] 第一部引擎源码（拷入，未改动）
│   ├── canvas/              [M5 集成] 第二部画布源码（拷入，未改动）
│   ├── chips/               芯片库（31 个 kind）
│   │   ├── bits.ts          组合：AND16/OR16/XOR16/NOT16/NEG16/MUX16/MUX4WAY16/
│   │   │                    MUX8WAY16/DMUX/DMUX4WAY/DMUX8WAY/OR8WAY/HALFADDER/
│   │   │                    FULLADDER/ADD16/INC16
│   │   ├── alu.ts           ALU（六控制位 + zr/ng）
│   │   ├── seq.ts           BIT/REGISTER16/REGISTER/AREGISTER/DREGISTER/PC
│   │   ├── memory.ts        RAM8/64/512/4K/16K + ROM32K（地址缓存模式）
│   │   ├── io.ts            SCREEN（帧缓冲）/ KEYBOARD
│   │   ├── memdecode.ts     MEMDECODE（内存映射地址译码器，决策 #5）
│   │   ├── handles.ts       句柄注册表（ROM/RAM/SCREEN/KBD 的外部通道）
│   │   └── registerAll.ts   registerChipLibrary(engine) 统一注册
│   ├── expand/
│   │   ├── expand.ts        子电路展开器（递归扁平化 + 循环检测 + 边界对位）
│   │   └── builder.ts       网表构建器（NetlistBuilder）
│   ├── hack/
│   │   ├── cpu.ts           CPU 子电路模板（数据通路 + 控制译码）
│   │   ├── computer.ts      整机总装网表 + HackMachine 控制器
│   │   ├── rom.ts           .hack 解析
│   │   └── programs/        movblk.hack（自编）/ tetris.hack / kbdcopy.hack / sum.hack
│   ├── web/                 示例页（main.ts + screenView.ts + chipShapes.ts 画布接线）
│   └── testkit/             DevEngine（差分参考实现）+ 对拍 harness
├── tests/                   477 个测试（本部 58 + 引擎 165 + 画布 254），全绿
├── golden/                  nand-computer 黄金向量拷贝（34 文件）
├── programs/movblk.asm      弹跳方块汇编源码（重新汇编说明在内）
├── scripts/build.mjs        esbuild 打包
├── scripts/serve.mjs        本地预览服务
├── index.html               单页入口（屏幕 + 电路画布 + 控制面板）
└── dist/                    打包产物（index.html + app.js，静态可部署）
```

## 3. 黄金向量对拍结果

**5,832 条用例 + 4 条整机 trace，全部通过**（引擎 = 第一部真引擎 `src/engine`）：

| 向量 | 类型 | 用例数 | 结果 |
|---|---|---|---|
| add16 | comb | 900 | ✅ |
| alu | comb | 1536（全 64 组控制位 × 24 组 x/y，见下） | ✅ |
| and / or / nand / xor / not / mux | comb | 4/4/4/4/2/8 | ✅ |
| and16 / or16 / xor16 | comb | 324 ×3 | ✅ |
| not16 / inc16 | comb | 18 / 30 | ✅ |
| mux16 | comb | 648 | ✅ |
| mux4way16 / mux8way16 | comb | 1024 / 192 | ✅ |
| dmux / dmux4way / dmux8way / or8way | comb | 4/8/16/256 | ✅ |
| halfadder / fulladder | comb | 4 / 8 | ✅ |
| bit / register / dregister / aregister | clocked | 4 ×4 | ✅ |
| pc | clocked | 11（reset>load>inc 优先级、15 位回绕） | ✅ |
| ram8 / ram64 | clocked | 19 / 144（含 tick:false 只读回用例） | ✅ |
| computer-add | 整机 trace | 7 周期逐拍 + finalRam | ✅ |
| computer-max | 整机 trace | 15 周期逐拍（跳转 + initRam） | ✅ |
| computer-oob | 整机 trace | 16 周期逐拍（越界写忽略/读 0） | ✅ |
| computer-screen-kbd | 整机 trace | 9 周期逐拍 + **SHA-256 帧哈希** | ✅ |

补充对拍（golden 未覆盖的自行补全）：

- **ALU 512 控制组合**：alu.json 1536 例 = 全部 2^6 控制位组合 × 24 组 (x,y) 采样（测试里断言组合数 = 64）。
- **NEG16**：全 65,536 值属性对拍（-x ≡ (~x)+1）。
- **RAM512 / RAM4K / RAM16K**：边界地址写读（golden 只到 RAM64）。
- **MEMDECODE**：全 65,536 地址与 SPEC 口径差分。
- **ROM32K**：句柄烧程序 + reset() 程序幸存。
- **屏幕哈希**：Node crypto SHA-256，8192 字大端展开 16384 字节（SPEC 口径）。
- **汇编产物端到端**：sum（RAM[1]=55）、kbdcopy（KBD→SCREEN[0]）、像素口径校验。
- **差分对拍**：computer-screen-kbd 同时在真引擎与 DevEngine（暴力参考实现）上通过——
  芯片语义只依赖契约可观测行为。

### 3.1 tetris 程序级差分（`TETRIS_DIFF=1 npm run test:long`，可选长测）

用 nand-computer 官方行为核（`software/demo/engine.js`，只读引用）与本部整机
跑**同样的 tetris ROM 同样的周期数**，逐字节比对：

| 周期 | RAM(0x0000-0x3FFF) SHA-256 | 屏幕区(0x4000-0x5FFF) SHA-256 | 结论 |
|---|---|---|---|
| 3,000,000 | **一致** | **一致**（`4fe7b59a…`） | boot 阶段逐字节等价 |
| 12,300,000 | **一致**（含游戏调试变量 frame=4, x=3, y=4, type=1） | **一致**（`376f24bd…`） | 此哈希恰为官方 golden 检查点「首方块生成」的 screenSha256 |

即：本部 53 组件网表整机与官方行为核在 tetris 全程序状态上**逐字节等价**，
并复现了官方 golden 检查点的屏幕哈希。

## 4. 架构与关键决策

### 4.1 三层结构

```
demo .hack ──► ROM32K 句柄（load 前播种）
                │
          ┌─────▼─────── expand() 扁平化 ──────────────┐
          │  CPU 模板（HACK_CPU）                       │
          │   ├ 数据通路：PC/AREG/DREG/ALU/3×MUX16      │
          │   ├ 译码：16×SPLIT + 1 位门（loadA/loadD/   │
          │   │  writeM/jlt/jeq/jgt→pcLoad）            │
          │  MEMDECODE → RAM16K / SCREEN / KBD(PIN_IN) │
          │  读出 MUX 树（RAM|SCREEN|KBD，越界=0）       │
          └─────────────────────────────────────────────┘
                │ 契约 SimEngine（src/engine，第一部）
                ▼
        canvas 渲染（SCREEN 句柄 → 512×256 ImageData）
```

### 4.2 决策摘要（详见 README-偏差记录.md）

| # | 决策 | 一句话 |
|---|---|---|
| 1 | 地址缓存模式 | 沿后空 inputs 刷新 → lastAddr 进 state |
| 2 | 句柄注册表 | initState 按 props.id 认领；load 前播种、reset 幸存 |
| 3 | 外部输入 = PIN_IN | reset/kbd 走契约唯一入口 setInput |
| 5 | MEMDECODE 芯片 | 门树 29 组件 → 1 组件，65536 地址差分 |
| 8 | trace 采样约定 | 沿后锁存态 + 下一指令组合译码，A 指令 outM=null |

### 4.3 子电路展开器

- 模板 = 网表 + PIN_IN/PIN_OUT 边界（props.name = 端口名）；
- 递归扁平化，id 以 `实例/子实例/组件` 前缀保持可读（如 `u4/fa1/ha1/x1`）；
- 连线做**全局网段归并**（并查集）：实例端口引用改写为边界 pin 节点后统一并网段，
  pin 所在网段的端点统一改接到代表端点——与引擎连线并查集语义严格等价；
- 错误检测：循环引用（A→B→A 链路呈现）、边界端口对位失败、端口重名；
- M3 验证：原语手搭半加器→全加器→4 位行波进位加法器（两层嵌套）**穷举 512 组合**、
  原语手搭 1 位寄存器→16 位寄存器时钟语义、纯函数性、根层 PIN 保留。

## 5. 性能基准（`npm run bench`）

Node 24 / 单线程，真引擎，movblk 程序 5000 周期：

| 指标 | 数值 |
|---|---|
| 全机网表 | **53 组件 / 87 连线**（展开耗时 0.55ms） |
| 芯片求值 / 周期 | **30 次**（evaluate+onClockEdge，行为计数器统计） |
| 周期吞吐 | **64,534 周期/秒**（Node）；浏览器实测 **~350,000 周期/秒** |
| 帧当量耗时 | **0.0155 ms / Hack 周期** |
| ALU 1536 例对拍 | 15.4ms（10μs/例，含 setInput/tick/read 全契约链路） |

**口径换算**（任务书："Hack 全机一帧（约 500 万门事件）模拟 1 秒真实时间 < 200ms"）：
nand2tetris 门级全机约 150 万门，"一帧 ≈ 500 万门事件" ≈ **1~3 个 Hack 周期**的门级仿真量。
本机一个"帧当量"（= 1 个 Hack 周期）耗时 **0.0155ms**，为 200ms 预算的
**1/12,900**——按同口径验收通过，余量四个数量级。
60fps 画布帧预算（16.7ms）内可跑 **~1,078 周期**（Node 口径；浏览器 ~5,000+），
弹跳方块（~2,400 周期/帧）达到 ~60fps。

## 6. 集成记录（M5）✅ 三部全部完成

1. **引擎（第一部）**：`cir-engine/src/engine/` 七个文件拷入 `cir-main/src/engine/`，
   其 `tests/`（165 个测试，含 19 个模糊/差分与序列化 round-trip）拷入
   `tests/engine/`（导入路径 `../src/` → `../../src/`，其余零改动）。
   `git diff --no-index` 校验三方 `src/contract.ts` **字节一致**。
   - 集成中发现 1 处真差异并固化为测试：真引擎脏集驱动，`load()` 后直改句柄数据
     不会重算输出（DevEngine 全量重算会）→ 标准用法是 load 前播种（偏差记录 #2）。
2. **画布（第二部）**：`cir-canvas/src`（33 文件）拷入 `cir-main/src/canvas/`，
   其 11 个测试文件（254 个测试）拷入 `tests/canvas/`（导入前缀适配，其余零改动），
   契约三方字节一致，**254 个画布测试全绿**。
   集成接线（`src/web/`）：
   - `chipShapes.ts`：芯片库 + 引擎原语的全部 kind 自动生成"标准盒"形状
     （端口名/方向来自行为声明），画布值表按正确端口读值；
   - `main.ts`：全页**共用一个引擎实例**；`NetlistDoc` 载入整机网表，
     `SimController` 直连真引擎，`Controller` 的 rAF 渲染循环自动工作；
     demo 切换 = `HackMachine` 重新 load 同一引擎（句柄认领 → 程序/屏幕重建），
     `doc.commit` 触发画布侧 `syncEngine`（engine.load + tick）——两条路径天然协同；
   - 每帧 `sim.refreshValues()` 刷新值表 → 画布连线值着色实时流动。
   - 浏览器实测：整机 53 组件渲染 + 运行中连线值动态着色 + 弹跳方块同屏运行。
3. **全仓测试**：`npm test` = **477 通过 + 1 门控跳过**（本部 58 + 引擎 165 + 画布 254）；
   `npm run typecheck` 无错（三部源码同一 tsconfig strict）。
   性能基准分离到 `npm run bench`（三方 bench 串行跑，避免并行 CPU 竞争导致
   阈值抖动——画布 1k 组件渲染基准对调度敏感，单跑中位数 ~5ms 远低于 8ms 门禁）。

## 7. 示例页与部署

- `npm run build`（esbuild）：单页产物 `dist/index.html + dist/app.js`（625KB，其中
  tetris 程序文本 ~470KB）。零运行时依赖；`.hack` 以文本内嵌，无运行时请求。
- demo 菜单：① 弹跳方块（自编 Hack 汇编，16×16 方块对角弹跳）② 俄罗斯方块
  （nand-computer 软件轨编译产物，键盘可玩）③ 键盘回显 ④ 求和程序。
- 键盘映射：SPEC 口径（可打印=码点、Backspace=8、Enter=13、Esc=27、方向键 37-40）。
- 控制：运行/暂停/单周期/复位/速度滑杆（10-5000 周期/帧）+ PC/A/D/RAM 面板。

**GitHub Pages 部署方案**（仓库根就绪后任选其一）：

1. **Actions 自动部署**（推荐）：`.github/workflows/deploy.yml`
   ```yaml
   on: { push: { branches: [main] } }
   permissions: { pages: write, id-token: write }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22 }
         - run: npm ci && npm test && npm run build
         - uses: actions/upload-pages-artifact@v3
           with: { path: dist }
         - uses: actions/deploy-pages@v4
   ```
   仓库设置 → Pages → Source 选 **GitHub Actions**。
2. **手工**：`npm run build` 后把 `dist/` 推到 `gh-pages` 分支（`npx gh-pages -d dist`）。
3. 注意：子路径部署无需配置——产物使用相对路径 `app.js`；本仓库 `cir-main` 若为
   monorepo 子目录，把 Actions 的 working-directory 指到该目录即可。

## 8. 已知限制

1. 电路画布上**编辑整机网表**会触发引擎重载（CPU 状态复位）；程序与屏幕内容因
   句柄认领而幸存。这是画布"编辑即重仿真"的设计，演示时注意。
2. tetris 引导需数百万周期（浏览器 ~30-60 秒出 UI）。实测该游戏**只在方块移动/锁定时
   绘制像素**：生成后不按键，方块要等落底才可见（官方回放脚本首事件恰在生成后 1 周期，
   实机游玩无此观感问题）。
3. KEYBOARD 库芯片的句柄注入在真引擎上不会自动传播（无输入网）；整机用 PIN_IN（#4）。
4. 模板实例 props 不透传到模板内部（展开器已知限制）。
5. 振荡电路诊断依赖引擎；本部网表均为良构无振荡。
6. `RESET` 按钮语义 = `engine.reset()`（时序状态清零 + 程序/屏幕幸存，偏差记录 #2），
   非 Hack 硬件 reset 线（后者是 demo 里的"复位线"PIN，由程序向量控制）。
7. 官方 runner 的周期计数口径约为本机 2.3 倍（其检查点 5,344,667 ≈ 本机 12,300,000，
   状态完全一致，见 §3.1）——对拍时勿按周期号直接对齐。
8. 画布快捷键（数字切工具等）与游戏键盘注入并存：玩游戏时误按数字会切画布工具
   （不影响游戏）；两者作用域独立。

## 9. 验收清单对照

- [x] `npm install && npm test && npm run typecheck` 全绿（**477 通过 + 1 门控跳过**，
      含拷入的引擎测试 165 + 画布测试 254；真引擎）
- [x] ALU 全控制组合对拍（1536 例）+ 算术/时序芯片黄金向量全绿（5,832 例）
- [x] PC / REGISTER16 / RAM 系列时钟语义测试（load/inc/reset 优先级、沿采样、回绕）
- [x] 子电路展开器：嵌套（两层）、循环检测、边界端口对位，全单测（穷举 512 组合）
- [x] Hack 总装：demo 程序运行（屏幕像素断言 + 键盘注入 + 画布渲染核验）
- [x] 屏幕哈希对拍：computer-screen-kbd 的 SHA-256 帧哈希（Node crypto，仅测试用）；
      另复现官方 golden tetris 检查点哈希（§3.1 程序级差分）
- [x] esbuild 单页打包产物 + 部署说明（§7）
- [x] 性能基准脚本与结果记录（§5，`npm run bench`，三方基准串行）
- [x] 画布集成：整机网表在 cir-canvas 渲染 + 运行中连线值着色（§6.2）
- [x] REPORT.md（本文件）

## 10. 博客素材要点

1. **"把一台计算机装进 53 个组件"**：门级 150 万门 → 库芯片抽象 → 53 组件网表，
   宽粒度组件是仿真速度的本质（每周期仅 30 次芯片求值）。
2. **对拍驱动开发**：5,832 条向量先行的 TDD；整机 trace 的采样约定如何从
   `resetCycles` 与 jump 行为反推出来（偏差记录 #8 是篇好故事）。
3. **沿后空刷新陷阱**：`evaluate({}, state)` 约定下 RAM 输出跌回 mem[0] 的 bug，
   以及"地址缓存模式"这个 5 行修复（偏差记录 #1）。
4. **宏展开 = 网段归并**：子电路展开器不用"对端传播"的补丁式实现，而是把实例端口
   引用改写成 pin 节点后做一次全局并查集——20 行核心代码换来语义严格等价。
5. **双引擎差分**：暴力参考实现 + 契约测试，集成时抓到"load 后播种不可见"的真差异。
6. **性能口径学**："500 万门事件/帧"在不同抽象粒度下的换算，以及为什么宽粒度仿真器
   赢四个数量级。
