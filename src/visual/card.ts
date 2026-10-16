import type { VisualSurface } from "@/visual/panel";
import {
  VIS_CARD_FILL,
  VIS_CARD_STROKE,
  VIS_DIM,
  VIS_DIVIDER,
  VIS_HEADER_FILL_V2,
  VIS_SECTION_LABEL,
  VIS_TEXT,
  VIS_TITLE,
  VIS_TRACK,
} from "@/visual/palette";

type DrawOp =
  | { kind: "rect"; x: number; y: number; w: number; h: number; style: Record<string, unknown> }
  | { kind: "text"; text: string; x: number; y: number; style: Record<string, unknown> };

export interface CardConfig {
  rv: VisualSurface;
  x: number;
  y: number;
  width: number;
  paddingX?: number;
  paddingBottom?: number;
}

export interface CardColumn {
  text: string;
  /** 距内容左边界的偏移；右对齐且 at <= 0 时，改为距内容右边界的偏移。 */
  at: number;
  align?: "left" | "right" | "center";
  color?: string;
  bold?: boolean;
  font?: number;
}

/**
 * 先缓冲绘图指令，按实际内容计算背景高度，再依次绘制。
 * 背景只需一次 rect，所有内容均使用 VisualSurface 的 rect/text 接口。
 */
export class Card {
  private readonly rv: VisualSurface;
  private readonly x: number;
  private readonly top: number;
  private readonly width: number;
  private readonly padX: number;
  private readonly padBottom: number;
  private y: number;
  private ops: DrawOp[] = [];
  private flushed = false;
  private used = 0;

  constructor(config: CardConfig) {
    this.rv = config.rv;
    this.x = config.x;
    this.top = config.y;
    this.y = config.y;
    this.width = config.width;
    this.padX = config.paddingX ?? 0.4;
    this.padBottom = config.paddingBottom ?? 0.2;
  }

  get callsUsed(): number {
    return this.used;
  }

  /** flush() 将产生的精确调用数：一次背景，加所有缓冲指令。 */
  get pendingCalls(): number {
    return this.flushed ? 0 : this.ops.length + 1;
  }

  private get innerLeft(): number {
    return this.x + this.padX;
  }

  private get innerRight(): number {
    return this.x + this.width - this.padX;
  }

  /** 左对齐列从内容左边界定位；右对齐且 at <= 0 的列从内容右边界定位。 */
  private colX(at: number, align: "left" | "right" | "center" = "left"): number {
    return align === "right" && at <= 0 ? this.innerRight + at : this.innerLeft + at;
  }

  private rect(x: number, y: number, w: number, h: number, style: Record<string, unknown>): void {
    this.ops.push({ kind: "rect", x, y, w, h, style });
  }

  private text(text: string, x: number, y: number, style: Record<string, unknown>): void {
    this.ops.push({ kind: "text", text, x, y, style });
  }

  /** 标题栏使用健康状态色的左侧强调条，右侧显示状态徽标。 */
  header(title: string, subtitle: string, badge: { label: string; color: string }): void {
    const h = 1.0;
    this.rect(this.x, this.y, this.width, h, { fill: VIS_HEADER_FILL_V2, opacity: 0.95, strokeWidth: 0 });
    this.rect(this.x, this.y, 0.12, h, { fill: badge.color, opacity: 0.95, strokeWidth: 0 });
    this.text(title, this.innerLeft, this.y + 0.62, { align: "left", font: "bold 0.55 sans-serif", color: VIS_TITLE });
    const pillW = Math.max(1.3, badge.label.length * 0.24 + 0.5);
    const pillX = this.innerRight - pillW;
    this.rect(pillX, this.y + 0.24, pillW, 0.52, { fill: badge.color, opacity: 0.28, stroke: badge.color, strokeWidth: 0.03 });
    this.text(badge.label, pillX + pillW / 2, this.y + 0.62, { align: "center", font: "bold 0.34 sans-serif", color: badge.color });
    if (subtitle) {
      this.text(subtitle, pillX - 0.25, this.y + 0.6, { align: "right", font: 0.34, color: VIS_DIM });
    }
    this.y += h + 0.15;
  }

  /** 警告块共用一个浅色背景，每条警告绘制一次文字。 */
  callout(lines: string[], color: string): void {
    if (lines.length === 0) return;
    const rowH = 0.5;
    const h = lines.length * rowH + 0.16;
    this.rect(this.innerLeft - 0.1, this.y, this.width - this.padX * 2 + 0.2, h, { fill: color, opacity: 0.12, stroke: color, strokeWidth: 0.02 });
    lines.forEach((line, index) => {
      this.text(line, this.innerLeft + 0.1, this.y + 0.43 + index * rowH, { align: "left", font: 0.34, color });
    });
    this.y += h + 0.15;
  }

  /** 小号大写分区标题，附右对齐摘要和细分隔线。 */
  section(label: string, meta?: { text: string; color?: string }): void {
    this.y += 0.12;
    this.text(label.toUpperCase(), this.innerLeft, this.y + 0.36, { align: "left", font: "bold 0.3 sans-serif", color: VIS_SECTION_LABEL });
    if (meta?.text) {
      this.text(meta.text, this.innerRight, this.y + 0.36, { align: "right", font: 0.32, color: meta.color ?? VIS_DIM });
    }
    this.rect(this.innerLeft, this.y + 0.5, this.width - this.padX * 2, 0.02, { fill: VIS_DIVIDER, opacity: 0.9, strokeWidth: 0 });
    this.y += 0.62;
  }

  /** 绘制一行对齐的列。 */
  row(columns: CardColumn[], rowHeight = 0.5): void {
    for (const column of columns) {
      if (!column.text) continue;
      const size = column.font ?? 0.34;
      this.text(column.text, this.colX(column.at, column.align), this.y + 0.36, {
        align: column.align ?? "left",
        font: column.bold ? `bold ${size} sans-serif` : size,
        color: column.color ?? VIS_TEXT,
      });
    }
    this.y += rowHeight;
  }

  /** 进度条包含底轨、填充、左侧标签和右侧数值。 */
  bar(percent: number, color: string, left: string, right: string): void {
    const w = this.width - this.padX * 2;
    const h = 0.5;
    const pct = Math.max(0, Math.min(1, percent));
    this.rect(this.innerLeft, this.y, w, h, { fill: VIS_TRACK, opacity: 0.9, strokeWidth: 0 });
    if (pct > 0) this.rect(this.innerLeft, this.y, w * pct, h, { fill: color, opacity: 0.55, strokeWidth: 0 });
    this.text(left, this.innerLeft + 0.18, this.y + 0.36, { align: "left", font: "bold 0.34 sans-serif", color: VIS_TITLE });
    this.text(right, this.innerRight - 0.18, this.y + 0.36, { align: "right", font: 0.32, color: VIS_TITLE });
    this.y += h + 0.15;
  }

  /** 表格行内的紧凑进度条，包含底轨和填充。 */
  meter(at: number, width: number, percent: number, color: string): void {
    const pct = Math.max(0, Math.min(1, percent));
    const x = this.colX(at);
    this.rect(x, this.y + 0.16, width, 0.24, { fill: VIS_TRACK, opacity: 0.9, strokeWidth: 0 });
    if (pct > 0) this.rect(x, this.y + 0.16, width * pct, 0.24, { fill: color, opacity: 0.8, strokeWidth: 0 });
  }

  /** 先绘制背景，再输出缓冲指令；返回实际绘图调用数，重复调用不重复绘制。 */
  flush(): number {
    if (this.flushed) return this.used;
    this.flushed = true;
    const height = this.y - this.top + this.padBottom;
    this.rv.rect(this.x, this.top, this.width, height, { fill: VIS_CARD_FILL, opacity: 0.82, stroke: VIS_CARD_STROKE, strokeWidth: 0.04 });
    this.used += 1;
    for (const op of this.ops) {
      if (op.kind === "rect") this.rv.rect(op.x, op.y, op.w, op.h, op.style);
      else this.rv.text(op.text, op.x, op.y, op.style);
      this.used += 1;
    }
    this.ops = [];
    return this.used;
  }
}
