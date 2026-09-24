// Pixel-art face painter: turns ONE exact colour into a shaded, textured cube face.
// Pure (no Blockbench), so it is unit-testable and previewable in Node; the plugin's
// shade_cube(s) paints its output into each face's UV rect.
//
// History: the first shade_cube painted three flat bands per side — stripy and plastic.
// The second version shaded every pixel but dithered everywhere, which read as noise
// ("ant war"). This one works like a pixel artist:
//   1. palettes in OKLab, so shades step evenly and never turn muddy grey;
//   2. each material paints STRUCTURE (stone blocks and cracks, crystal facets, fur
//      locks, scratches, growth rings, stitches, …) into a value field;
//   3. shared light from above is added (top bright, bottom dark, lit rim, contact shadow);
//   4. values are quantised with only as much dithering as `smoothing` allows;
//   5. a clean-up pass folds lone pixels into the colour cluster around them.
// `smoothing` (0..1) runs from grainy dithered pixel art to clean clusters and soft
// gradients; each material has its own default.

export type FaceKey = "north" | "south" | "east" | "west" | "up" | "down";

export const MATERIALS = [
  "generic", "fur", "skin", "leather", "cloth", "wood", "planks", "stone", "metal", "gem", "plant",
  "dungeon_stone", "crystal", "monster_fur", "ancient_metal", "wavy_wood", "magma", "moss", "water", "ice",
] as const;
export type Material = (typeof MATERIALS)[number];

export interface FacePaintOptions {
  /** The part's exact colour; the painter builds the palettes its material needs from it. */
  color?: string;
  /** Or a hand-picked palette, dark → light (3–9 colours), used as the main palette as is. */
  ramp?: string[];
  material?: Material;
  /** Per-cube seed so repeated parts don't look stamped. */
  seed?: number;
  /** 0..2 — how strong the material pattern is (default 1). */
  detail?: number;
  /** 0..2 — how strong the shared light and shadow are (default 1). */
  lighting?: number;
  /** 0..1 — 0 = grainy dithered pixel art, 1 = clean colour clusters and soft gradients. */
  smoothing?: number;
  /** Brighter centre stripe on north/south faces (blade sheen). */
  sheen?: boolean;
}

// ---- colour: sRGB <-> OKLab/OKLCH ---------------------------------------------
type RGB = [number, number, number];
export const hexToRgb = (hex: string): RGB => {
  const h = String(hex || "#000000").replace("#", "").trim();
  const s = (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).slice(0, 6).padEnd(6, "0");
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (c: RGB): string =>
  "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const normHex = (hex: string): string => rgbToHex(hexToRgb(hex));
const toLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** [L 0..1, C, H degrees] */
function toOklch(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
function fromOklch(L: number, C: number, H: number): RGB | null {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  if (lin.some((v) => v < -0.0005 || v > 1.0005)) return null;
  return lin.map(fromLinear) as RGB;
}
/** OKLCH → hex; chroma is pulled in until the colour fits sRGB (lightness and hue kept). */
function oklchHex(L: number, C: number, H: number): string {
  L = Math.max(0, Math.min(1, L));
  const direct = fromOklch(L, Math.max(0, C), H);
  if (direct) return rgbToHex(direct);
  let lo = 0, hi = Math.max(0, C), best = fromOklch(L, 0, H) || ([L * 255, L * 255, L * 255] as RGB);
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const rgb = fromOklch(L, mid, H);
    if (rgb) { best = rgb; lo = mid; } else hi = mid;
  }
  return rgbToHex(best);
}
// Turn hue h toward `target` by at most `deg` degrees, the short way round.
const hueToward = (h: number, target: number, deg: number) => {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), Math.max(0, deg));
};

export interface RampStyle {
  /** Spread between the darkest and lightest shade (default 1). */
  contrast?: number;
  /** Saturation multiplier (default 1). */
  chroma?: number;
}

/**
 * Palette from ONE colour, dark → light, the exact colour in the middle. Built in OKLCH
 * so the steps look even: shadows turn a little toward blue and get richer, highlights
 * turn toward warm yellow and paler — the classic pixel-art ramp, never grey mixing.
 */
export function rampFromBase(hex: string, steps = 9, style: RampStyle = {}): string[] {
  const base = normHex(hex);
  const [L0, C0, H0] = toOklch(hexToRgb(base));
  const contrast = style.contrast ?? 1, chroma = style.chroma ?? 1;
  const mid = (steps - 1) / 2;
  const darkL = Math.max(0.08, L0 - L0 * 0.6 * contrast);
  const lightL = Math.min(0.985, L0 + (0.985 - L0) * 0.66 * contrast);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const k = (i - mid) / mid;
    if (Math.abs(k) < 1e-9) { out.push(base); continue; }
    const a = Math.abs(k);
    out.push(k < 0
      ? oklchHex(L0 + (darkL - L0) * a, C0 * chroma * (1 + 0.12 * a), hueToward(H0, 265, 16 * a))
      : oklchHex(L0 + (lightL - L0) * a, C0 * chroma * (1 - 0.45 * a), hueToward(H0, 95, 14 * a)));
  }
  return out;
}

// Molten heat: dark crust red → the base orange → yellow → almost white.
function heatRamp(base: string): string[] {
  const [, C0, H0] = toOklch(hexToRgb(base));
  const out: string[] = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const L = 0.2 + 0.78 * Math.pow(t, 0.9);
    const H = t < 0.5 ? hueToward(H0, 28, (0.5 - t) * 2 * 22) : hueToward(H0, 98, (t - 0.5) * 2 * 48);
    const C = Math.max(0.02, (C0 || 0.16) * (t < 0.65 ? 0.85 + 0.35 * t : 1.08 - (t - 0.65) * 2.6));
    out.push(oklchHex(L, C, H));
  }
  return out;
}
const shadeOf = (base: string, L: number, C: number, H?: number) => {
  const [, , H0] = toOklch(hexToRgb(base));
  return oklchHex(L, C, H ?? H0);
};

// ---- deterministic noise ------------------------------------------------------
const hash = (x: number, y: number, seed: number): number => {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 100000) / 100000; // [0,1)
};
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Smooth value noise in [0,1): clusters about sx × sy pixels. */
const valueNoise = (x: number, y: number, sx: number, sy: number, seed: number): number => {
  const fx = x / sx, fy = y / sy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smooth(fx - x0), ty = smooth(fy - y0);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * tx, bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
};
const centred = (v: number) => (v - 0.5) * 2; // [0,1) → [-1,1)
// 4x4 Bayer thresholds, mixed with a little noise so the pattern isn't mechanical.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);
const threshold = (x: number, y: number, seed: number) =>
  0.5 + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * 0.75 + (hash(x, y, seed) - 0.5) * 0.25;

// ---- the value field a material paints into ------------------------------------
// v: -1 (darkest shade) … 0 (base) … +1 (lightest), in "half palettes".
interface Cell { v: number; pal: number; hard: boolean; lit: number }
interface Field {
  w: number; h: number; face: FaceKey; side: boolean; seed: number; detail: number;
  /** long axis of the face, for grain and flow */
  along: "x" | "y";
  cells: Cell[];
}
const cellAt = (f: Field, x: number, y: number) => f.cells[y * f.w + x];
const inside = (f: Field, x: number, y: number) => x >= 0 && y >= 0 && x < f.w && y < f.h;
const put = (f: Field, x: number, y: number, v: number, extra: Partial<Cell> = {}) => {
  if (!inside(f, x, y)) return;
  const c = cellAt(f, x, y);
  c.v = v;
  Object.assign(c, extra);
};
const each = (f: Field, fn: (x: number, y: number, c: Cell) => void) => {
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) fn(x, y, cellAt(f, x, y));
};
const line = (x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number, i: number, n: number) => void) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) fn(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), i, n);
};
const H = (f: Field, x: number, y: number, k: number) => hash(x, y, f.seed + k * 7919);
const N = (f: Field, x: number, y: number, sx: number, sy: number, k: number) => centred(valueNoise(x, y, sx, sy, f.seed + k * 7919));

interface MaterialSpec {
  /** Palettes; [0] is the main one. `given` = a hand-picked palette, if the caller passed one. */
  palettes?: (base: string, given: string[] | null) => string[][];
  paint: (f: Field) => void;
  smoothing?: number;
  /** 0..1 dithering strength before smoothing is applied (default 1). */
  dither?: number;
  /** Multiplier on the shared light (default 1). */
  lighting?: number;
}
const main = (style?: RampStyle) => (base: string, given: string[] | null) => [given || rampFromBase(base, 9, style)];

const SPECS: Record<Material, MaterialSpec> = {
  generic: { smoothing: 0.55, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * (0.17 * N(f, x, y, 2.6, 2.6, 0) + 0.06 * N(f, x, y, 1.3, 1.3, 1)); }) },
  fur: {
    smoothing: 0.5,
    paint: (f) => each(f, (x, y, c) => {
      const hair = H(f, x, Math.floor(y / 2), 3);
      c.v = f.detail * (0.2 * N(f, x, y, 1, 3.2, 0) + (hair > 0.9 ? 0.18 : hair < 0.08 ? -0.2 : 0));
    }),
  },
  skin: { smoothing: 0.7, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * 0.12 * N(f, x, y, 3.5, 3.5, 0); }) },
  cloth: { smoothing: 0.45, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * (((x + y) % 2 === 0 ? 0.07 : -0.07) + 0.1 * N(f, x, y, 3, 3, 0)); }) },
  wood: {
    smoothing: 0.55,
    paint: (f) => each(f, (x, y, c) => {
      const [u, t] = f.along === "y" ? [x, y] : [y, x];
      c.v = f.detail * (0.2 * N(f, u, t, 1, 5, 0) + (H(f, u, 0, 5) > 0.72 ? -0.16 : 0));
    }),
  },
  planks: {
    smoothing: 0.6,
    paint: (f) => each(f, (x, y, c) => {
      const [u, t] = f.along === "y" ? [x, y] : [y, x];
      const board = Math.floor(t / 4);
      if (t % 4 === 3) { c.v = -0.42; c.hard = true; return; }
      c.v = f.detail * (0.13 * centred(H(f, board, 0, 9)) + 0.12 * N(f, u, t, 4, 1, board));
    }),
  },
  stone: {
    smoothing: 0.55,
    paint: (f) => each(f, (x, y, c) => {
      if (H(f, x, y, 13) > 0.95) { c.v = -0.3; c.hard = true; return; }
      c.v = f.detail * (0.18 * N(f, x, y, 2, 2, 0) + 0.1 * N(f, x, y, 5, 5, 1));
    }),
  },
  metal: {
    smoothing: 0.7,
    paint: (f) => each(f, (x, y, c) => {
      const u = f.w > 1 ? x / (f.w - 1) : 0.5;
      c.v = f.detail * 0.04 * N(f, x, y, 4, 4, 0) + (f.side ? 0.26 * Math.max(0, 1 - Math.abs(u - 0.3) * 5) : 0);
    }),
  },
  gem: { smoothing: 0.6, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * (Math.sin((x - y) * 0.9 + f.seed) > 0.2 ? 0.13 : -0.08); }) },
  plant: {
    smoothing: 0.6,
    paint: (f) => each(f, (x, y, c) => { c.v = f.detail * (0.2 * N(f, x, y, 1.8, 1.8, 0) + (H(f, x, y, 17) > 0.9 ? 0.2 : 0)); }),
  },

  // Worked leather: smooth warm surface, lighter worn edges, a dark stitch line.
  leather: {
    smoothing: 0.75,
    paint: (f) => {
      each(f, (x, y, c) => {
        c.v = f.detail * 0.07 * N(f, x, y, 4, 4, 0);
        const edge = Math.min(x, y, f.w - 1 - x, f.h - 1 - y);
        if (edge === 0 && H(f, x, y, 5) > 0.3) c.v += 0.24;
        else if (edge === 1 && H(f, x, y, 6) > 0.8) c.v += 0.12;
      });
      if (f.w >= 6 && f.h >= 5) {
        if (f.w >= f.h) {
          for (const sy of f.h >= 8 ? [2, f.h - 3] : [1, f.h - 2]) for (let x = 2; x <= f.w - 3; x++) if ((x + sy) % 2 === 0) put(f, x, sy, -0.95, { hard: true });
        } else {
          for (const sx of f.w >= 8 ? [2, f.w - 3] : [1, f.w - 2]) for (let y = 2; y <= f.h - 3; y++) if ((y + sx) % 2 === 0) put(f, sx, y, -0.95, { hard: true });
        }
      }
    },
  },

  // Dungeon stone: big smooth blocks in a running bond, dark mortar cracks, a lit
  // bevel top-left and a shaded bevel bottom-right, the odd crack through a block.
  dungeon_stone: {
    smoothing: 0.85, dither: 0.5, lighting: 0.8,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.15 })],
    paint: (f) => {
      const nbx = Math.max(1, Math.round(f.w / 8)), nby = Math.max(1, Math.round(f.h / 6));
      const bw = f.w / nbx, bh = f.h / nby;
      each(f, (x, y, c) => {
        const by = Math.floor(y / bh);
        const off = by % 2 ? bw / 2 : 0;
        const bx = Math.floor((x + off) / bw);
        const lx = x + off - bx * bw, ly = y - by * bh;
        const tone = 0.12 * centred(H(f, bx, by, 21));
        if ((f.w >= 5 && lx < 1) || (f.h >= 5 && ly < 1)) { c.v = -0.95; c.hard = true; return; }
        if (lx < 2 || ly < 2) { c.v = tone + 0.34; c.hard = true; return; }
        if (lx >= bw - 1 || ly >= bh - 1) { c.v = tone - 0.34; c.hard = true; return; }
        c.v = tone + 0.14 * (0.5 - (lx / bw + ly / bh) / 2) + f.detail * 0.05 * N(f, x, y, 4, 4, 0);
      });
      // A few blocks get a crack running down through them.
      for (let by = 0; by < nby; by++) for (let bx = -1; bx <= nbx; bx++) {
        if (H(f, bx, by, 22) < 0.62) continue;
        const off = by % 2 ? bw / 2 : 0;
        let cx = Math.round(bx * bw - off + 2 + H(f, bx, by, 23) * Math.max(1, bw - 4));
        const len = 2 + Math.floor(H(f, bx, by, 24) * (bh - 2));
        for (let i = 0; i < len; i++) {
          put(f, cx, Math.round(by * bh + 1 + i), -0.85, { hard: true });
          cx += H(f, cx, i, 25) > 0.5 ? 1 : -1;
        }
      }
    },
  },

  // Mana crystal: flat, sharp facets (no dithering), a glowing core that fades to dark
  // edges, bright glassy facet edges and a sparkle or two.
  crystal: {
    smoothing: 1, dither: 0, lighting: 0.35,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.45, chroma: 1.2 })],
    paint: (f) => {
      const k = Math.max(3, Math.min(8, Math.round((f.w * f.h) / 18)));
      const pts = Array.from({ length: k }, (_, i) => [H(f, i, 0, 31) * (f.w - 1), H(f, i, 1, 32) * (f.h - 1)]);
      const shade = pts.map(([px, py], i) => 0.42 * centred(H(f, i, 2, 33)) + 0.45 * (0.5 - (px / Math.max(1, f.w - 1) + py / Math.max(1, f.h - 1)) / 2));
      const cx = (f.w - 1) / 2, cy = (f.h - 1) / 2;
      each(f, (x, y, c) => {
        const d = pts.map(([px, py]) => Math.hypot(x - px, y - py));
        const order = d.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
        const r = Math.hypot((x - cx) / Math.max(1, f.w / 2), (y - cy) / Math.max(1, f.h / 2)) / Math.SQRT2;
        const glow = 0.95 * Math.pow(Math.max(0, 1 - r), 1.4) - 0.45;
        c.v = glow + shade[order[0][1]];
        if (order.length > 1 && order[1][0] - order[0][0] < 0.75) c.v = Math.max(c.v, shade[order[1][1]]) + 0.35; // glassy facet edge
        if (r < 0.35 && H(f, x, y, 34) > 0.93) c.v = 1;                      // sparkle
        c.hard = true;
      });
    },
  },

  // Monster fur: overlapping locks — light at the root, darker at the tip — over dark
  // underfur, lower locks covering the tips above them.
  monster_fur: {
    smoothing: 0.7, dither: 0.5,
    paint: (f) => {
      // Dark underfur shows only in the gaps between locks.
      each(f, (x, y, c) => { c.v = -0.55 + 0.05 * N(f, x, y, 3, 3, 0); c.hard = true; });
      const sx = 4, sy = 5;
      for (let r = -1; r <= Math.ceil(f.h / sy) + 1; r++) for (let col = -1; col <= Math.ceil(f.w / sx); col++) {
        // One lock: wide at the root, tapering to a point, lit from the left, shaded on
        // the right and under the tip; rows paint top → bottom so locks overlap like shingles.
        const tx = col * sx + (r % 2 ? 2 : 0) + Math.round((H(f, col, r, 41) - 0.5) * 1.4);
        const ty = r * sy - 1 + Math.round((H(f, col, r, 42) - 0.5) * 2);
        const len = 6 + Math.floor(H(f, col, r, 43) * 3);
        const lean = H(f, col, r, 44) < 0.5 ? -1 : 1;
        const tone = 0.08 * centred(H(f, col, r, 45));
        for (let i = 0; i < len; i++) {
          const t = i / len;
          const width = Math.max(1, Math.round(3 * (1 - t) + 0.4));
          const cx = tx + (t > 0.6 ? lean : 0);
          const x0 = cx - Math.floor(width / 2);
          for (let k = 0; k < width; k++) {
            const edgeRight = k === width - 1 && width > 2;
            const v = tone + f.detail * (0.46 - 0.6 * t - (edgeRight ? 0.2 : 0));
            put(f, x0 + k, ty + i, v, { hard: true });
          }
        }
        put(f, tx + lean, ty + len, -0.42, { hard: false }); // soft shadow under the tip
      }
    },
  },

  // Worn ancient metal: brushed base, a lit top edge and specular band, scratch lines
  // with a dark groove, and rust creeping in from the edges.
  ancient_metal: {
    smoothing: 0.7, dither: 0.5, lighting: 1.05,
    palettes: (base, given) => {
      const [L0] = toOklch(hexToRgb(base));
      return [given || rampFromBase(base, 9), rampFromBase(shadeOf(base, Math.min(0.55, L0 * 0.8), 0.11, 48), 7)];
    },
    paint: (f) => {
      each(f, (x, y, c) => {
        const [u, t] = f.along === "y" ? [x, y] : [y, x];
        c.v = f.detail * 0.05 * N(f, u, t, 1, 6, 0);
        if (f.side && y === 0) { c.v += 0.45; c.hard = true; }
        const band = Math.abs(x / Math.max(1, f.w) - y / Math.max(1, f.h) - 0.1);
        if (band < 0.12) c.v += 0.22;
      });
      const count = 1 + Math.floor(H(f, 0, 0, 51) * Math.min(4, 1 + (f.w * f.h) / 60));
      for (let i = 0; i < count; i++) {
        const x0 = Math.floor(H(f, i, 1, 52) * f.w), y0 = Math.floor(H(f, i, 2, 53) * f.h);
        const len = 3 + Math.floor(H(f, i, 3, 54) * Math.min(6, f.w));
        const slope = (H(f, i, 4, 55) - 0.5) * 1.2;
        line(x0, y0, x0 + len, Math.round(y0 + len * slope), (x, y) => {
          put(f, x, y, 0.55, { hard: true });
          if (inside(f, x, y + 1) && cellAt(f, x, y + 1).v < 0.5) put(f, x, y + 1, -0.3, { hard: true });
        });
      }
      each(f, (x, y, c) => {
        const edge = Math.max(0, 1 - Math.min(x, y, f.w - 1 - x, f.h - 1 - y) / 2.5);
        const rust = 0.7 * valueNoise(x, y, 2.5, 2.5, f.seed + 60) + 0.45 * edge;
        if (rust > 0.78) { c.pal = 1; c.v = 0.25 * N(f, x, y, 1.5, 1.5, 61) - 0.05; c.hard = false; }
      });
    },
  },

  // Stylised wavy wood: bark ridges flowing along the trunk on the sides, wobbly
  // growth rings on the end faces; colours melt softly along the flow.
  wavy_wood: {
    smoothing: 0.75, dither: 0.45,
    paint: (f) => {
      if (!f.side) {
        const cx = (f.w - 1) / 2, cy = (f.h - 1) / 2;
        each(f, (x, y, c) => {
          const ang = Math.atan2(y - cy, x - cx);
          const r = Math.hypot(x - cx, y - cy) + 0.7 * Math.sin(ang * 3 + f.seed);
          c.v = 0.1 + f.detail * 0.24 * Math.cos((2 * Math.PI * r) / 2.4);
          if (Math.min(x, y, f.w - 1 - x, f.h - 1 - y) === 0) { c.v = -0.55; c.hard = true; }
        });
        return;
      }
      each(f, (x, y, c) => {
        const [across, t] = f.along === "y" ? [x, y] : [y, x];
        const flow = across + 1.3 * Math.sin(t * 0.45 + f.seed * 0.01 + across * 0.2);
        c.v = f.detail * 0.24 * Math.cos((2 * Math.PI * flow) / 3.4) + 0.05 * N(f, x, y, 3, 3, 0);
        const ridge = ((flow / 4) % 1 + 1) % 1;
        if (ridge < 0.16) c.v -= 0.34;
      });
    },
  },

  // Magma: a molten heat field (near-white yellow → red) under dark, sharp-edged crust
  // plates whose rims glow; the molten part lights itself, the crust takes the light.
  magma: {
    smoothing: 0.65, dither: 0.6, lighting: 0.8,
    palettes: (base) => [heatRamp(base), rampFromBase(shadeOf(base, 0.26, 0.025), 5, { contrast: 0.9 })],
    paint: (f) => {
      const crust: boolean[] = [];
      each(f, (x, y) => { crust[y * f.w + x] = valueNoise(x, y, 3.2, 3.2, f.seed + 50) > 0.6; });
      const isCrust = (x: number, y: number) => inside(f, x, y) && crust[y * f.w + x];
      each(f, (x, y, c) => {
        if (isCrust(x, y)) {
          c.pal = 1; c.hard = true; c.lit = 0.8;
          c.v = -0.1 + 0.15 * N(f, x, y, 2, 2, 51) + (!isCrust(x, y - 1) ? 0.45 : 0);
          return;
        }
        const heat = 0.65 * valueNoise(x, y, 5, 2.6, f.seed) + 0.35 * valueNoise(x, y, 2, 1.4, f.seed + 3);
        const rim = isCrust(x - 1, y) || isCrust(x + 1, y) || isCrust(x, y - 1) || isCrust(x, y + 1) ? 0.3 : 0;
        c.v = (heat - 0.45) * 2.2 * f.detail + rim;
        c.lit = 0.2;
      });
    },
  },

  // Magic moss: big saturated patches, painterly (no static grain), bright tuft tips.
  moss: {
    smoothing: 0.9, dither: 0.25,
    palettes: (base, given) => [given || rampFromBase(base, 9, { chroma: 1.3 })],
    paint: (f) => {
      each(f, (x, y, c) => { c.v = f.detail * (0.32 * N(f, x, y, 3.2, 3.2, 0) + 0.1 * N(f, x, y, 1.6, 1.6, 1)); });
      if (f.side) {
        for (let x = 0; x < f.w; x++) {
          if (H(f, x, 0, 71) < 0.45) continue;
          const len = 1 + Math.floor(H(f, x, 1, 72) * 3);
          for (let i = 0; i < len; i++) put(f, x, i, 0.4 - i * 0.12, { hard: true });
        }
      } else {
        each(f, (x, y, c) => { if (H(f, x, y, 73) > 0.93) { c.v = 0.45; c.hard = true; } });
      }
    },
  },

  // Deep clear water: light surface with wavy highlight lines, easing smoothly into
  // deep dark blue with depth; it lights itself, so shared light stays weak.
  water: {
    smoothing: 0.8, dither: 0.55, lighting: 0.3,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.2 })],
    paint: (f) => {
      each(f, (x, y, c) => {
        const t = f.h > 1 ? y / (f.h - 1) : 0.5;
        if (f.face === "up") c.v = 0.42 + 0.06 * N(f, x, y, 4, 4, 0);
        else if (f.face === "down") c.v = -0.8;
        else c.v = 0.55 - 1.3 * smooth(Math.max(0, Math.min(1, t + 0.06 * Math.sin(x * 0.55 + y * 0.35 + f.seed)))) + 0.05 * N(f, x, y, 3, 2, 0);
        const wave = f.face === "up" ? (y + Math.round(Math.sin(x * 0.7 + f.seed) * 1.2)) % 3 === 0
          : f.face !== "down" && t < 0.5 && Math.sin(x * 0.75 + y * 1.9 + f.seed) > 0.93;
        if (wave) c.v += f.face === "up" ? 0.3 : 0.35 * (1 - t * 2);
      });
    },
  },

  // Glacier ice: pale smooth surface, dark fracture lines deep inside with a bright
  // refraction beside them, and a few glints.
  ice: {
    smoothing: 0.8, dither: 0.3, lighting: 0.6,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 0.95 })],
    paint: (f) => {
      each(f, (x, y, c) => {
        const t = f.h > 1 ? y / (f.h - 1) : 0.5;
        c.v = 0.2 - 0.25 * t + 0.05 * N(f, x, y, 4, 4, 0);
      });
      const cracks = 1 + Math.floor(H(f, 0, 0, 81) * (f.w * f.h >= 64 ? 3 : 2));
      for (let i = 0; i < cracks; i++) {
        const x0 = Math.floor(H(f, i, 1, 82) * f.w), y0 = Math.floor(H(f, i, 2, 83) * f.h);
        const x1 = Math.floor(H(f, i, 3, 84) * f.w), y1 = Math.floor(H(f, i, 4, 85) * f.h);
        line(x0, y0, x1, y1, (x, y, j) => {
          put(f, x, y, -0.48, { hard: true });
          if (j % 3 !== 2) put(f, x + 1, y, 0.38, { hard: true });
        });
      }
      each(f, (x, y, c) => { if (H(f, x, y, 86) > 0.965) { c.v = 1; c.hard = true; } });
    },
  },
};

// Shared light from above, in half-palettes: faces facing up are bright, the bottom dark;
// sides fade top→bottom with a lit rim and a contact shadow.
function lightAt(face: FaceKey, x: number, y: number, w: number, h: number, sheen: boolean): number {
  const u = w > 1 ? x / (w - 1) : 0.5, v = h > 1 ? y / (h - 1) : 0.5;
  const base: Record<FaceKey, number> = { up: 0.36, north: 0.08, south: -0.02, east: -0.1, west: -0.1, down: -0.42 };
  let val = base[face];
  if (face === "up") {
    val += 0.2 - 0.4 * ((u + v) / 2);
    if (w >= 4 && h >= 4 && (x === w - 1 || y === h - 1)) val -= 0.14;
    if (w >= 4 && h >= 4 && (x === 0 || y === 0)) val += 0.1;
  } else if (face === "down") {
    val -= 0.06 * (1 - Math.abs(u - 0.5) * 2);
  } else {
    val += 0.3 - 0.6 * smooth(v);
    if (h >= 3 && y === 0) val += 0.16;
    if (h >= 3 && y === h - 1) val -= 0.2;
    if (w >= 4 && (x === 0 || x === w - 1)) val -= 0.08;
    if (sheen && w >= 3 && (face === "north" || face === "south") && Math.abs(x - (w - 1) / 2) < 0.6) val += 0.28;
  }
  return val;
}

/** Paint one face: rows[y][x] of hex colours for a w×h face. */
export function paintFace(face: FaceKey, w: number, h: number, o: FacePaintOptions): string[][] {
  const material: Material = o.material && (MATERIALS as readonly string[]).includes(o.material) ? o.material : "generic";
  const spec = SPECS[material];
  const given = o.ramp && o.ramp.length ? o.ramp : null;
  const base = o.color ? normHex(o.color) : given ? given[Math.floor((given.length - 1) / 2)] : "#808080";
  const palettes = (spec.palettes || main())(base, given);
  const smoothing = Math.max(0, Math.min(1, o.smoothing ?? spec.smoothing ?? 0.6));
  const detail = o.detail ?? 1;
  const light = (o.lighting ?? 1) * (spec.lighting ?? 1);
  const side = face !== "up" && face !== "down";
  const f: Field = {
    w, h, face, side, detail,
    seed: (o.seed ?? 1) + ["north", "south", "east", "west", "up", "down"].indexOf(face) * 101,
    along: side ? (h >= w ? "y" : "x") : w >= h ? "x" : "y",
    cells: Array.from({ length: w * h }, () => ({ v: 0, pal: 0, hard: false, lit: 1 })),
  };
  spec.paint(f);

  // Light, grain and dithering, then quantise every cell onto its palette.
  const ditherAmount = (1 - smoothing) * (spec.dither ?? 1);
  const grain = (1 - smoothing) * 0.1 * detail;
  const idx: number[] = new Array(w * h);
  each(f, (x, y, c) => {
    let v = c.v + light * c.lit * lightAt(face, x, y, w, h, !!o.sheen);
    if (!c.hard) v += grain * centred(hash(x, y, f.seed + 31));
    const n = palettes[c.pal].length, mid = (n - 1) / 2;
    const t = c.hard ? 0.5 : 0.5 + (threshold(x, y, f.seed + 29) - 0.5) * ditherAmount;
    idx[y * w + x] = Math.max(0, Math.min(n - 1, Math.floor(mid + v * mid + t)));
  });

  // Clean-up: a lone pixel that none of its neighbours share joins the colour most of
  // them have — clusters stay, "ant war" speckle goes. Structure (hard cells) is kept.
  const passes = smoothing >= 0.75 ? 2 : smoothing >= 0.35 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = idx.slice();
    each(f, (x, y, c) => {
      if (c.hard) return;
      const own = c.pal * 100 + idx[y * w + x];
      const counts = new Map<number, number>();
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && inside(f, x + dx, y + dy)) {
          const nb = cellAt(f, x + dx, y + dy).pal * 100 + idx[(y + dy) * w + x + dx];
          if (nb === own) same++;
          counts.set(nb, (counts.get(nb) || 0) + 1);
        }
      }
      if (same > 1) return;
      let best = own, bestCount = 0;
      for (const [k, n] of counts) if (n > bestCount && Math.floor(k / 100) === c.pal) { best = k; bestCount = n; }
      if (bestCount >= 4) next[y * w + x] = best % 100;
    });
    for (let i = 0; i < idx.length; i++) idx[i] = next[i];
  }

  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(palettes[cellAt(f, x, y).pal][idx[y * w + x]]);
    rows.push(row);
  }
  return rows;
}

/** Stable per-cube seed from its name. */
export function seedFrom(text: string): number {
  let s = 2166136261;
  for (let i = 0; i < text.length; i++) s = Math.imul(s ^ text.charCodeAt(i), 16777619);
  return (s >>> 0) % 1000003;
}
