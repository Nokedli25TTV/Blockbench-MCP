// Unit test for the shared face painter (packages/shared/src/facePainter.ts), run straight
// from the TypeScript source (Node strips the types). It guards the look the user asked
// for: shaded, structured pixel art with clustered texture — never flat bands (v1), never
// "ant war" noise (v2), never too smooth (v3) and never lone dots except deliberate structure.
import { paintFace, rampFromBase, hexToRgb, seedFrom, MATERIALS } from "../../../packages/shared/src/facePainter.ts";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const luma = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const avg = (cells) => cells.reduce((a, c) => a + luma(c), 0) / cells.length;
// Share of pixels that differ from all four neighbours — the "noise" the user objected to.
const speckle = (rows) => {
  let lone = 0, total = 0;
  rows.forEach((row, y) => row.forEach((c, x) => {
    const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([a, b]) => a >= 0 && b >= 0 && b < rows.length && a < row.length);
    total++;
    if (nb.every(([a, b]) => rows[b][a] !== c)) lone++;
  }));
  return lone / total;
};
// Share of neighbouring pixel pairs that differ — how much texture a surface shows.
const busy = (rows) => {
  let diff = 0, total = 0;
  rows.forEach((row, y) => row.forEach((c, x) => {
    if (x + 1 < row.length) { total++; if (row[x + 1] !== c) diff++; }
    if (y + 1 < rows.length) { total++; if (rows[y + 1][x] !== c) diff++; }
  }));
  return diff / total;
};
// Materials whose structure is made of single pixels on purpose (stitches, facet edges,
// cracks, scratches, glints); everything else must have (almost) no lone pixels.
const DOTTED = new Set(["leather", "crystal", "ice", "ancient_metal"]);
const COLORS = {
  generic: "#8b5a2b", fur: "#7a5230", skin: "#c98f6b", leather: "#8b5a2b", cloth: "#3f5fa8", wood: "#8a6238", planks: "#9c7447",
  stone: "#7d7d80", metal: "#9aa3ad", gem: "#3fb8c9", plant: "#4f8f3a", dungeon_stone: "#6f717c", crystal: "#8b4fe0",
  monster_fur: "#a4805c", ancient_metal: "#8f969e", wavy_wood: "#8a5a34", magma: "#ea5f1a", moss: "#3fae3a", water: "#2f6fd6", ice: "#bfe7f6",
};

const ramp = rampFromBase("#8b5a2b");
check("rampFromBase: 9 shades, the exact colour in the middle", ramp.length === 9 && ramp[4] === "#8b5a2b", ramp.join(" "));
check("the ramp runs dark → light", ramp.every((c, i) => i === 0 || luma(c) > luma(ramp[i - 1])), ramp.map((c) => Math.round(luma(c))).join(" < "));

check("every material has a test colour", MATERIALS.every((m) => COLORS[m]));
for (const material of MATERIALS) {
  const face = paintFace("north", 12, 12, { color: COLORS[material], material, seed: seedFrom("body") });
  const distinct = new Set(face.flat()).size;
  const noise = speckle(face);
  const lit = material === "crystal" || material === "magma" || avg(face.slice(1, 4).flat()) > avg(face.slice(8, 11).flat());
  const maxLone = DOTTED.has(material) ? 0.12 : 0.05;
  check(`${material}: varied, no dotting, lit from above`, face.length === 12 && face[0].length === 12 && distinct >= 4 && noise <= maxLone && lit,
    `${distinct} colours, ${Math.round(noise * 100)}% lone pixels (max ${Math.round(maxLone * 100)}%)`);
}

// The user's material notes (2026-09-24), each guarded by one measurable property.
const face16 = (material, seed = "body") => paintFace("north", 16, 16, { color: COLORS[material], material, seed: seedFrom(seed) });
const leatherDarkest = Math.min(...face16("leather").flat().map(luma));
check("leather: stitch holes are warm brown, never the darkest shade", leatherDarkest > luma(rampFromBase(COLORS.leather)[0]) + 10,
  `darkest pixel ${Math.round(leatherDarkest)} vs ramp ${Math.round(luma(rampFromBase(COLORS.leather)[0]))}`);
const crystal = face16("crystal").flat();
const crystalTop = Math.max(...crystal.map(luma));
check("crystal: facet edges drawn in the lightest colour (lines, not dots)", crystal.filter((c) => luma(c) === crystalTop).length >= 12,
  `${crystal.filter((c) => luma(c) === crystalTop).length} px of the lightest colour`);
const rustDepth = (rows) => {
  let deepest = -1;
  rows.forEach((row, y) => row.forEach((c, x) => {
    const [r, , b] = hexToRgb(c);
    if (r - b > 25) deepest = Math.max(deepest, Math.min(x, y, row.length - 1 - x, rows.length - 1 - y));
  }));
  return deepest;
};
const rustBig = rustDepth(face16("ancient_metal"));
const rustThin = rustDepth(paintFace("up", 16, 6, { color: COLORS.ancient_metal, material: "ancient_metal", seed: seedFrom("body") }));
check("ancient_metal: rust only at the rims (the outer ring on a thin face)", rustBig >= 0 && rustBig <= 2 && rustThin === 0,
  `16x16: ${rustBig} px in from the rim, 16x6: ${rustThin}`);
const ice = face16("ice");
check("ice: deepens toward the bottom (thickness)", avg(ice[1]) - avg(ice[14]) > 70, `${Math.round(avg(ice[1]))} → ${Math.round(avg(ice[14]))}`);

const strong = busy(paintFace("north", 12, 12, { color: "#8b5a2b", seed: 5, smoothing: 0 }));
const calm = busy(paintFace("north", 12, 12, { color: "#8b5a2b", seed: 5, smoothing: 1 }));
const byDefault = busy(paintFace("north", 12, 12, { color: "#8b5a2b", seed: 5 }));
check("more smoothing, calmer surface", calm < strong, `${Math.round(strong * 100)}% → ${Math.round(calm * 100)}% changing neighbours`);
check("the default keeps a visible texture (not flat)", byDefault >= 0.2, `${Math.round(byDefault * 100)}% changing neighbours`);
for (const s of [0, 0.5, 1]) {
  const lone = speckle(paintFace("north", 12, 12, { color: "#8b5a2b", seed: 9, smoothing: s }));
  check(`no dotting at smoothing ${s}`, lone <= 0.03, `${Math.round(lone * 100)}% lone pixels`);
}

const top = paintFace("up", 8, 6, { color: "#8b5a2b", seed: 3 }).flat();
const bottom = paintFace("down", 8, 6, { color: "#8b5a2b", seed: 3 }).flat();
check("the top face is lighter than the bottom face", avg(top) > avg(bottom) + 20, `${Math.round(avg(top))} vs ${Math.round(avg(bottom))}`);

const a = paintFace("east", 6, 10, { color: "#8b5a2b", seed: 7 }).flat().join();
const b = paintFace("east", 6, 10, { color: "#8b5a2b", seed: 7 }).flat().join();
const c = paintFace("east", 6, 10, { color: "#8b5a2b", seed: 8, material: "stone" }).flat().join();
check("the same seed paints the same face; another seed/material differs", a === b && a !== c);

const handPicked = ["#221100", "#553311", "#886644", "#bb9977", "#eeddcc"];
const fromGiven = paintFace("north", 8, 8, { ramp: handPicked, seed: 1 }).flat();
check("a hand-picked palette is used as is", fromGiven.every((col) => handPicked.includes(col)));

const smooth = paintFace("north", 8, 10, { color: "#8b5a2b", detail: 0, seed: 1 });
check("detail 0 still shades (gradient without pattern)", new Set(smooth.flat()).size >= 3 && avg(smooth[1]) > avg(smooth[8]));

const tiny = paintFace("north", 1, 1, { color: "#8b5a2b", seed: 1 });
check("a 1x1 face paints one pixel", tiny.length === 1 && tiny[0].length === 1 && /^#[0-9a-f]{6}$/.test(tiny[0][0]));

console.log(`\n${failures === 0 ? "🎉 PAINTER CHECKS PASSED" : "💥 " + failures + " PAINTER CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
