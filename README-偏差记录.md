# README-偏差记录（cir-main · 第三部）

> 记录与任务书/冻结契约的**语义级决策与偏差**（14 条）。契约文件 `src/contract.ts`
> 未做任何修改（与一、二部字节一致，`git diff --no-index` 校验通过）。

---

## #1 时序芯片的「地址缓存」模式（lastAddr）

- **类型**：引擎实现约定的适配（契约未修改）
- **背景**：引擎在时钟沿后以**空 inputs** 调 `evaluate({}, state, props)` 刷新时钟芯片输出
  （cir-engine 偏差记录 #12）。RAM/SCREEN 类芯片的输出 = `mem[address]`，若 evaluate 直接
  读 `inputs.address`，沿后刷新会静默跌回 `mem[0]`。
- **决策**：RAM 家族 / SCREEN 的 `evaluate` 收到真实 inputs 时把地址缓存进 `state.lastAddr`；
  空 inputs 时退回缓存；`onClockEdge` 用采样值同步缓存。
- **测试固化**：`tests/m2-seq-golden.test.ts`（沿后不 tick 直读 RAM 输出）。

## #2 句柄注册表（initState 认领模式）

- **类型**：契约表达力缺口的工作区
- **背景**：契约里 `ChipBehavior` 是原型对象，引擎按实例调 `initState` 产出状态，外部拿不到
  引用。但 ROM 烧程序、SCREEN 取帧、RAM 种子/读出、键盘注入是总装与画布刚需。
- **决策**：`src/chips/handles.ts` 维护 `id → 状态` 注册表；芯片 `initState(props)` 按
  `props.id` **认领**既有状态，认领不到才新建登记。效果：
  - `engine.load()` 前经句柄写入的程序/种子立即生效；
  - `engine.reset()` 重建运行时重新认领同一对象 → 程序、屏幕内容、RAM、键值全部幸存
    （对齐"reset 线只复位 PC"的 Hack 语义）；
  - 测试隔离用 `clearAllHandles()`。
- **限制（真引擎语义）**：`load()` 之后直接改句柄数据**不会**自动重算输出（真引擎脏集驱动，
  输入网不变则不重算）。标准用法是 **load 前播种**（`HackMachine` 构造即此顺序）；
  DevEngine 因全量重算无此限制——差异已用差分测试固化。

## #3 外部输入建模为 PIN_IN（reset / kbd）

- **类型**：任务书的架构细化
- **内容**：整机对外输入只有契约允许的入口 `engine.setInput(PIN_IN)`。因此：
  - 复位线 = 1 位 PIN_IN → PC.reset；
  - 键盘 = 16 位 PIN_IN → 读出 MUX（画布/测试经 setInput 注入 SPEC 键码）。
- **理由**：`setInput` 只接受 PIN_IN（引擎约定 #5）；任何"直改状态"的旁路都有传播新鲜度问题。

## #4 KEYBOARD 库芯片保留，但整机不使用

- **类型**：库完整性与架构取舍
- **内容**：任务书列了 KEYBOARD（0x6000 单字）原生芯片，已实现（state.key，句柄注入），
  但 Hack 总装里键盘走 #3 的 PIN_IN。原因：KEYBOARD 无输入端口，句柄直改 key 后其输出
  net 永远不会进脏集（没有输入网变化），在真引擎上不可见；PIN_IN 是唯一可靠通道。
- **测试**：`KEYBOARD` 库芯片在芯片库清单与行为单测中覆盖。

## #5 新增库芯片 MEMDECODE（地址译码器）

- **类型**：任务书芯片清单之外的补充（清单是下限不是上限）
- **内容**：`MEMDECODE`：a[16] → isram/isscr/kbd，内置 KBD 精确匹配（0x6000）与越界语义。
- **理由**：门树版译码需要 13 SPLIT + 14 门 ≈ 29 组件，且 A 总线每周期变化导致全树重求值
  （占全机每周期求值量的一半）。原生单芯片把每周期 29 次求值压成 1 次，全机网表
  83 → 53 组件。这正是真实计算机里"地址译码器 IC"的抽象。
- **等价性**：与 SPEC 口径参考译码做全 65536 地址差分对拍（`tests/m4-computer.test.ts`）。

## #6 黄金向量与汇编产物的拷贝位置

- **类型**：任务书要求的落实
- **内容**：向量拷贝至 `golden/*.json`（34 个硬件向量 + `golden/sw/` 软件产物）；
  demo 用的 .hack 产物（movblk 自编 + tetris/kbdcopy/sum 拷贝）在 `src/hack/programs/`。
  运行时与测试均不引用 nand-computer 绝对路径。

## #7 clocked 向量的 `tick:false` 用例语义

- **类型**：向量格式的补充解释
- **内容**：ram8/ram64 向量中部分用例带 `"tick": false` 且无 `outAfter`——语义为
  "set → tick（组合收敛）→ 断言读回，**不打时钟沿**"。`runClockedGolden` 据此分派。

## #8 computer-trace 向量的采样约定

- **类型**：向量格式的补充解释（实现推导，已由 4 条整机向量全绿反证）
- **内容**：`trace[i]` = 第 i 个周期结束（时钟沿后）的**锁存状态** pc/a/d，
  加上**下一指令**（ROM[pc]）的组合译码 addressM/outM/writeM；
  A 指令的 outM 约定为 `null`；`addressM` 恒等于 A 寄存器值；
  键盘事件 `[c, code]` 在第 c 周期**起始**生效（先注入 → tick → 采样 → 沿）；
  `resetCycles=n` 表示前 n 个周期复位线为高（PC 钉 0，指令照常执行）。

## #9 程序汇编不自带汇编器

- **类型**：任务书选项的取舍
- **内容**：demo 与新程序一律用 nand-computer 的汇编器（只读调用
  `software/dist/src/cli/hackasm.js`，stdin/stdout 管道），产物拷回本目录。
  本仓不含汇编器源码，保持"零运行时依赖"与职责边界。

## #10 引擎惯例「evaluate 的时序输出只读 state」全库遵守

- **类型**：跨部协作约定
- **内容**：本部全部时序芯片（REGISTER/PC/RAM/SCREEN）的 evaluate 输出只读 state，
  组合输出（如 ROM32K 的地址读出）才读 inputs——ROM32K 无时钟沿，不受沿后空刷新影响。

## #11 16 位总线拆位用 SPLIT、控制译码用 1 位原语门

- **类型**：实现风格（与任务书"用 16 位芯片拼"对齐）
- **内容**：CPU 模板的指令位提取 = 16 个 SPLIT；loadA/loadD/writeM/jump 逻辑 =
  1 位 NOT/AND/OR 原语；MUX16 端口名对齐黄金向量（a/b/sel/out）。
  A 指令的 16 位 instr 直接喂 A 寄存器（高位本为 0，无需 15 位截取电路）。

## #12 DevEngine 保留为差分参考实现

- **类型**：测试策略
- **内容**：`src/testkit/devEngine.ts`（满足同一契约的暴力全量重算引擎）保留，
  用于关键向量的双引擎差分（`tests/m4-computer.test.ts` 差分用例）。不进 web 打包。
  M5 引擎集成时发现并固化了一个真差异：#2 的"load 后直改句柄"在脏集驱动引擎上不可见。

## #13 性能基准与主测试分离

- **类型**：工程配置决策
- **内容**：三方性能基准（本部 m6-bench / 引擎 perf / 画布 perf）从默认 `npm test`
  分离到 `npm run bench`（`vitest.bench.config.ts`，`--no-file-parallelism` 串行跑）。
- **理由**：基准断言对绝对耗时敏感，与其他 20+ 测试文件并行时受 CPU 竞争影响
  偶发超阈（画布 1k 组件渲染基准单跑中位 ~5ms，并行抖动到 >8ms）。串行后稳定全绿。

## #14 画布集成接线（芯片形状注册 + 单引擎复用）

- **类型**：M5 集成的语义决策
- **内容**：
  1. `src/web/chipShapes.ts` 把芯片库 + 引擎原语的**全部 kind** 自动注册为画布形状
     （端口名/方向/宽度直接取自行为声明）——画布值表按 `getShape(kind).ports` 读值，
     未注册 kind 回退为无端口通用盒（值表读不到）；
  2. 示例页全页**共用一个引擎实例**：demo 切换 = `HackMachine` 重新 load 同一引擎
     （句柄认领保证 ROM/屏幕正确重建），画布 `doc.commit` 触发的 `syncEngine`
     （engine.load + tick）与整机控制器走同一引擎——编辑网表即重仿真且程序幸存。

---

**结语**：以上均不修改冻结契约。若与一、二部联调发现语义冲突，以三方 `contract.ts` 与
各自偏差记录为对照基准协商。
