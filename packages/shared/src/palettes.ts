// Hue-shifted pixel-art palettes. Each palette is a 5-step ramp, index 0 = deepest
// shadow → index 4 = brightest highlight. Hue-shifting is BAKED IN: shadows lean
// cool (blue/violet/teal), highlights lean warm (yellow) — so the AI must only
// pick indices 0-4, never compute its own colors (which would give muddy results).

export type Palette = [string, string, string, string, string];

export const PALETTES: Record<string, Palette> = {
  // Warm browns; shadow → red-brown, highlight → tan/yellow.
  wood: ["#2c1a0d", "#492a16", "#6e4423", "#9a6433", "#c79356"],
  // Cool neutral metal; shadow shifts blue, highlight stays bright steel.
  iron: ["#272c36", "#434b58", "#6b7382", "#9aa3b0", "#dbe2ec"],
  // Gold; shadow → brown, highlight → pale warm yellow.
  gold: ["#43290a", "#7a5414", "#b5872a", "#e3b347", "#ffe49c"],
  // Neutral stone, slightly cool.
  stone: ["#29292f", "#454650", "#6a6c75", "#92949d", "#c6c8d0"],
  // Amethyst crystal; shadow → deep indigo, highlight → lavender/pink.
  crystal_purple: ["#27114a", "#481f86", "#7b3fc8", "#a872e6", "#ddc2ff"],
  // Sapphire crystal; shadow → navy, highlight → icy cyan.
  crystal_blue: ["#0d2350", "#1b4789", "#2f78cc", "#5fabe8", "#bde6ff"],
  // Emerald/teal crystal; shadow → deep teal, highlight → mint.
  crystal_green: ["#0c3034", "#135b54", "#1f9377", "#52c79a", "#b4f2d2"],
  // Ruby/red; shadow → maroon (cool-ish), highlight → warm coral.
  ruby: ["#360a14", "#6c1422", "#b0263a", "#e35a6e", "#ff9fa9"],
  // Ember/orange (lava, fire); shadow → dark red-brown, highlight → warm yellow.
  ember: ["#371302", "#792d08", "#c45518", "#f3893c", "#ffc66e"],
  // Foliage/slime green; shadow → teal, highlight → yellow-green.
  green: ["#143618", "#2a5a2a", "#4c8c3c", "#79b853", "#b0db70"],
  // Bone/parchment off-white; shadow → warm grey, highlight → cream.
  bone: ["#48442f", "#79745b", "#aaa182", "#d2cbab", "#f4eedb"],
  // Skin/leather (mobs); warm tan with cool shadow.
  leather: ["#371f14", "#5d3925", "#8a5a3c", "#b27e55", "#dcac80"],
  // Cloth/blue fabric (mobs); shadow → indigo, highlight → soft sky.
  cloth_blue: ["#15203f", "#2a3d6e", "#45619e", "#6f8cc6", "#aec3e8"],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

export function getPalette(name: string): Palette | undefined {
  return PALETTES[name];
}

/** Roles of each index, for guidance. 0 = deep shadow / ambient occlusion, 4 = highlight. */
export const PALETTE_INDEX_ROLES = [
  "0 = deepest shadow / ambient occlusion (use at concave seams & bottom-right edges)",
  "1 = shadow",
  "2 = base / mid tone",
  "3 = light",
  "4 = highlight (use at top-left edges where light hits)",
];
