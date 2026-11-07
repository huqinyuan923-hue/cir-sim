/**
 * Hack 屏幕帧缓冲 → Canvas 2D 渲染（512×256 单色，SPEC 口径）。
 * w = y*32 + (x>>4)，像素位 = 15-(x&15)，1=点亮。
 * 每字一次 16 位展开，脏字跳过（words 引用相等缓存）。
 */

export class ScreenView {
  private readonly img: ImageData;
  private readonly buf: Uint8ClampedArray;
  private lastWords: number[] | null = null;
  private readonly lastSnap: number[] = new Array<number>(8192).fill(-1);

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly onColor: [number, number, number] = [32, 225, 128],
    private readonly offColor: [number, number, number] = [10, 16, 14],
  ) {
    this.img = ctx.createImageData(512, 256);
    this.buf = this.img.data;
  }

  /** 渲染一帧（words = 8192 个屏幕字）。与上次相同则跳过重绘。 */
  render(words: number[]): void {
    if (words === this.lastWords) {
      // 同一数组引用：仍可能有原位修改（句柄直改），做一次脏检查
      let dirty = false;
      for (let i = 0; i < 8192; i++) {
        if ((words[i] ?? 0) !== this.lastSnap[i]) {
          dirty = true;
          break;
        }
      }
      if (!dirty) return;
    }
    this.lastWords = words;

    const [or, og, ob] = this.onColor;
    const [fr, fg, fb] = this.offColor;
    for (let w = 0; w < 8192; w++) {
      const val = words[w] ?? 0;
      if (val === this.lastSnap[w]) continue;
      this.lastSnap[w] = val;
      const row = w >> 5; // w / 32
      const col = w & 31; // 字内列
      const base = (row * 512 + col * 16) * 4;
      for (let b = 0; b < 16; b++) {
        const on = (val >>> (15 - b)) & 1;
        const o = base + b * 4;
        this.buf[o] = on ? or : fr;
        this.buf[o + 1] = on ? og : fg;
        this.buf[o + 2] = on ? ob : fb;
        this.buf[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}

/** SPEC 键码表（画布/页面键盘事件 → Hack 键码） */
export function hackKeyCode(e: KeyboardEvent): number {
  switch (e.key) {
    case 'Backspace': return 8;
    case 'Tab': return 9;
    case 'Enter': return 13;
    case 'Escape': return 27;
    case 'ArrowLeft': return 37;
    case 'ArrowUp': return 38;
    case 'ArrowRight': return 39;
    case 'ArrowDown': return 40;
    default: {
      // 可打印单字符 → Unicode 码点
      if (e.key.length === 1) return e.key.codePointAt(0) ?? 0;
      return -1; // 不映射
    }
  }
}
