// Contact sheets (capture_screenshot views / times) and the get_scene_tree outline: the shared
// helpers straight from the TypeScript source, then both tools through the server and the mock.
import { VIEWS, viewDirection, fitDistance, sheetLayout, sheetCell } from "../../../packages/shared/src/views.ts";
import { outlineText } from "../../../packages/shared/src/outline.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

console.log("--- views ---");
check("every view is a unit direction", VIEWS.every((v) => Math.abs(Math.hypot(...viewDirection(v)) - 1) < 1e-9));
check("front looks at the model's north side (camera at −Z)", near(viewDirection("front"), [0, 0, -1]));
check("left looks at its own left (camera at −X)", near(viewDirection("left"), [-1, 0, 0]));
const top = viewDirection("top");
check("top looks down, nudged to the front so up stays defined", top[1] > 0.999 && top[2] < 0 && top[2] > -0.01, JSON.stringify(top));
const iso = viewDirection("iso");
check("iso sees the front, the left side (−X) and the top", iso[0] < 0 && iso[1] > 0 && iso[2] < 0);
const d = fitDistance(10, 45);
check("fitDistance fits the sphere inside the field of view", 10 / d < Math.sin((45 * Math.PI) / 360), `d=${d.toFixed(2)}`);
check("a bigger model stands the camera further away", fitDistance(20, 45) > d);
check("layout: 4 views → 2×2, 3 views → 3×1, 6 frames → 3×2", near(Object.values(sheetLayout(4, 0)), [2, 2]) && near(Object.values(sheetLayout(3, 0)), [3, 1]) && near(Object.values(sheetLayout(0, 6)), [3, 2]));
check("layout: views × times → frames as rows, views as columns", near(Object.values(sheetLayout(2, 3)), [2, 3]));
const cell = sheetCell(3, 2, 800);
check("the whole sheet stays within max_size", 3 * cell + 4 * 4 <= 800, `cell ${cell}px`);

console.log("\n--- outline ---");
const tree = {
  format: { id: "geckolib_model" }, mesh_count: 0,
  textures: [{ uuid: "t1", name: "skin" }],
  roots: [{
    type: "group", name: "body", origin: [0, 24, 0], rotation: [0, 0, 0], children: [
      { type: "cube", name: "torso", from: [-4, 12, -2], to: [4, 24, 2], origin: [0, 0, 0], rotation: [0, 0, 0], uv_offset: [16, 16] },
      { type: "group", name: "arm_left", origin: [5, 22, 0], rotation: [0, 0, -10], children: [], truncated_children: 2 },
      { type: "cube", name: "horn", from: [0, 30, 0], to: [1, 34.5, 1], origin: [0.5, 30, 0.5], rotation: [15, 0, 0] },
    ],
  }],
};
const text = outlineText(tree);
const lines = text.split("\n");
check("header: format and counts", lines[0] === "geckolib_model · 2 group(s), 2 cube(s)", lines[0]);
check("a group line ends in / with its pivot", lines[1] === "body/  pivot [0, 24, 0]", lines[1]);
check("a cube line: box, size and box-UV offset", lines[2] === "  torso  [-4, 12, -2]→[4, 24, 2]  8×12×4  uv [16, 16]", lines[2]);
check("a rotated group shows its rotation and hidden children", lines[3] === "  arm_left/  pivot [5, 22, 0]  rot [0, 0, -10]  (+2 not shown: max_depth)", lines[3]);
check("a rotated cube shows its rotation and pivot", lines[4] === "  horn  [0, 30, 0]→[1, 34.5, 1]  1×4.5×1  rot [15, 0, 0] about [0.5, 30, 0.5]", lines[4]);
check("textures listed last", lines[5] === "textures: skin", lines[5]);

console.log("\n--- through the server (mock Blockbench) ---");
const h = await startHarness();
try {
  const r = await h.rpc("tools/call", { name: "capture_screenshot", arguments: { views: ["front", "left", "top", "iso"] } });
  const content = r.result?.content || [];
  const note = content.find((c) => c.type === "text")?.text || "";
  check("views: one image plus the cell order", content.some((c) => c.type === "image") && /2×2/.test(note) && /front \| left \| top \| iso/.test(note), note);
  const strip = await h.rpc("tools/call", { name: "capture_screenshot", arguments: { times: [0, 0.5, 1] } });
  const stripNote = (strip.result?.content || []).find((c) => c.type === "text")?.text || "";
  check("times: an animation strip from the current camera", /t=0s \| t=0.5s \| t=1s/.test(stripNote), stripNote);
  const bad = await h.call("capture_screenshot", { views: ["sideways"] });
  check("an unknown view is refused by the schema", bad.isError, bad.text.slice(0, 100));
  const plain = await h.rpc("tools/call", { name: "capture_screenshot", arguments: {} });
  check("no views/times: the plain screenshot, image only", (plain.result?.content || []).length === 1 && plain.result.content[0].type === "image");

  await h.call("create_group", { name: "body", origin: [0, 24, 0] });
  await h.call("create_cube", { name: "torso", parent: "body", from: [-4, 12, -2], to: [4, 24, 2] });
  const outline = await h.call("get_scene_tree", { format: "outline" });
  check("get_scene_tree outline through the server", !outline.isError && /body\/  pivot \[0, 24, 0\]/.test(outline.text) && /torso  \[-4, 12, -2\]→\[4, 24, 2\]  8×12×4/.test(outline.text), outline.text.replace(/\n/g, " ⏎ "));
  const json = await h.call("get_scene_tree", {});
  check("the default is still JSON", (() => { try { return Array.isArray(JSON.parse(json.text).roots); } catch { return false; } })());
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 VIEW CHECKS PASSED" : "💥 " + failures + " VIEW CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
