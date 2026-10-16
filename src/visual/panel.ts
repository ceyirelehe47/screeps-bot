import {
  VIS_TEXT,
  VIS_HEADER_FILL,
  VIS_PANEL_FILL,
  VIS_PANEL_STROKE,
} from "@/visual/palette";

export interface VisualSurface {
  rect(x: number, y: number, w: number, h: number, style?: Record<string, unknown>): VisualSurface;
  text(text: string, x: number, y: number, style?: Record<string, unknown>): VisualSurface;
}

interface PanelConfig {
  rv: VisualSurface;
  x: number;
  y: number;
  width: number;
  rowHeight?: number;
  headerHeight?: number;
  headerStride?: number;
  barHeight?: number;
  barPad?: number;
  paddingX?: number;
}

export interface PanelHeaderStyle {
  fill?: string;
  color?: string;
  opacity?: number;
  stroke?: string;
}

export class Panel {
  private rv: VisualSurface;
  private x: number;
  private y: number;
  private width: number;
  private rowHeight: number;
  private headerHeight: number;
  private headerStride: number;
  private barHeight: number;
  private barPad: number;
  private paddingX: number;
  private _callsUsed = 0;

  constructor(config: PanelConfig) {
    this.rv = config.rv;
    this.x = config.x;
    this.y = config.y;
    this.width = config.width;
    this.rowHeight = config.rowHeight ?? 0.7;
    this.headerHeight = config.headerHeight ?? 0.55;
    this.headerStride = config.headerStride ?? 0.7;
    this.barHeight = config.barHeight ?? 0.45;
    this.barPad = config.barPad ?? 0.15;
    this.paddingX = config.paddingX ?? 0.25;
  }

  get cursorY(): number {
    return this.y;
  }

  get callsUsed(): number {
    return this._callsUsed;
  }

  background(height: number): void {
    if (height <= 0) return;
    const inset = 0.08;
    this.rv.rect(this.x - inset, this.y - inset, this.width + inset * 2, height + inset * 2, {
      fill: VIS_PANEL_FILL,
      opacity: 0.82,
      stroke: VIS_PANEL_STROKE,
      strokeWidth: 0.03,
    });
    this._callsUsed += 1;
  }

  sectionHeader(title: string, style: PanelHeaderStyle = {}): void {
    this.rv.rect(this.x, this.y, this.width, this.headerHeight, {
      fill: style.fill ?? VIS_HEADER_FILL,
      opacity: style.opacity ?? 0.8,
      stroke: style.stroke ?? VIS_PANEL_STROKE,
      strokeWidth: 0.03,
    });
    const textY = this.y + this.headerHeight * 0.76;
    this.rv.text(title, this.x + this.paddingX, textY, {
      align: "left",
      font: 0.45,
      color: style.color ?? VIS_TEXT,
    });
    this.y += this.headerStride;
    this._callsUsed += 2;
  }

  textRow(text: string, style?: Record<string, unknown>): void {
    const textY = this.y + 0.48;
    this.rv.text(text, this.x + this.paddingX, textY, {
      align: "left",
      font: 0.4,
      color: VIS_TEXT,
      ...style,
    });
    this.y += this.rowHeight;
    this._callsUsed += 1;
  }

  progressBar(percent: number, fillColor: string, label: string): void {
    const barWidth = this.width - this.paddingX * 2;
    this.rv.rect(this.x + this.paddingX, this.y, barWidth, this.barHeight, {
      fill: VIS_HEADER_FILL,
      stroke: VIS_PANEL_STROKE,
      strokeWidth: 0.02,
      opacity: 0.9,
    });
    if (percent > 0) {
      this.rv.rect(this.x + this.paddingX, this.y, barWidth * percent, this.barHeight, {
        fill: fillColor,
        opacity: 0.55,
        strokeWidth: 0,
      });
    }
    this.rv.text(label, this.x + this.width / 2, this.y + 0.36, {
      align: "center",
      font: 0.35,
      color: VIS_TEXT,
    });
    this.y += this.barHeight + this.barPad;
    this._callsUsed += percent > 0 ? 3 : 2;
  }

  spacer(height?: number): void {
    this.y += height ?? this.rowHeight;
  }
}
