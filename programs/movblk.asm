// ===== 弹跳方块 demo（第三部 · 点屏动效）=====
// 16×16 像素方块（16 个屏幕字竖条）在 512×256 屏幕上对角移动，碰壁反弹。
// 变量：x（0..31 列，字坐标）、w（屏幕字下标，块顶行）、dx/dy（±1 方向）、r（行循环）、ptr、i（延时）。
// 不变式：w mod 32 = x。重新汇编：
//   cat programs/movblk.asm | node <nand-computer>/software/dist/src/cli/hackasm.js > programs/movblk.hack

@28
D=A
@x
M=D
@124
D=A
@w
M=D          // 起始 w = 行3*32 + 列28
@1
D=A
@dx
M=D
@1
D=A
@dy
M=D
@minus1
M=-1         // 常量 -1（汇编器自动分配变量地址）
(LOOP)
// --- 清除旧块：cur = SCREEN+w 起，每行 +32，共 16 行 ---
@w
D=M
@SCREEN
D=D+A
@cur
M=D
@0
D=A
@r
M=D
(CLR)
@cur
A=M
M=0
@cur
D=M
@32
D=D+A
@cur
M=D
@r
D=M
@1
D=D+A
@r
M=D
@16
D=D-A
@CLR
D;JLT

// --- x 更新与反弹 ---
@x
D=M
@dx
D=D+M
@x
M=D
@x
D=M
@31
D=D-A
@XHI
D;JGE        // x >= 31 → dx = -1
@x
D=M
@XLO
D;JLT        // x <= 0 → dx = +1
@XDONE
0;JMP
(XHI)
@minus1
D=M
@dx
M=D
@XDONE
0;JMP
(XLO)
@1
D=A
@dx
M=D
(XDONE)

// --- w += dx ---
@dx
D=M
@w
M=D+M

// --- y 反弹（w 判界：顶行 w<=31、底行块底 w+480>=8192 即 w>=7712）---
@w
D=M
@31
D=D-A
@YTOP
D;JLE
@w
D=M
@7712
D=D-A
@YBOT
D;JGE
@YDONE
0;JMP
(YTOP)
@1
D=A
@dy
M=D
@YDONE
0;JMP
(YBOT)
@minus1
D=M
@dy
M=D
(YDONE)

// --- w += 32*dy（dy 为 ±1，分支处理）---
@dy
D=M
@1
D=D-A
@WUP
D;JNE        // dy != 1 → w -= 32
@w
D=M
@32
D=D+A
@w
M=D
@WDONE
0;JMP
(WUP)
@w
D=M
@32
D=D-A
@w
M=D
(WDONE)

// --- 画新块：cur = SCREEN+w 起，每行 +32，共 16 行，写 -1 ---
@w
D=M
@SCREEN
D=D+A
@cur
M=D
@0
D=A
@r
M=D
(DRW)
@cur
A=M
M=-1
@cur
D=M
@32
D=D+A
@cur
M=D
@r
D=M
@1
D=D+A
@r
M=D
@16
D=D-A
@DRW
D;JLT

// --- 延时（约 200×10 周期，控制帧率 ~60fps）---
@0
D=A
@i
M=D
(DLP)
@i
D=M
@1
D=D+A
@i
M=D
@200
D=D-A
@DLP
D;JLT

@LOOP
0;JMP
