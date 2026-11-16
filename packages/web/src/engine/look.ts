// How the media-toolbox renders a Short (workers/render/shorts_build.py), redone for a live canvas:
// backdrop gradient, cropped/zoomed "cards", ASS title styles, word-by-word captions. The numbers here
// mirror that file so the preview looks like the export.
import type { TitleClip, Word } from '@mangoai/core';

/** The toolbox's colour names (ASS &HBBGGRR converted to #RRGGBB). */
export const COLORS: Record<string, string> = {
  white: '#FFFFFF', yellow: '#FFD400', green: '#3DDC84', red: '#FF4D4D', orange: '#D97757', grey: '#A0A0A0',
  blue: '#50A0F0', darkgreen: '#2B9E34', ink: '#1E1F24', card: '#20222A', black: '#000000',
};

export function color(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const k = c.trim().toLowerCase();
  if (COLORS[k]) return COLORS[k];
  if (/^#?[0-9a-f]{6}$/i.test(k)) return `#${k.replace('#', '')}`.toUpperCase();
  const ass = /^&h([0-9a-f]{2})?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(k);
  if (ass) return `#${ass[4]}${ass[3]}${ass[2]}`.toUpperCase();
  if (/^0x[0-9a-f]{6}$/i.test(k)) return `#${k.slice(2)}`.toUpperCase();
  return fallback;
}

interface AssStyle {
  size: number;
  heavy: boolean;
  outline: number;
  shadow: number;
  spacing: number;
  /** 5 = centre, 7 = top-left */
  align: 5 | 7;
  /** BorderStyle 3: an opaque box behind the text in the outline colour. */
  box: boolean;
  outlineColor: string;
  shadowAlpha: number;
}

export const STYLES: Record<string, AssStyle> = {
  Cap: { size: 82, heavy: true, outline: 7, shadow: 3, spacing: 0, align: 5, box: false, outlineColor: '#000', shadowAlpha: 0.61 },
  Head: { size: 66, heavy: true, outline: 6, shadow: 3, spacing: 1, align: 5, box: false, outlineColor: '#000', shadowAlpha: 0.61 },
  Big: { size: 168, heavy: true, outline: 9, shadow: 4, spacing: 0, align: 5, box: false, outlineColor: '#000', shadowAlpha: 0.61 },
  Tag: { size: 54, heavy: true, outline: 16, shadow: 0, spacing: 2, align: 5, box: true, outlineColor: COLORS.red!, shadowAlpha: 0 },
  Card: { size: 50, heavy: false, outline: 0, shadow: 0, spacing: 0, align: 7, box: false, outlineColor: '#000', shadowAlpha: 0 },
};

/** libass sizes fonts by line height; canvas by em. Tuned against the toolbox's own preview.mp4. */
export const ASS_FONT_SCALE = 0.75;
/** Canvas strokes are centred on the glyph edge; this matches libass's outside border width by eye. */
const OUTLINE = 1.6;
const HEAVY = '"Segoe UI Black", "Segoe UI", "Noto Sans", Arial, sans-serif';
const REGULAR = '"Segoe UI", "Noto Sans", Arial, sans-serif';

function font(style: AssStyle, fs: number, bold: boolean | undefined) {
  const px = fs * ASS_FONT_SCALE;
  if (style.heavy) return `900 ${px}px ${HEAVY}`;
  return `${bold ? 700 : 400} ${px}px ${REGULAR}`;
}

/** The toolbox's POP: 70% → 108% over 140 ms → 100% at 220 ms. */
function popScale(ms: number): number {
  if (ms >= 220) return 1;
  if (ms < 140) return 0.7 + (1.08 - 0.7) * (ms / 140);
  return 1.08 + (1 - 1.08) * ((ms - 140) / 80);
}

type Run = { text: string; color: string };

function drawLines(ctx: CanvasRenderingContext2D, lines: Run[][], x: number, y: number, st: AssStyle, fs: number, opts: { bold?: boolean; strike?: boolean; boxColor?: string }) {
  ctx.font = font(st, fs, opts.bold);
  ctx.letterSpacing = `${st.spacing}px`;
  ctx.textBaseline = 'middle';
  const lineH = fs * ASS_FONT_SCALE * 1.22;
  const widths = lines.map((l) => l.reduce((w, r) => w + ctx.measureText(r.text).width, 0));
  const blockW = Math.max(0, ...widths);
  const blockH = lineH * lines.length;
  const top = st.align === 5 ? y - blockH / 2 : y;
  lines.forEach((line, li) => {
    const w = widths[li]!;
    const left = st.align === 5 ? x - w / 2 : x;
    // libass centres outlined text a little lower than canvas 'middle' does
    const cy = top + lineH * (li + 0.5) + (st.box ? 0 : fs * ASS_FONT_SCALE * 0.1);
    if (st.box) {
      const pad = st.outline;
      ctx.fillStyle = opts.boxColor ?? st.outlineColor;
      ctx.fillRect(left - pad, cy - lineH / 2 - pad + lineH * 0.08, w + pad * 2, lineH + pad * 2 - lineH * 0.16);
    }
    let cx = left;
    for (const run of line) {
      if (st.shadow && st.shadowAlpha) {
        ctx.fillStyle = `rgba(0,0,0,${st.shadowAlpha})`;
        if (st.outline) {
          ctx.lineWidth = st.outline * OUTLINE;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = `rgba(0,0,0,${st.shadowAlpha})`;
          ctx.strokeText(run.text, cx + st.shadow, cy + st.shadow);
        }
        ctx.fillText(run.text, cx + st.shadow, cy + st.shadow);
      }
      if (st.outline && !st.box) {
        ctx.lineWidth = st.outline * OUTLINE;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(run.text, cx, cy);
      }
      ctx.fillStyle = run.color;
      ctx.fillText(run.text, cx, cy);
      const rw = ctx.measureText(run.text).width;
      if (opts.strike) {
        ctx.fillRect(cx, cy - fs * 0.04, rw, Math.max(2, fs * 0.07));
      }
      cx += rw;
    }
  });
  void blockW;
}

function splitLines(text: string): string[] {
  return text.split(/\\N|\n/);
}

export function titleLayer(c: TitleClip): number {
  if (c.layer !== undefined) return c.layer;
  if (c.shape) return 2;
  return c.style === 'Tag' ? 3 : 1;
}

/** Draw one title at clip-local time `local` (seconds) and clip length `dur`. Coordinates are 1080×1920. */
export function drawTitle(ctx: CanvasRenderingContext2D, c: TitleClip, local: number, dur: number) {
  const st = STYLES[c.style ?? 'Head'] ?? STYLES.Head!;
  const [x, y] = c.pos ?? [540, 960];
  ctx.save();
  if (c.fade) {
    const [fin, fout] = c.fade;
    const ms = local * 1000;
    const msLeft = (dur - local) * 1000;
    let a = 1;
    if (fin > 0 && ms < fin) a = Math.min(a, ms / fin);
    if (fout > 0 && msLeft < fout) a = Math.min(a, msLeft / fout);
    ctx.globalAlpha = Math.max(0, a);
  }
  if (c.pop ?? true) {
    const s = popScale(local * 1000);
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.translate(-x, -y);
  }
  if (c.shape) {
    const sh = c.shape as { w: number; h: number; r?: number; fill?: string; border?: string; bord?: number };
    const r = sh.r ?? 36;
    ctx.beginPath();
    ctx.roundRect(x, y, sh.w, sh.h, r);
    ctx.fillStyle = color(sh.fill, COLORS.card!);
    ctx.fill();
    const bord = sh.bord ?? 4;
    if (bord > 0) {
      ctx.lineWidth = bord * 2;
      ctx.strokeStyle = color(sh.border, COLORS.white!);
      ctx.stroke();
    }
  } else {
    const fs = c.fs ?? st.size;
    const base = color(c.color, '#FFFFFF');
    let lines: Run[][];
    if (c.runs) {
      lines = [[]];
      for (const [text, col] of c.runs) {
        splitLines(text).forEach((part, i) => {
          if (i > 0) lines.push([]);
          lines[lines.length - 1]!.push({ text: part, color: color(col, base) });
        });
      }
    } else lines = splitLines(c.text ?? '').map((l) => [{ text: l, color: base }]);
    const opts: { bold?: boolean; strike?: boolean; boxColor?: string } = {};
    if (c.bold !== undefined) opts.bold = c.bold;
    if (c.strike) opts.strike = true;
    if (c.box) opts.boxColor = color(c.box, st.outlineColor);
    drawLines(ctx, lines, x, y, st, fs, opts);
  }
  ctx.restore();
}

// --- captions --------------------------------------------------------------------------------

export interface CaptionGroup {
  start: number;
  end: number;
  words: Word[];
}

/** Same grouping as caption_events(): max_words per group, or break after . , ? ! */
export function captionGroups(words: readonly Word[], end: number, maxWords: number): CaptionGroup[] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length === maxWords || /[.,?!]$/.test(w.w)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({ start: g[0]!.s, end: i + 1 < groups.length ? groups[i + 1]![0]!.s : end, words: g }));
}

export function findGroup(groups: CaptionGroup[], t: number): CaptionGroup | null {
  let lo = 0;
  let hi = groups.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = groups[mid]!;
    if (t < g.start) hi = mid - 1;
    else if (t >= g.end) lo = mid + 1;
    else return g;
  }
  return null;
}

export function drawCaption(ctx: CanvasRenderingContext2D, g: CaptionGroup, t: number, y: number) {
  const st = STYLES.Cap!;
  let cur = 0;
  g.words.forEach((w, i) => {
    if (i === 0 || w.s <= t) cur = i;
  });
  const clean = (s: string) => s.toUpperCase().replace(/[.,]+$/, '');
  const runs: Run[] = [];
  g.words.forEach((w, i) => {
    runs.push({ text: clean(w.w) + (i < g.words.length - 1 ? ' ' : ''), color: i === cur ? COLORS.yellow! : COLORS.white! });
  });
  ctx.save();
  if (cur === 0) {
    const ms = (t - g.start) * 1000;
    const s = ms >= 90 ? 1 : 0.85 + 0.15 * (ms / 90);
    ctx.translate(540, y);
    ctx.scale(s, s);
    ctx.translate(-540, -y);
  }
  drawLines(ctx, [runs], 540, y, st, st.size, {});
  ctx.restore();
}

// --- cards -----------------------------------------------------------------------------------

/** Smoothstep-eased zoom keys, exactly like the toolbox's _keyed(); returns [zoom, fx, fy]. */
export function keyed(keys: [number, number, number, number][], it: number): [number, number, number] {
  const last = keys[keys.length - 1]!;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (it < b[0]) {
      const s = Math.min(1, Math.max(0, (it - a[0]) / Math.max(b[0] - a[0], 1e-3)));
      const e = s * s * (3 - 2 * s);
      return [a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e, a[3] + (b[3] - a[3]) * e];
    }
  }
  return [last[1], last[2], last[3]];
}

export interface CardGeometry {
  /** Source rectangle in source pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination in frame pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Where a layer's crop lands in the 1080×1920 frame at clip-local time `it`. */
export function cardGeometry(region: [number, number, number, number], cardW: number, cy: number, keys: [number, number, number, number][] | undefined, it: number): CardGeometry {
  const [x, y, w, h] = region;
  const ch = Math.round((cardW * h) / w / 2) * 2;
  const ks = keys && keys.length ? keys : [[0, 1, w / 2, h / 2] as [number, number, number, number]];
  const [z, fx, fy] = keyed(ks, it);
  const vw = w / z;
  const vh = h / z;
  const ox = Math.min(Math.max(fx - vw / 2, 0), w - vw);
  const oy = Math.min(Math.max(fy - vh / 2, 0), h - vh);
  return { sx: x + ox, sy: y + oy, sw: vw, sh: vh, dx: Math.round((1080 - cardW) / 2), dy: Math.round(cy - ch / 2), dw: cardW, dh: ch };
}
