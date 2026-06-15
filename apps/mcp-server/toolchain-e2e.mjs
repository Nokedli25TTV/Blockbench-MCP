// End-to-end test: proves the nested-group solution for multi-axis rotation and
// that validation passes, plus tool-level rejections and validator detection.
// Uses the shared harness (real MCP server + mock Blockbench). Needs port 9999 free.
//
//   root → crystal_x (rotate X) → crystal_y (rotate Y) → crystal_cube
import { startHarness } from "./test/harness.mjs";
import { randomUUID } from "node:crypto";

const nonZero = (v) => v.filter((n) => Math.abs(n) > 1e-6).length;
const h = await startHarness();

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

try {
  const tools = await h.listTools();
  const expected = ["create_cube", "create_group", "set_origin", "set_rotation", "get_scene_tree", "register_texture", "apply_texture", "validate_model"];
  check("all 8 tools registered", expected.every((t) => tools.includes(t)), tools.join(", "));

  console.log("\n--- Building root → crystal_x → crystal_y → crystal_cube ---");
  check("create_group crystal_x", !(await h.call("create_group", { name: "crystal_x", origin: [8, 8, 8] })).isError);
  check("set_origin crystal_x", !(await h.call("set_origin", { target: "crystal_x", origin: [8, 8, 8] })).isError);
  check("set_rotation crystal_x (X axis)", !(await h.call("set_rotation", { target: "crystal_x", rotation: [30, 0, 0] })).isError);
  check("create_group crystal_y under crystal_x", !(await h.call("create_group", { name: "crystal_y", parent: "crystal_x", origin: [8, 8, 8] })).isError);
  check("set_rotation crystal_y (Y axis)", !(await h.call("set_rotation", { target: "crystal_y", rotation: [0, 45, 0] })).isError);
  check("create_cube crystal_cube under crystal_y", !(await h.call("create_cube", { name: "crystal_cube", from: [6, 6, 6], to: [10, 10, 10], parent: "crystal_y" })).isError);

  console.log("\n--- Scene tree ---");
  const tree = JSON.parse((await h.call("get_scene_tree")).text);
  const x = tree.roots.find((n) => n.name === "crystal_x");
  const y = x?.children?.find((n) => n.name === "crystal_y");
  const cube = y?.children?.find((n) => n.name === "crystal_cube");
  check("crystal_x at root, rotated on X only", !!x && nonZero(x.rotation) === 1 && Math.abs(x.rotation[0]) > 0);
  check("crystal_y nested in crystal_x, rotated on Y only", !!y && nonZero(y.rotation) === 1 && Math.abs(y.rotation[1]) > 0);
  check("crystal_cube nested in crystal_y, unrotated", !!cube && cube.type === "cube" && nonZero(cube.rotation) === 0);

  console.log("\n--- Validation (expected PASS) ---");
  const v1 = await h.call("validate_model");
  console.log(v1.text);
  check("validate_model PASSES", !v1.isError && v1.text.includes("PASSED"));

  console.log("\n--- Negative: tool-level rejections ---");
  check("reject rotating a cube", (await h.call("set_rotation", { target: "crystal_cube", rotation: [10, 0, 0] })).isError);
  check("reject multi-axis group rotation", (await h.call("set_rotation", { target: "crystal_x", rotation: [10, 10, 0] })).isError);
  check("reject duplicate group name", (await h.call("create_group", { name: "crystal_x" })).isError);
  check("apply_texture fails for unregistered texture", (await h.call("apply_texture", { target: "crystal_cube", texture: "nope" })).isError);

  console.log("\n--- Negative: validator catches a corrupted scene ---");
  h.mock.findCube("crystal_cube").rotation = [45, 30, 0]; // illegal multi-axis cube rotation
  h.scene.roots.push({ type: "group", uuid: randomUUID(), name: "crystal_x", origin: [0, 0, 0], rotation: [0, 0, 0], children: [] }); // duplicate + empty
  const v2 = await h.call("validate_model");
  console.log(v2.text);
  check("validate_model FAILS on corrupted scene", v2.isError && v2.text.includes("FAILED"));
  check("detects illegal cube rotation", v2.text.includes("illegal-cube-rotation"));
  check("detects duplicate name", v2.text.includes("duplicate-name"));

  console.log(`\n${failures === 0 ? "🎉 ALL CHECKS PASSED" : "💥 " + failures + " CHECK(S) FAILED"}`);
  h.stop();
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error("TEST ERROR:", e);
  h.stop();
  process.exit(1);
}
