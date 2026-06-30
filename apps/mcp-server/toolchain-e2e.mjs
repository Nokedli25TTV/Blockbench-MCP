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
  const expected = ["create_cube", "create_cubes", "create_group", "set_origin", "set_rotation", "get_scene_tree", "register_texture", "apply_texture", "validate_model"];
  check("core tools registered (incl. create_cubes)", expected.every((t) => tools.includes(t)), tools.join(", "));

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

  console.log("\n--- P1.1 batch: groups + cubes in ONE call ---");
  const batch = await h.call("create_cubes", {
    groups: [
      { name: "handle_root", origin: [8, 0, 8] },
      { name: "handle_bone", parent: "handle_root", origin: [8, 8, 8] },
    ],
    cubes: [
      { name: "grip", parent: "handle_bone", from: [7, 0, 7], to: [9, 12, 9], uv_offset: [0, 0] },
      { name: "pommel", parent: "handle_bone", from: [6, -2, 6], to: [10, 0, 10], uv_offset: [8, 0] },
    ],
  });
  check("create_cubes returns ok", !batch.isError, batch.text);
  check("create_cubes reports 2 groups + 2 cubes", batch.text.includes("2 group(s) + 2 cube(s)"));

  const t2 = JSON.parse((await h.call("get_scene_tree")).text);
  const hr = t2.roots.find((n) => n.name === "handle_root");
  const hb = hr?.children?.find((n) => n.name === "handle_bone");
  const grip = hb?.children?.find((n) => n.name === "grip");
  const pommel = hb?.children?.find((n) => n.name === "pommel");
  check("batch: handle_root at root", !!hr && hr.type === "group");
  check("batch: handle_bone nested under handle_root", !!hb && hb.type === "group");
  check("batch: grip cube nested under handle_bone", !!grip && grip.type === "cube");
  check("batch: pommel cube nested under handle_bone", !!pommel && pommel.type === "cube");
  check("batch: uv_offset flows through (grip[0]=0, pommel[0]=8)", !!grip && !!pommel && grip.uv_offset?.[0] === 0 && pommel.uv_offset?.[0] === 8);

  console.log("\n--- P1.1 batch is all-or-nothing ---");
  const rootsBefore = JSON.parse((await h.call("get_scene_tree")).text).roots.length;
  const bad = await h.call("create_cubes", {
    groups: [{ name: "should_not_exist", origin: [0, 0, 0] }],
    cubes: [{ name: "crystal_cube", from: [0, 0, 0], to: [1, 1, 1] }], // duplicate of an existing name
  });
  check("create_cubes rejects a batch with any invalid entry", bad.isError, bad.text);
  const rootsAfter = JSON.parse((await h.call("get_scene_tree")).text).roots.length;
  check("create_cubes created NOTHING on failure (all-or-nothing)", rootsAfter === rootsBefore);
  check("the valid-looking group in the bad batch was not created", !h.mock.findGroup("should_not_exist"));

  console.log("\n--- P1.3 get_scene_tree filters (bone_names / max_depth / include_faces) ---");
  const scoped = JSON.parse((await h.call("get_scene_tree", { bone_names: ["handle_root"], max_depth: 1 })).text);
  check("bone_names scopes to one subtree root", scoped.roots.length === 1 && scoped.roots[0].name === "handle_root");
  const hb1 = scoped.roots[0].children?.find((n) => n.name === "handle_bone");
  check("max_depth=1 keeps direct child", !!hb1);
  check("max_depth=1 truncates grandchildren + reports count", !!hb1 && Array.isArray(hb1.children) && hb1.children.length === 0 && hb1.truncated_children === 2);
  const noFaces = JSON.parse((await h.call("get_scene_tree", { bone_names: ["handle_bone"], include_faces: false })).text);
  const gripNF = noFaces.roots[0]?.children?.find((n) => n.name === "grip");
  check("include_faces:false: cube present, no faces key", !!gripNF && gripNF.faces === undefined);
  const withFaces = JSON.parse((await h.call("get_scene_tree", { bone_names: ["handle_bone"], include_faces: true })).text);
  const gripWF = withFaces.roots[0]?.children?.find((n) => n.name === "grip");
  check("include_faces:true: cube has faces key", !!gripWF && gripWF.faces !== undefined);
  const nf = JSON.parse((await h.call("get_scene_tree", { bone_names: ["nope_bone"] })).text);
  check("unknown bone reported in requested_bones_not_found", Array.isArray(nf.requested_bones_not_found) && nf.requested_bones_not_found.includes("nope_bone"));

  console.log("\n--- P1.2 get_bone_pose surfaces world_position + world_bbox (wiring) ---");
  const pose = JSON.parse((await h.call("get_bone_pose", { bone_name: "crystal_x", time: 0.2 })).text);
  check("get_bone_pose returns world_position [x,y,z]", Array.isArray(pose.world_position) && pose.world_position.length === 3);
  check("get_bone_pose returns world_bbox.lowest_y (ground-clipping)", !!pose.world_bbox && typeof pose.world_bbox.lowest_y === "number");

  console.log("\n--- Validation (expected PASS) ---");
  const v1 = await h.call("validate_model");
  console.log(v1.text);
  check("validate_model PASSES", !v1.isError && v1.text.includes("PASSED"));

  console.log("\n--- Negative: tool-level rejections ---");
  check("reject rotating a cube", (await h.call("set_rotation", { target: "crystal_cube", rotation: [10, 0, 0] })).isError);
  check("reject multi-axis group rotation", (await h.call("set_rotation", { target: "crystal_x", rotation: [10, 10, 0] })).isError);
  const dupErr = await h.call("create_group", { name: "crystal_x" });
  check("reject duplicate group name", dupErr.isError);
  check("error carries a structured [DUPLICATE_NAME] code", /^\[DUPLICATE_NAME\]/.test(dupErr.text || ""), dupErr.text);
  const texErr = await h.call("apply_texture", { target: "crystal_cube", texture: "nope" });
  check("apply_texture fails for unregistered texture", texErr.isError);
  check("error carries a structured code prefix", /^\[[A-Z_]+\]/.test(texErr.text || ""), texErr.text);

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
