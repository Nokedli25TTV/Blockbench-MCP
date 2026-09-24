// Pixel-art face painter: turns ONE exact colour into a shaded, textured cube face.
// Pure (no Blockbench), so it is unit-testable and previewable in Node; the plugin's
// shade_cube(s) paints its output into each face's UV rect.
//
// History: the first shade_cube painted three flat bands per side — stripy and plastic.
// The second dithered everywhere, which read as noise ("ant war"); the third smoothed
// that away but lost the texture and still left dots. This one works like a pixel artist:
//   1. palettes in OKLab, so shades step evenly and never turn muddy grey;
//   2. each material paints STRUCTURE (stone blocks and cracks, crystal facets, fur
//      locks, scratches, growth rings, stitches, …) into a value field;
//   3. shared light from above is added (top bright, bottom dark, lit rim, contact shadow);
//   4. values are quantised without dithering — texture comes from 2–3 px clusters;
//   5. a clean-up pass folds any lone pixel into the colour around it (no dotting).
// `smoothing` (0..1) runs from strong clustered texture (0) to calm surfaces (1); each
// material has its own default. The only single pixels left are deliberate: stitches,
// scratches, cracks, facet edges and at most two glints per face.

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
  /** Hue the shadows lean toward (default 265, cool blue; e.g. 165 for a mossy tint). */
  shadowHue?: number;
  /** How far (degrees) the darkest shade turns toward `shadowHue` (default 16). */
  shadowShift?: number;
  /** Minimum chroma of the darkest shade, so greys get a tint instead of dead grey (default 0.02). */
  shadowTint?: number;
  /** Minimum chroma of the lightest shade, a warm tint (default 0.012). */
  lightTint?: number;
}

/**
 * Palette from ONE colour, dark → light, the exact colour in the middle. Built in OKLCH
 * so the steps look even: shadows turn toward a cool hue and get richer, highlights turn
 * toward warm yellow and paler. Greys get a faint tint both ways, so stone and metal
 * don't look sterile.
 */
export function rampFromBase(hex: string, steps = 9, style: RampStyle = {}): string[] {
  const base = normHex(hex);
  const [L0, C0, H0] = toOklch(hexToRgb(base));
  const contrast = style.contrast ?? 1, chroma = style.chroma ?? 1;
  const shadowHue = style.shadowHue ?? 265, shadowShift = style.shadowShift ?? 16;
  const shadowTint = style.shadowTint ?? 0.02, lightTint = style.lightTint ?? 0.012;
  const grey = C0 < 0.03;
  const mid = (steps - 1) / 2;
  const darkL = Math.max(0.08, L0 - L0 * 0.6 * contrast);
  const lightL = Math.min(0.985, L0 + (0.985 - L0) * 0.66 * contrast);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const k = (i - mid) / mid;
    if (Math.abs(k) < 1e-9) { out.push(base); continue; }
    const a = Math.abs(k);
    out.push(k < 0
      ? oklchHex(L0 + (darkL - L0) * a, Math.max(C0 * chroma * (1 + 0.12 * a), shadowTint * a), grey ? shadowHue : hueToward(H0, shadowHue, shadowShift * a))
      : oklchHex(L0 + (lightL - L0) * a, Math.max(C0 * chroma * (1 - 0.45 * a), lightTint * a), grey ? 85 : hueToward(H0, 95, 14 * a)));
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

// ---- the value field a material paints into ------------------------------------
// v: -1 (darkest shade) … 0 (base) … +1 (lightest), in "half palettes"; one shade of a
// 9-colour palette is 0.25. `hard` cells are structure (mortar, stitches, cracks, locks
// of a crystal) and are never changed by the clean-up pass.
interface Cell { v: number; pal: number; hard: boolean; lit: number }
interface Field {
  w: number; h: number; face: FaceKey; side: boolean; seed: number;
  /** Texture strength: `detail` × what `smoothing` allows. */
  detail: number;
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
// Clustered texture: blobs 2–3 px across, never single-pixel dots.
const T = (f: Field, x: number, y: number, k = 0) => 0.65 * N(f, x, y, 2.6, 2.6, k + 90) + 0.35 * N(f, x, y, 1.7, 1.7, k + 91);
// A short crack or scratch: a few connected pixels, never a lone dot.
const walk = (f: Field, x: number, y: number, len: number, k: number, fn: (x: number, y: number) => void) => {
  for (let i = 0; i < len; i++) {
    fn(x, y);
    if (H(f, x, y, k) < 0.5) y++; else x += H(f, x, y, k + 1) < 0.5 ? -1 : 1;
  }
};
// Up to `count` glints near the face centre — the only single pixels a material may keep.
const glints = (f: Field, count: number, k: number, fn: (x: number, y: number) => void) => {
  for (let i = 0; i < count; i++) {
    const x = Math.round((f.w - 1) * (0.25 + 0.5 * H(f, i, 0, k))), y = Math.round((f.h - 1) * (0.2 + 0.5 * H(f, i, 1, k)));
    fn(x, y);
  }
};

interface MaterialSpec {
  /** Palettes; [0] is the main one. `given` = a hand-picked palette, if the caller passed one. */
  palettes?: (base: string, given: string[] | null) => string[][];
  paint: (f: Field) => void;
  /** Default smoothing for this material. */
  smoothing?: number;
  /** Multiplier on the shared light (default 1). */
  lighting?: number;
}
const main = (style?: RampStyle) => (base: string, given: string[] | null) => [given || rampFromBase(base, 9, style)];

const SPECS: Record<Material, MaterialSpec> = {
  generic: { smoothing: 0.35, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * 0.3 * T(f, x, y); }) },

  fur: {
    smoothing: 0.35,
    paint: (f) => each(f, (x, y, c) => {
      const hair = H(f, x, Math.floor(y / 3), 3); // 3-px strands, not dots
      c.v = f.detail * (0.26 * N(f, x, y, 1.2, 3.4, 0) + 0.1 * T(f, x, y) + (hair > 0.9 ? 0.2 : hair < 0.08 ? -0.22 : 0));
    }),
  },

  skin: { smoothing: 0.5, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * (0.18 * N(f, x, y, 3.5, 3.5, 0) + 0.08 * T(f, x, y)); }) },

  cloth: {
    smoothing: 0.4,
    paint: (f) => each(f, (x, y, c) => {
      // Basket weave: 2-px thread segments alternating per row — reads as woven, no checkerboard dots.
      const over = (Math.floor(x / 2) + y) % 2 === 0;
      c.v = f.detail * ((over ? 0.09 : -0.09) + 0.15 * N(f, x, y, 3, 3, 0));
    }),
  },

  wood: {
    smoothing: 0.4,
    paint: (f) => each(f, (x, y, c) => {
      const [u, t] = f.along === "y" ? [x, y] : [y, x];
      c.v = f.detail * (0.26 * N(f, u, t, 1.2, 5, 0) + 0.08 * T(f, x, y) + (H(f, u, 0, 5) > 0.72 ? -0.18 : 0));
    }),
  },

  planks: {
    smoothing: 0.45,
    paint: (f) => each(f, (x, y, c) => {
      const [u, t] = f.along === "y" ? [x, y] : [y, x];
      const board = Math.floor(t / 4);
      if (t % 4 === 3) { c.v = -0.42; c.hard = true; return; }
      c.v = f.detail * (0.14 * centred(H(f, board, 0, 9)) + 0.14 * N(f, u, t, 4, 1, board) + 0.06 * T(f, x, y));
    }),
  },

  stone: {
    smoothing: 0.35,
    paint: (f) => {
      each(f, (x, y, c) => { c.v = f.detail * (0.28 * T(f, x, y) + 0.12 * N(f, x, y, 5, 5, 1)); });
      const cracks = (f.w * f.h) >= 48 ? 1 + Math.floor(H(f, 0, 0, 13) * 2) : 0;
      for (let i = 0; i < cracks; i++) {
        walk(f, Math.floor(H(f, i, 1, 14) * f.w), Math.floor(H(f, i, 2, 15) * f.h * 0.6), 3, 16 + i, (x, y) => put(f, x, y, -0.4, { hard: true }));
      }
    },
  },

  metal: {
    smoothing: 0.55,
    paint: (f) => each(f, (x, y, c) => {
      const u = f.w > 1 ? x / (f.w - 1) : 0.5;
      c.v = f.detail * 0.08 * T(f, x, y) + (f.side ? 0.26 * Math.max(0, 1 - Math.abs(u - 0.3) * 5) : 0);
    }),
  },

  gem: { smoothing: 0.5, paint: (f) => each(f, (x, y, c) => { c.v = f.detail * ((Math.sin((x - y) * 0.9 + f.seed) > 0.2 ? 0.14 : -0.08) + 0.06 * T(f, x, y)); }) },

  plant: {
    smoothing: 0.35,
    paint: (f) => each(f, (x, y, c) => {
      c.v = f.detail * (0.3 * T(f, x, y) + (valueNoise(x, y, 2, 2, f.seed + 17) > 0.78 ? 0.22 : 0));
    }),
  },

  // Worked leather: a padded surface (the middle one shade lighter), fine pores, scuffed
  // rims, and seams of warm dark stitch holes, each with a light thread pixel beside it.
  leather: {
    smoothing: 0.5, lighting: 0.55,
    paint: (f) => {
      const cx = (f.w - 1) / 2, cy = (f.h - 1) / 2;
      each(f, (x, y, c) => {
        const r = Math.min(1, Math.hypot((x - cx) / Math.max(1, f.w / 2), (y - cy) / Math.max(1, f.h / 2)));
        c.v = 0.3 * (1 - r * r) - 0.1 + f.detail * (0.08 * N(f, x, y, 4, 4, 0) + 0.2 * T(f, x, y));
        const edge = Math.min(x, y, f.w - 1 - x, f.h - 1 - y);
        const along = y === 0 || y === f.h - 1 ? x : y + 97;
        if (edge === 0 && valueNoise(along, 0, 2.5, 1, f.seed + 5) > 0.6) c.v += 0.2;
      });
      if (f.w >= 6 && f.h >= 5) {
        // The hole sits 1–2 shades below the base, the thread above it: the seam stands out in relief.
        const stitch = (x: number, y: number, tx: number, ty: number) => {
          put(f, x, y, -0.45, { hard: true });
          put(f, tx, ty, 0.38, { hard: true });
        };
        if (f.w >= f.h) {
          for (const sy of f.h >= 8 ? [2, f.h - 3] : [1, f.h - 2]) for (let x = 2; x + 1 <= f.w - 3; x += 3) stitch(x, sy, x + 1, sy);
        } else {
          for (const sx of f.w >= 8 ? [2, f.w - 3] : [1, f.w - 2]) for (let y = 2; y + 1 <= f.h - 3; y += 3) stitch(sx, y, sx, y + 1);
        }
      }
    },
  },

  // Dungeon stone: big blocks in a running bond. The mortar varies in depth, the block
  // edge next to it steps one shade lighter (bottom/right) or catches broken light
  // (top/left), and the faces carry low-contrast 2–3 px clusters. Shadows lean mossy.
  dungeon_stone: {
    smoothing: 0.45, lighting: 0.8,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.1, shadowHue: 195, shadowTint: 0.02, lightTint: 0.014 })],
    paint: (f) => {
      const nbx = Math.max(1, Math.round(f.w / 8)), nby = Math.max(1, Math.round(f.h / 6));
      const bw = f.w / nbx, bh = f.h / nby;
      each(f, (x, y, c) => {
        const by = Math.floor(y / bh);
        const off = by % 2 ? bw / 2 : 0;
        const bx = Math.floor((x + off) / bw);
        const lx = x + off - bx * bw, ly = y - by * bh;
        const tone = 0.1 * centred(H(f, bx, by, 21));
        if ((f.w >= 5 && lx < 1) || (f.h >= 5 && ly < 1)) { c.v = -0.62 + 0.1 * N(f, x, y, 2, 2, 26); c.hard = true; return; }
        const surface = tone + 0.12 * (0.5 - (lx / bw + ly / bh) / 2) + f.detail * 0.22 * N(f, x, y, 2.4, 2.4, 27);
        if (lx >= bw - 1 || ly >= bh - 1) { c.v = Math.min(surface, -0.37); return; }               // one step above the mortar
        if (lx < 2 || ly < 2) { c.v = surface + (valueNoise(x, y, 2, 1.5, f.seed + 28) > 0.35 ? 0.2 : 0.05); return; } // broken bevel light
        c.v = surface;
      });
      for (let by = 0; by < nby; by++) for (let bx = -1; bx <= nbx; bx++) {
        if (H(f, bx, by, 22) < 0.65) continue;
        const off = by % 2 ? bw / 2 : 0;
        const x0 = Math.round(bx * bw - off + 2 + H(f, bx, by, 23) * Math.max(1, bw - 4));
        walk(f, x0, Math.round(by * bh + 1), 2 + Math.floor(H(f, bx, by, 24) * (bh - 2)), 25, (x, y) => put(f, x, y, -0.55, { hard: true }));
      }
    },
  },

  // Mana crystal: three or four large flat facets with straight borders (a Voronoi split
  // of well-spaced points), shaded as planes from light (top-left) to dark. Each facet edge
  // is a ridge: a line in the lightest colour with a darker line right after it.
  crystal: {
    smoothing: 0.6, lighting: 0.3,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.35, chroma: 1.15 })],
    paint: (f) => {
      const k = f.w * f.h >= 40 ? 3 + (H(f, 0, 0, 30) < 0.5 ? 1 : 0) : 2;
      const pts: [number, number][] = [];
      for (let i = 0; i < 80 && pts.length < k; i++) {
        const px = H(f, i, 0, 31) * (f.w - 1), py = H(f, i, 1, 32) * (f.h - 1);
        if (pts.every(([qx, qy]) => Math.hypot(px - qx, py - qy) >= 0.45 * Math.min(f.w, f.h))) pts.push([px, py]);
      }
      const diag = ([px, py]: [number, number]) => px / Math.max(1, f.w - 1) + py / Math.max(1, f.h - 1);
      const order = pts.map((_, i) => i).sort((a, b) => diag(pts[a]) - diag(pts[b]));
      const LADDER = [0.35, 0.05, -0.2, -0.45];
      const shade: number[] = [];
      order.forEach((i, rank) => {
        shade[i] = LADDER[Math.round((rank * (LADDER.length - 1)) / Math.max(1, order.length - 1))] + 0.08 * centred(H(f, i, 2, 33));
      });
      const id: number[] = new Array(f.w * f.h).fill(0);
      each(f, (x, y) => {
        let best = 0, bd = Infinity;
        pts.forEach(([px, py], i) => { const d = (x - px) ** 2 + (y - py) ** 2; if (d < bd) { bd = d; best = i; } });
        id[y * f.w + x] = best;
      });
      const other = (x: number, y: number, own: number) => inside(f, x, y) && id[y * f.w + x] !== own;
      const edge = (x: number, y: number) => other(x + 1, y, id[y * f.w + x]) || other(x, y + 1, id[y * f.w + x]);
      each(f, (x, y, c) => {
        const own = id[y * f.w + x];
        c.hard = true;
        if (edge(x, y)) { c.v = 1; c.lit = 0; return; }
        const behind = (inside(f, x - 1, y) && id[y * f.w + x - 1] !== own && edge(x - 1, y)) || (inside(f, x, y - 1) && id[(y - 1) * f.w + x] !== own && edge(x, y - 1));
        c.v = shade[own] - (behind ? 0.25 : 0);
      });
    },
  },

  // Monster fur: strands of locks hanging down side by side, each strand shifted a little
  // so no rows form. A lock is dark at its root, lightens downward and ends in a light
  // V-shaped tip over the root of the next lock, whose root stays in shadow beside the tip.
  monster_fur: {
    smoothing: 0.4,
    paint: (f) => {
      const lw = f.w >= 8 ? 4 : 3, step = f.h >= 8 ? 4 : 3;
      const tone = (col: number, r: number) => 0.08 * centred(H(f, col, r, 44));
      each(f, (x, y, c) => {
        const col = Math.floor(x / lw), lx = x - col * lw;
        const yy = y + Math.floor(H(f, col, 0, 40) * step); // each strand has its own phase
        const r = Math.floor(yy / step), ly = yy - r * step;
        const lean = 1 + (lw >= 4 && H(f, col, r - 1, 43) < 0.5 ? 1 : 0);
        const long = H(f, col, r - 1, 42) < 0.35;
        if ((ly === 0 && lx >= 1 && lx <= lw - 2) || ((ly === 1 || (ly === 2 && long)) && lx === lean)) {
          c.v = tone(col, r - 1) + f.detail * (0.45 + 0.08 * ly); // the tip of the lock above
          return;
        }
        let v = -0.45 + (0.75 * ly) / Math.max(1, step - 1) + (lx === 0 ? 0.08 : lx === lw - 1 ? -0.15 : 0);
        if (ly <= (long ? 2 : 1) && Math.abs(lx - lean) === 1) v = Math.min(v, -0.4); // root beside the tip
        if (ly === (long ? 3 : 2) && lx === lean) v = Math.min(v, -0.35);            // under the tip
        c.v = tone(col, r) + f.detail * v;
      });
    },
  },

  // Ancient metal: high-contrast steel — a sharp diagonal highlight with a dark reflection
  // band beside it, a lit top edge, a few scratches — and rust only at the rims, in small
  // dense clusters that end sharply at the clean metal.
  ancient_metal: {
    smoothing: 0.45, lighting: 1.05,
    palettes: (base, given) => {
      const [L0] = toOklch(hexToRgb(base));
      return [given || rampFromBase(base, 9, { contrast: 1.3 }), rampFromBase(shadeOf(base, Math.min(0.55, L0 * 0.8), 0.11, 48), 7)];
    },
    paint: (f) => {
      const slope = (f.w - 1) / Math.max(1, f.h - 1), k0 = Math.round(0.55 * (f.w - 1));
      each(f, (x, y, c) => {
        const [u, t] = f.along === "y" ? [x, y] : [y, x];
        c.v = f.detail * (0.08 * N(f, u, t, 1, 6, 0) + 0.1 * T(f, x, y));
        const k = Math.round(x + y * slope) - k0; // diagonals across the highlight
        if (k === 0 || k === 1) c.v = 0.85;
        else if (k === -1) c.v += 0.35;
        else if (k >= 2 && k <= 4) c.v -= 0.32;
        if (f.side && y === 0) { c.v += 0.45; c.hard = true; }
      });
      const count = Math.floor(H(f, 0, 0, 51) * Math.min(3, 1 + (f.w * f.h) / 80));
      for (let i = 0; i < count; i++) {
        const x0 = Math.floor(H(f, i, 1, 52) * f.w), y0 = Math.floor(H(f, i, 2, 53) * f.h);
        const len = 3 + Math.floor(H(f, i, 3, 54) * Math.min(5, f.w));
        const slope2 = (H(f, i, 4, 55) - 0.5) * 1.2;
        line(x0, y0, x0 + len, Math.round(y0 + len * slope2), (x, y) => {
          put(f, x, y, 0.55, { hard: true });
          if (inside(f, x, y + 1) && cellAt(f, x, y + 1).v < 0.5) put(f, x, y + 1, -0.3, { hard: true });
        });
      }
      // Rust: denser the closer to the rim (a narrower rim on small faces), clusters of
      // 2–3 px, never a lone rust pixel.
      const small = Math.min(f.w, f.h);
      const needs = [0.38, 0.55, 0.72].slice(0, small >= 12 ? 3 : small >= 7 ? 2 : 1);
      const rust: boolean[] = new Array(f.w * f.h).fill(false);
      each(f, (x, y) => {
        const need = needs[Math.min(x, y, f.w - 1 - x, f.h - 1 - y)];
        if (need !== undefined && valueNoise(x, y, 1.7, 1.7, f.seed + 60) > need) rust[y * f.w + x] = true;
      });
      const kept = rust.map((on, i) => {
        const x = i % f.w, y = Math.floor(i / f.w);
        return on && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inside(f, x + dx, y + dy) && rust[(y + dy) * f.w + x + dx]);
      });
      each(f, (x, y, c) => {
        if (!kept[y * f.w + x]) return;
        c.pal = 1; c.hard = false;
        c.v = 0.3 * N(f, x, y, 1.5, 1.5, 61) - 0.05 - (Math.min(x, y, f.w - 1 - x, f.h - 1 - y) === 0 ? 0.1 : 0);
      });
    },
  },

  // Stylised wavy wood: bark ridges flowing along the trunk on the sides, wobbly
  // growth rings on the end faces; colours melt softly along the flow.
  wavy_wood: {
    smoothing: 0.45,
    paint: (f) => {
      if (!f.side) {
        const cx = (f.w - 1) / 2, cy = (f.h - 1) / 2;
        each(f, (x, y, c) => {
          const ang = Math.atan2(y - cy, x - cx);
          const r = Math.hypot(x - cx, y - cy) + 0.7 * Math.sin(ang * 3 + f.seed);
          c.v = 0.1 + f.detail * (0.24 * Math.cos((2 * Math.PI * r) / 2.4) + 0.06 * T(f, x, y));
          if (Math.min(x, y, f.w - 1 - x, f.h - 1 - y) === 0) { c.v = -0.55; c.hard = true; }
        });
        return;
      }
      each(f, (x, y, c) => {
        const [across, t] = f.along === "y" ? [x, y] : [y, x];
        const flow = across + 1.3 * Math.sin(t * 0.45 + f.seed * 0.01 + across * 0.2);
        c.v = f.detail * (0.24 * Math.cos((2 * Math.PI * flow) / 3.4) + 0.08 * T(f, x, y));
        if ((((flow / 4) % 1) + 1) % 1 < 0.16) c.v -= 0.34;
      });
    },
  },

  // Magma: dark crust plates with glowing hairline cracks, ringed by a thin dark-red glow
  // that warms to orange away from the crust; only the middle of the widest open melt
  // turns bright yellow. Soft flow bands run along the face.
  magma: {
    smoothing: 0.4, lighting: 0.8,
    palettes: (base) => [heatRamp(base), rampFromBase(shadeOf(base, 0.24, 0.035), 5, { contrast: 0.55, shadowHue: 30, shadowTint: 0.015 })],
    paint: (f) => {
      const crust: boolean[] = [];
      each(f, (x, y) => { crust[y * f.w + x] = valueNoise(x, y, 3.2, 3.2, f.seed + 50) > 0.66; });
      const isCrust = (x: number, y: number) => inside(f, x, y) && crust[y * f.w + x];
      // Distance (in steps) from each molten cell to the nearest crust.
      const dist = new Array(f.w * f.h).fill(Infinity);
      const queue: number[] = [];
      each(f, (x, y) => { if (isCrust(x, y)) { dist[y * f.w + x] = 0; queue.push(y * f.w + x); } });
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q], x = i % f.w, y = Math.floor(i / f.w);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, j = ny * f.w + nx;
          if (inside(f, nx, ny) && dist[j] > dist[i] + 1) { dist[j] = dist[i] + 1; queue.push(j); }
        }
      }
      each(f, (x, y, c) => {
        if (isCrust(x, y)) {
          c.pal = 1; c.hard = true; c.lit = 0.5;
          c.v = -0.15 + f.detail * 0.14 * T(f, x, y) + (!isCrust(x, y - 1) ? 0.12 : 0);
          return;
        }
        const [across, t] = f.along === "y" ? [x, y] : [y, x];
        const d = dist[y * f.w + x];
        const glow = d === Infinity ? 0.55 : Math.min(0.78, -0.58 + 0.34 * (d - 1)); // dark red rim → red → orange → yellow core
        const flow = 0.16 * Math.sin(t * 0.55 + across * 1.6 + 2 * N(f, x, y, 4, 2, 52));
        c.v = glow + f.detail * (flow + 0.1 * N(f, x, y, 4, 2.4, 53));
        c.lit = 0.15;
      });
      // Hairline cracks glowing through the crust.
      each(f, (x, y) => {
        if (!isCrust(x, y) || H(f, x, y, 54) < 0.86) return;
        walk(f, x, y, 3 + Math.floor(H(f, x, y, 55) * 3), 56, (cx, cy) => {
          if (isCrust(cx, cy)) put(f, cx, cy, -0.2, { pal: 0, hard: true, lit: 0.15 });
        });
      });
    },
  },

  // Magic moss: big saturated patches, painterly, bright tufts.
  moss: {
    smoothing: 0.4,
    palettes: (base, given) => [given || rampFromBase(base, 9, { chroma: 1.3 })],
    paint: (f) => {
      each(f, (x, y, c) => {
        c.v = f.detail * (0.28 * N(f, x, y, 3.2, 3.2, 0) + 0.2 * T(f, x, y));
        if (!f.side && valueNoise(x, y, 2, 2, f.seed + 73) > 0.8) c.v += 0.35;
      });
      if (f.side) {
        for (let x = 0; x < f.w; x++) {
          if (H(f, x, 0, 71) < 0.45) continue;
          const len = 2 + Math.floor(H(f, x, 1, 72) * 2);
          for (let i = 0; i < len; i++) put(f, x, i, 0.4 - i * 0.12, { hard: true });
        }
      }
    },
  },

  // Deep clear water: light surface with wavy highlight lines, easing smoothly into deep
  // dark blue with depth; it lights itself, so shared light stays weak.
  water: {
    smoothing: 0.6, lighting: 0.3,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.2 })],
    paint: (f) => {
      each(f, (x, y, c) => {
        const t = f.h > 1 ? y / (f.h - 1) : 0.5;
        if (f.face === "up") c.v = 0.42 + 0.06 * N(f, x, y, 4, 4, 0);
        else if (f.face === "down") c.v = -0.8;
        else c.v = 0.55 - 1.3 * smooth(Math.max(0, Math.min(1, t + 0.06 * Math.sin(x * 0.55 + y * 0.35 + f.seed)))) + 0.08 * N(f, x, y, 3, 2, 0);
        const wave = f.face === "up" ? (y + Math.round(Math.sin(x * 0.7 + f.seed) * 1.2)) % 3 === 0
          : f.face !== "down" && t < 0.5 && Math.sin(x * 0.75 + y * 1.9 + f.seed) > 0.9;
        if (wave) c.v += f.face === "up" ? 0.3 : 0.35 * (1 - t * 2);
      });
    },
  },

  // Glacier ice: a frosted pale top deepening to deep blue toward the bottom (thickness),
  // geometric inner fractures — straight runs at 0°, 45° and 90° that turn and branch —
  // each dark pixel with an almost white lit edge beside it, and one or two glints.
  ice: {
    smoothing: 0.55, lighting: 0.5,
    palettes: (base, given) => [given || rampFromBase(base, 9, { contrast: 1.1, chroma: 1.5, shadowShift: 40 })],
    paint: (f) => {
      each(f, (x, y, c) => {
        const t = f.h > 1 ? y / (f.h - 1) : 0.5;
        const depth = f.side ? 0.9 * smooth(t) : f.face === "down" ? 0.6 : 0.1 * t;
        c.v = 0.32 - depth + f.detail * (0.18 * T(f, x, y) + 0.1 * N(f, x, y, 5, 3, 0));
      });
      const base = f.cells.map((c) => c.v);
      const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1]]; // 0°, 45°, 90°, 135°
      const crack: [number, number, number][] = [];
      const run = (x: number, y: number, d: number, len: number, k: number, branch: boolean) => {
        let seg = 0, segLen = 3 + Math.floor(H(f, x, y, k) * 4);
        for (let s = 0; s < len && inside(f, x, y); s++) {
          crack.push([x, y, d]);
          if (branch && s === Math.floor(len / 2)) run(x, y, (d + 2) % 4, 3 + Math.floor(H(f, x, y, k + 3) * 3), k + 7, false); // 90° branch
          if (++seg >= segLen) { // turn by 45°
            seg = 0; segLen = 3 + Math.floor(H(f, x, y, k + 1) * 4);
            d = (d + (H(f, x, y, k + 2) < 0.5 ? 1 : 3)) % 4;
          }
          x += DIRS[d][0]; y += DIRS[d][1];
        }
      };
      const cracks = f.w * f.h >= 144 ? 2 : 1;
      for (let i = 0; i < cracks; i++) {
        run(Math.floor(f.w * (0.2 + 0.6 * H(f, i, 1, 82))), Math.floor(f.h * 0.4 * H(f, i, 2, 83)), Math.floor(H(f, i, 3, 84) * 4),
          Math.round(Math.max(f.w, f.h) * (0.6 + 0.4 * H(f, i, 4, 85))), 86 + i * 11, f.w * f.h >= 64);
      }
      // The lit edge first (below a flat or diagonal run, right of a vertical one), then the dark line on top.
      for (const [x, y, d] of crack) put(f, d === 2 ? x + 1 : x, d === 2 ? y : y + 1, 0.95, { hard: true, lit: 0 });
      for (const [x, y] of crack) put(f, x, y, Math.min(base[y * f.w + x] - 0.45, -0.1), { hard: true });
      glints(f, f.w * f.h >= 36 ? 2 : 1, 89, (x, y) => put(f, x, y, 1, { hard: true, lit: 0 }));
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
  const smoothing = Math.max(0, Math.min(1, o.smoothing ?? spec.smoothing ?? 0.4));
  const light = (o.lighting ?? 1) * (spec.lighting ?? 1);
  const side = face !== "up" && face !== "down";
  const f: Field = {
    w, h, face, side,
    // smoothing 0 → strong texture, 1 → calm; the texture is clustered either way.
    detail: (o.detail ?? 1) * (1.3 - 0.8 * smoothing),
    seed: (o.seed ?? 1) + ["north", "south", "east", "west", "up", "down"].indexOf(face) * 101,
    along: side ? (h >= w ? "y" : "x") : w >= h ? "x" : "y",
    cells: Array.from({ length: w * h }, () => ({ v: 0, pal: 0, hard: false, lit: 1 })),
  };
  spec.paint(f);

  // Light, then quantise every cell onto its palette (no dithering: the clustered
  // texture already breaks up the steps between shades).
  const idx: number[] = new Array(w * h);
  each(f, (x, y, c) => {
    const v = c.v + light * c.lit * lightAt(face, x, y, w, h, !!o.sheen);
    const n = palettes[c.pal].length, mid = (n - 1) / 2;
    idx[y * w + x] = Math.max(0, Math.min(n - 1, Math.floor(mid + v * mid + 0.5)));
  });

  // No dotting: a pixel with no same-coloured side neighbour joins the colour most of
  // its neighbours have. Structure (hard cells) is kept as painted.
  const key = (i: number) => f.cells[i].pal * 100 + idx[i];
  for (let pass = 0; pass < 2; pass++) {
    const next = idx.slice();
    each(f, (x, y, c) => {
      if (c.hard) return;
      const i = y * w + x, own = key(i);
      const side4 = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => inside(f, x + dx, y + dy));
      if (side4.some(([dx, dy]) => key((y + dy) * w + x + dx) === own)) return;
      const counts = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && inside(f, x + dx, y + dy)) {
          const nb = key((y + dy) * w + x + dx);
          if (Math.floor(nb / 100) === c.pal) counts.set(nb, (counts.get(nb) || 0) + 1);
        }
      }
      let best = -1, bestCount = 0;
      for (const [k, n] of counts) {
        if (n > bestCount || (n === bestCount && Math.abs((k % 100) - idx[i]) < Math.abs((best % 100) - idx[i]))) { best = k; bestCount = n; }
      }
      if (best >= 0) next[i] = best % 100;
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
