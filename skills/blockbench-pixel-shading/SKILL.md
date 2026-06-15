---
name: blockbench-pixel-shading
description: "How to texture Blockbench models with proper pixel-art shading instead of flat fills. MANDATORY before painting/texturing anything: use paint_pixel_matrix with a hue-shifted palette (indices 0-4 only), bake in directional light + ambient occlusion + per-pixel noise, and follow different recipes for organic MOBS vs rigid WEAPONS/ITEMS. Trigger on: creating or improving textures, 'make it look good', shading, coloring a model, paint_pixel_matrix, list_palettes."
---

# Blockbench Pixel-Art Shading

Flat single-color fills look bad. Real Minecraft pixel art has hue-shifted ramps, baked
directional light, ambient occlusion, and texture noise. This is a HARD workflow, enforced
by the tools.

## Core rule: palette indices only (no self-computed colors)
- Color comes ONLY from a palette via `paint_pixel_matrix`. Each palette is a 5-step ramp:
  **index 0 = deepest shadow / ambient occlusion → 4 = brightest highlight.**
- Hue-shifting is BAKED INTO the palette (shadows lean cool blue/violet/teal, highlights lean
  warm yellow). NEVER mix your own black/white into a color — that gives muddy/rusty results.
  Just pick the index; the palette already did the hue-shift.
- `list_palettes` / `get_palette` to see them (wood, iron, gold, stone, crystal_purple,
  crystal_blue, crystal_green, ruby, ember, green, bone, leather, cloth_blue).

## How to paint
1. Know each cube's box-UV: `get_scene_tree` / export shows the cube `uv` offset and its size.
   A cube's net occupies width `2*(depth+width)` × height `(depth+height)` px from that offset.
2. Build a `pixels` matrix (array of equal-length strings; chars are indices `0`-`4`, `.`=transparent)
   and call `paint_pixel_matrix` with `origin` = the cube's uv offset.
3. Encode ALL shading inside the matrix (see rules below). One cell = one solid palette pixel →
   no anti-aliasing.

## Shading rules (bake these into the matrix)
- **Directional light = TOP-LEFT.** Pixels on top and left edges of a form get the highlight
  (index 4 / 3). Bottom and right edges get shadow (index 1 / 0).
- **Ambient occlusion (index 0).** Concave seams and the UV edges where a cube meets another
  cube (e.g. limb→torso, head bottom) must use index 0 (deep shadow).
- **Per-pixel noise / dithering (organic only).** Vary between two adjacent indices (e.g. 2↔3)
  to fake material texture. NEVER leave a solid contiguous block larger than 3×3 of the same
  index on organic surfaces. Dithering (checkerboard of two indices) simulates a blend.
- **No anti-aliasing.** Outlines/edges must jump straight between form and background — do NOT
  put index 1 or 2 as a soft transition into transparency.
- **Contrast.** Use the full 0-4 range on every part; don't paint everything at index 2-3.

## Recipe A — organic MOBS / entities (skin, cloth, fur, scales)
Palettes: leather, cloth_blue, green, bone. Heavy per-pixel noise. Strong AO (index 0) at the
TOP of leg UVs, INNER sides of arm UVs, and BOTTOM of head UVs where they meet the torso. Keep
the FACE (front UV) relatively clean/low-noise so eyes & mouth stay readable. Remember limbs are
often mirrored (one texture region drives left & right) — keep them symmetric.

## Recipe B — rigid WEAPONS / TOOLS / ITEMS (metal, crystal, wood)
Palettes: iron, gold, ruby, ember, crystal_*, wood. NO random noise — use linear, structured
shading. A weapon item is a diagonal sprite (hilt bottom-left → tip top-right). Put high-contrast
specular highlights (index 4) directly next to dark shadow (index 1) along the cutting edge to
read as sharp/metallic. Wrap the whole shape in a solid dark outline (index 0). Crystals: a few
bright facets (4) with hard shadow (0-1) between them, not a smooth gradient.

## Pre-flight (rule #8 of MODELING_CONSTRAINTS)
Texture exists & registered → cube's uv offset known → pick palette by material → build matrix
with light/AO/noise per the recipe → paint_pixel_matrix → screenshot to verify.
