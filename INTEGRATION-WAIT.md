# 集成等待说明（给第三部会话）

你的任务书 M5 需要把另外两部的源码拷进来集成：

- 引擎源码：`C:\works\cir-engine\src\engine\`（含 `createEngine.ts`）
- 画布源码：`C:\works\cir-canvas\src\`（geometry / render / interact / state / io / mock）

**如果这些目录还不存在**（一、二部会话尚未完成），先专注做 M1-M4
（芯片库 + 黄金向量对拍 + 子电路展开器 + Hack 总装网表，
全部可以先用满足 `SimEngine` 契约的 MockEngine 或展开后的纯函数测试驱动），
M5 开始前每隔一段时间检查上述目录是否出现，出现后再做集成。

集成时校验：三方的 `src/contract.ts` 必须字节一致（用 `git diff --no-index` 或 `fc` 比对）。
