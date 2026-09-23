// Unit test for the shared face painter (packages/shared/src/facePainter.ts), run straight
// from the TypeScript source (Node strips the types). It guards the look the user asked
// for: shading and gradients with varied neighbouring pixels — never the old flat bands.
import { paintFace, rampFromBase, hexToRgb, seedFrom, MATERIALS } from "../../../packages/shared/src/facePainter.ts";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const luma = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const avg = (row) => row.reduce((a, c) => a + luma(c), 0) / row.length;

const ramp = rampFromBase("#8b5a2b");
check("rampFromBase gives 7 shades with the exact colour in the middle", ramp.length === 7 && ramp[3] === "#8b5a2b", ramp.join(" "));
check("the ramp runs dark → light", ramp.every((c, i) => i === 0 || luma(c) > luma(ramp[i - 1])), ramp.map((c) => Math.round(luma(c))).join(" < "));

for (const material of MATERIALS) {
  const face = paintFace("north", 8, 10, { ramp, material, seed: seedFrom("body") });
  const distinct = new Set(face.flat()).size;
  const flatRows = face.filter((row) => new Set(row).size === 1).length;
  const topLighter = avg(face[1]) > avg(face[8]);
  check(`${material}: shaded, varied, lit from above`, face.length === 10 && face[0].length === 8 && distinct >= 4 && flatRows <= 1 && topLighter,
    `${distinct} colours, ${flatRows} flat row(s), top ${Math.round(avg(face[1]))} vs bottom ${Math.round(avg(face[8]))}`);
}

const top = paintFace("up", 8, 6, { ramp, seed: 3 });
const bottom = paintFace("down", 8, 6, { ramp, seed: 3 });
check("the top face is lighter than the bottom face", avg(top.flat()) > avg(bottom.flat()) + 20, `${Math.round(avg(top.flat()))} vs ${Math.round(avg(bottom.flat()))}`);

const a = paintFace("east", 6, 10, { ramp, seed: 7 }).flat().join();
const b = paintFace("east", 6, 10, { ramp, seed: 7 }).flat().join();
const c = paintFace("east", 6, 10, { ramp, seed: 8 }).flat().join();
check("the same seed paints the same face; another seed differs", a === b && a !== c);

const smooth = paintFace("north", 8, 10, { ramp, detail: 0, seed: 1 });
check("detail 0 still shades (gradient without pattern)", new Set(smooth.flat()).size >= 3 && avg(smooth[1]) > avg(smooth[8]));

const tiny = paintFace("north", 1, 1, { ramp, seed: 1 });
check("a 1x1 face paints one pixel", tiny.length === 1 && tiny[0].length === 1 && ramp.includes(tiny[0][0]));

console.log(`\n${failures === 0 ? "🎉 PAINTER CHECKS PASSED" : "💥 " + failures + " PAINTER CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
