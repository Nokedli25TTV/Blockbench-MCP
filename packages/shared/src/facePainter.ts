// Pixel-art face painter: turns ONE exact colour into a shaded, textured cube face.
// Pure (no Blockbench), so it is unit-testable and previewable in Node; the plugin's
// shade_cube(s) paints its output into each face's UV rect.
//
// Why it exists: the first shade_cube painted three flat bands per side (top/middle/
// bottom) and one flat colour on top and bottom — stripy and plastic, with every pixel
// in a band identical. Here every pixel gets its own value from
//   face light (top bright, bottom dark) + a smooth in-face gradient + edge light/shadow
//   + a material pattern (fur strands, stone blobs, wood grain, …)
// and is then quantised onto a hue-shifted ramp with dithering, so shades blend into
// each other instead of stepping, and neighbouring pixels differ like hand-made pixel art.

export type FaceKey = "north" | "south" | "east" | "west" | "up" | "down";

export const MATERIALS = ["generic", "fur", "skin", "leather", "cloth", "wood", "planks", "stone", "metal", "gem", "plant"] as const;
export type Material = (typeof MATERIALS)[number];

export interface FacePaintOptions {
  /** Colours dark → light; the middle one is the base colour (rampFromBase gives 7). */
  ramp: string[];
  material?: Material;
  /** Per-cube seed so repeated parts don't look stamped. */
  seed?: number;
  /** 0..2 — how strong the material pattern is (default 1). */
  detail?: number;
  /** 0..2 — how strong light and shadow are (default 1). */
  lighting?: number;
  /** Brighter centre stripe on north/south faces (blade sheen). */
  sheen?: boolean;
  /** How shades blend: ordered (clean pixel-art steps), noise (grainy) or mixed (default). */
  dither?: "ordered" | "noise" | "mixed";
}

// ---- colour helpers ---------------------------------------------------------
export const hexToRgb = (hex: string): [number, number, number] => {
  const h = String(hex || "#000000").replace("#", "").trim();
  const s = (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).slice(0, 6).padEnd(6, "0");
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
};
const hslToHex = (h: number, s: number, l: number): string => {
  h = (((h % 360) + 360) % 360) / 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const r = s === 0 ? l : ch(h + 1 / 3), g = s === 0 ? l : ch(h), b = s === 0 ? l : ch(h - 1 / 3);
  return "#" + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
};
const normHex = (hex: string): string => {
  const [r, g, b] = hexToRgb(hex);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
};
// Rotate a hue toward a target along the short way, by fraction t.
const towardHue = (h: number, target: number, t: number): number => {
  const d = ((target - h + 540) % 360) - 180;
  return h + d * t;
};

/**
 * Hue-shifted ramp from ONE colour, dark → light, the exact colour in the middle.
 * Shadows drift toward blue and get a little more saturated, highlights drift toward
 * warm yellow and desaturate — the classic pixel-art ramp, never plain black/white mixing.
 */
export function rampFromBase(hex: string, steps = 7): string[] {
  const base = normHex(hex);
  const [h, s, l] = rgbToHsl(...hexToRgb(base));
  const mid = (steps - 1) / 2;
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const k = (i - mid) / mid; // -1 darkest … 0 base … +1 lightest
    if (Math.abs(k) < 1e-9) { out.push(base); continue; }
    if (k < 0) {
      const a = -k;
      out.push(hslToHex(towardHue(h, 235, 0.08 * a), Math.min(1, s * (1 + 0.08 * a)), l * (1 - 0.55 * a)));
    } else {
      const a = k;
      out.push(hslToHex(towardHue(h, 55, 0.10 * a), s * (1 - 0.22 * a), l + (1 - l) * 0.5 * a));
    }
  }
  return out;
}

// ---- deterministic noise ----------------------------------------------------
const hash = (x: number, y: number, seed: number): number => {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 100000) / 100000; // [0,1)
};
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Smooth value noise in [0,1): clusters about `scale` pixels wide (sx, sy stretch it). */
const valueNoise = (x: number, y: number, sx: number, sy: number, seed: number): number => {
  const fx = x / sx, fy = y / sy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smooth(fx - x0), ty = smooth(fy - y0);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
};
const centred = (v: number) => (v - 0.5) * 2; // [0,1) → [-1,1)
// 4x4 Bayer matrix: ordered-dither thresholds in [0,1).
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);
const threshold = (mode: string, x: number, y: number, seed: number): number => {
  const ordered = BAYER[(y & 3) * 4 + (x & 3)];
  if (mode === "ordered") return ordered;
  if (mode === "noise") return hash(x, y, seed);
  return 0.5 + (ordered - 0.5) * 0.75 + (hash(x, y, seed) - 0.5) * 0.25;
};

// Material pattern in ramp steps (roughly -1..+1 before `detail`), per face pixel.
function materialPattern(m: Material, x: number, y: number, w: number, h: number, seed: number, face: FaceKey): number {
  const along = face === "up" || face === "down" ? (w >= h ? "x" : "y") : h >= w ? "y" : "x"; // long axis of the face
  const fine = centred(hash(x, y, seed + 7));
  switch (m) {
    case "fur": {
      // Short strands running down the face: stretched noise + a few dark and light hairs.
      const strands = centred(valueNoise(x, y, 1, 3.2, seed));
      const hair = hash(x, Math.floor(y / 2), seed + 3);
      return 0.75 * strands + 0.25 * fine + (hair > 0.9 ? 0.6 : hair < 0.08 ? -0.7 : 0);
    }
    case "skin":
      return 0.45 * centred(valueNoise(x, y, 3.5, 3.5, seed)) + 0.15 * fine;
    case "leather": {
      const blobs = centred(valueNoise(x, y, 1.6, 1.6, seed));
      return 0.6 * blobs + 0.2 * fine + (hash(x, y, seed + 11) > 0.94 ? -0.8 : 0);
    }
    case "cloth": {
      const weave = (x + y) % 2 === 0 ? 0.28 : -0.28;
      return weave + 0.35 * centred(valueNoise(x, y, 3, 3, seed)) + 0.1 * fine;
    }
    case "wood": {
      // Grain along the long axis: stretched streaks + dark grain lines + the odd knot.
      const [u, v] = along === "y" ? [x, y] : [y, x];
      const grain = centred(valueNoise(u, v, 1, 5, seed));
      const line = hash(u, 0, seed + 5) > 0.72 ? -0.55 : 0;
      return 0.7 * grain + line + 0.15 * fine;
    }
    case "planks": {
      // Boards 4 px wide across the long axis, each its own tone, with dark seams.
      const [u, v] = along === "y" ? [x, y] : [y, x];
      const board = Math.floor(v / 4);
      const seam = v % 4 === 3 ? -1.1 : 0;
      const tone = centred(hash(board, 0, seed + 9)) * 0.45;
      return tone + seam + 0.45 * centred(valueNoise(u, v, 4, 1, seed + board)) + 0.12 * fine;
    }
    case "stone": {
      const blobs = centred(valueNoise(x, y, 2, 2, seed));
      const big = centred(valueNoise(x, y, 5, 5, seed + 1));
      const crack = hash(x, y, seed + 13) > 0.95 ? -0.9 : 0;
      return 0.6 * blobs + 0.35 * big + crack + 0.15 * fine;
    }
    case "metal":
      return 0.15 * centred(valueNoise(x, y, 4, 4, seed)) + 0.06 * fine;
    case "gem": {
      // Facets: diagonal bands of light and shade.
      const facet = Math.sin((x - y) * 0.9 + seed) > 0.2 ? 0.45 : -0.25;
      return facet + 0.15 * fine;
    }
    case "plant": {
      const blobs = centred(valueNoise(x, y, 1.8, 1.8, seed));
      return 0.7 * blobs + (hash(x, y, seed + 17) > 0.9 ? 0.7 : 0) + 0.15 * fine;
    }
    default:
      return 0.5 * centred(valueNoise(x, y, 2.2, 2.2, seed)) + 0.2 * fine;
  }
}

// How bright each face is overall, in ramp steps (the game adds its own face shading
// on top, so this stays moderate).
const FACE_LIGHT: Record<FaceKey, number> = { up: 1.15, north: 0.25, south: -0.05, east: -0.3, west: -0.3, down: -1.35 };

/** Paint one face: returns rows[y][x] of hex colours for a w×h face. */
export function paintFace(face: FaceKey, w: number, h: number, o: FacePaintOptions): string[][] {
  const ramp = o.ramp.length ? o.ramp : ["#808080"];
  const n = ramp.length;
  const mid = (n - 1) / 2;
  const material: Material = o.material && (MATERIALS as readonly string[]).includes(o.material) ? o.material : "generic";
  const detail = o.detail ?? 1;
  const light = o.lighting ?? 1;
  const seed = (o.seed ?? 1) + ["north", "south", "east", "west", "up", "down"].indexOf(face) * 101;
  const scale = (n - 1) / 6; // patterns and light are tuned for a 7-colour ramp
  const side = face !== "up" && face !== "down";
  const metal = material === "metal" || material === "gem";
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0.5;
      const v = h > 1 ? y / (h - 1) : 0.5;
      let val = FACE_LIGHT[face] * light;
      if (side) {
        val += light * (0.95 - 1.9 * smooth(v));                      // light from above, smoothly
        if (h >= 3 && y === 0) val += 0.55 * light;                     // top edge catches the light
        if (h >= 3 && y === h - 1) val -= 0.65 * light;                 // contact shadow at the bottom
        if (w >= 4 && (x === 0 || x === w - 1)) val -= 0.3 * light;     // soft corners
        if (metal) val += light * 0.9 * Math.max(0, 1 - Math.abs(u - 0.3) * 5); // specular streak
        if (o.sheen && w >= 3 && (face === "north" || face === "south") && Math.abs(x - (w - 1) / 2) < 0.6) val += 0.9;
      } else if (face === "up") {
        val += light * (0.6 - 1.2 * ((u + v) / 2));                     // brightest at the lit corner
        if (w >= 4 && h >= 4 && (x === w - 1 || y === h - 1)) val -= 0.45 * light; // far edges in shade
        if (w >= 4 && h >= 4 && (x === 0 || y === 0)) val += 0.3 * light;           // near edges catch light
      } else {
        val -= 0.2 * light * (1 - Math.abs(u - 0.5) * 2);
      }
      val += detail * materialPattern(material, x, y, w, h, seed, face);
      // A little grain everywhere, so no row settles on one shade (that is how bands start).
      val += (0.3 + 0.15 * detail) * centred(hash(x, y, seed + 31));
      // Dither: the fractional part decides between two neighbouring shades per pixel,
      // so a gradient blends instead of stepping in bands.
      const idx = Math.floor(mid + val * scale + threshold(o.dither || "mixed", x, y, seed + 29));
      row.push(ramp[Math.max(0, Math.min(n - 1, idx))]);
    }
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
