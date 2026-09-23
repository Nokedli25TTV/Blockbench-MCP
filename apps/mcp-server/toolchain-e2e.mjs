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

  console.log("\n--- Thin cubes warn (not reject) + keyframe read-back is shown ---");
  const thin = await h.call("create_cube", { name: "wing_membrane", parent: "handle_bone", from: [0, 0, 0], to: [6, 4, 0] });
  check("thin create_cube succeeds (warning, not rejection)", !thin.isError, thin.text);
  check("thin create_cube reply carries the warning", /⚠.*thinner than 1 unit/.test(thin.text || ""), thin.text);
  const thinBatch = await h.call("create_cubes", { cubes: [{ name: "ear_l", parent: "handle_bone", from: [0, 0, 0], to: [2, 3, 0.5] }] });
  check("create_cubes keeps a thin cube (no rollback) and warns", !thinBatch.isError && /⚠/.test(thinBatch.text || "") && !!h.mock.findCube("ear_l"), thinBatch.text);
  const kc = await h.call("manage_keyframes", { action: "create", bone_name: "crystal_x", channel: "rotation", keyframes: [{ time: 0, values: [0, 0, 0] }, { time: 1, values: [4, 0, 0] }] });
  check("manage_keyframes reply shows the stored keyframes", !kc.isError && /Stored now: t=0 \[0, 0, 0\] · t=1 \[4, 0, 0\]/.test(kc.text || ""), kc.text);
  const km = await h.call("manage_keyframes", { action: "edit", bone_name: "crystal_x", channel: "rotation", keyframes: [{ time: 0.5, values: [9, 9, 9] }] });
  check("edit at a time with no keyframe is flagged, not silent", !km.isError && /No keyframe matched/.test(km.text || ""), km.text);

  console.log("\n--- Round 1: screenshot diet + new tools ---");
  const cam = await h.call("set_camera_angle", { position: [20, 20, 20], projection: "perspective", screenshot: false });
  check("set_camera_angle screenshot:false returns text, no image", !cam.isError && cam.raw?.content?.[0]?.type === "text" && /Camera set/.test(cam.text), cam.text);
  const shot = await h.call("capture_screenshot", { max_size: 400 });
  check("capture_screenshot accepts max_size", !shot.isError && shot.raw?.content?.[0]?.type === "image");
  const badFmt = await h.call("create_project", { format: "nope" });
  check("create_project rejects an unknown format and lists the available ones", badFmt.isError && /Available:/.test(badFmt.text), badFmt.text);
  const proj = await h.call("create_project", { format: "geckolib", name: "dagger", model_identifier: "dagger" });
  check("create_project resolves the geckolib alias", !proj.isError && /geckolib_model/.test(proj.text), proj.text);
  const anim = await h.call("create_animation", { name: "wobble", loop: true, bones: { crystal_x: [{ time: 0, rotation: [0, 0, 0] }] } });
  check("create_animation (setup)", !anim.isError, anim.text);
  const dup = await h.call("manage_animation", { action: "duplicate", animation_id: "wobble", new_name: "wobble_fast" });
  check("manage_animation duplicate", !dup.isError && /animation\.wobble_fast/.test(dup.text), dup.text);
  const ren = await h.call("manage_animation", { action: "rename", animation_id: "wobble_fast", new_name: "wobble_quick" });
  check("manage_animation rename", !ren.isError && /animation\.wobble_quick/.test(ren.text), ren.text);
  const del = await h.call("manage_animation", { action: "delete", animation_id: "animation.wobble_quick" });
  const animsLeft = JSON.parse((await h.call("list_animations")).text).map((a) => a.name);
  check("manage_animation delete leaves only the original", !del.isError && animsLeft.length === 1 && animsLeft[0] === "animation.wobble", animsLeft.join(","));
  await h.call("register_texture", { name: "atlas_r1" });
  const rep = await h.call("replace_texture", { texture: "atlas_r1", data: "data:image/png;base64,iVBORw0KGgo=" });
  check("replace_texture swaps the image of an existing texture", !rep.isError && /atlas_r1/.test(rep.text), rep.text);
  const repBad = await h.call("replace_texture", { texture: "missing_tex", data: "C:/x.png" });
  check("replace_texture on an unknown texture fails with a code", repBad.isError && /^\[NOT_FOUND\]/.test(repBad.text), repBad.text);

  console.log("\n--- Round 2: batch tools ---");
  const sk = await h.call("set_keyframes", { keyframes: [
    { bone: "crystal_x", channel: "rotation", time: 0, values: [0, 0, 0] },
    { bone: "crystal_x", channel: "rotation", time: 1, values: [10, 0, 0] },
    { bone: "crystal_y", channel: "position", time: 0.5, values: [0, 2, 0] },
  ] });
  check("set_keyframes writes several bones/channels in one call", !sk.isError && /crystal_x\.rotation: t=0 \[0, 0, 0\] · t=1 \[10, 0, 0\]/.test(sk.text) && /crystal_y\.position: t=0\.5 \[0, 2, 0\]/.test(sk.text), sk.text);
  check("set_keyframes upserts by time (1 created, 2 updated)", /1 created, 2 updated/.test(sk.text), sk.text);
  const skBad = await h.call("set_keyframes", { keyframes: [
    { bone: "crystal_x", channel: "rotation", time: 2, values: [1, 0, 0] },
    { bone: "no_such_bone", channel: "rotation", time: 0, values: [0, 0, 0] },
  ] });
  const afterBad = JSON.parse((await h.call("get_keyframes", { bone_name: "crystal_x", channel: "rotation" })).text);
  check("set_keyframes is all-or-nothing (a bad bone writes nothing)", skBad.isError && afterBad.channels.rotation.length === 2, skBad.text);
  const gkAll = JSON.parse((await h.call("get_keyframes", {})).text);
  check("get_keyframes with no bone returns every animated bone", !!gkAll.bones?.crystal_x && !!gkAll.bones?.crystal_y, JSON.stringify(Object.keys(gkAll.bones || {})));
  const mc = await h.call("modify_cubes", { cubes: [{ id: "grip", uv_offset: [0, 0] }, { id: "pommel", uv_offset: [8, 4] }] });
  check("modify_cubes edits several cubes in one call", !mc.isError && /Modified 2 cube/.test(mc.text) && h.mock.findCube("pommel").uv_offset[1] === 4, mc.text);
  const mcBad = await h.call("modify_cubes", { cubes: [{ id: "grip", uv_offset: [4, 4] }, { id: "missing_cube" }] });
  check("modify_cubes is all-or-nothing", mcBad.isError && h.mock.findCube("grip").uv_offset[0] === 0, mcBad.text);
  const sc = await h.call("shade_cubes", { items: [{ cube_id: "grip", color: "#5b3a1d" }, { target: "handle_root", color: "#d6b13a" }] });
  check("shade_cubes paints several parts in one call", !sc.isError && /2 part\(s\)/.test(sc.text) && /grip: 1 cube/.test(sc.text), sc.text);
  const scBad = await h.call("shade_cubes", { items: [{ cube_id: "grip", color: "#ffffff" }, { cube_id: "ghost", color: "#000000" }] });
  check("shade_cubes rejects the whole batch on a bad item", scBad.isError && /items\[1\]/.test(scBad.text), scBad.text);

  console.log("\n--- Round 3: check_animation ---");
  await h.call("set_keyframes", { keyframes: [{ bone: "crystal_x", channel: "rotation", time: 1.5, values: [150, 0, 0] }] });
  const ca = await h.call("check_animation", { floor_y: 0 });
  check("check_animation flags a >90° rotation jump", !ca.isError && /\(rotation-jump\) crystal_x\.rotation turns 140/.test(ca.text), ca.text);
  check("check_animation reports the lowest point when floor_y is given", /Lowest point: y=-0\.5 at 1s/.test(ca.text), ca.text);

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

  console.log("\n--- Bridge security (4.1) + camera time (3.4) ---");
  check("bridge refuses a connection from a web page origin", (await h.probeConnect({ Origin: "https://evil.example" })) === "rejected");
  check("bridge refuses a sandboxed-iframe origin (null)", (await h.probeConnect({ Origin: "null" })) === "rejected");
  check("bridge accepts a local non-browser client", (await h.probeConnect({})) === "connected");
  const afterProbe = await h.call("get_scene_tree", { max_depth: 0 });
  check("the plugin connection survives a short-lived extra client (fallback)", !afterProbe.isError, afterProbe.text.slice(0, 80));
  const camT = await h.call("set_camera_angle", { position: [10, 10, 10], projection: "perspective", time: 0.5 });
  check("set_camera_angle accepts time", !camT.isError && camT.raw?.content?.[0]?.type === "image", camT.text);

  console.log("\n--- Tool profile: default 'geckolib' drops the non-cube tool groups ---");
  const g = await startHarness({ profile: "geckolib" });
  try {
    const defs = await g.listToolDefs();
    const names = defs.map((t) => t.name);
    console.log(`   full: ${tools.length} tools, geckolib: ${names.length} tools`);
    check("geckolib profile keeps the core tools", ["create_cubes", "get_scene_tree", "pack_uv", "manage_animation", "create_project", "replace_texture", "set_keyframes", "modify_cubes", "shade_cubes"].every((t) => names.includes(t)));
    check("geckolib profile drops mesh/armature/PBR/brush tools", !["create_sphere", "add_armature", "create_pbr_material", "paint_with_brush"].some((t) => names.includes(t)));
    check("geckolib profile loads exactly 50 fewer tools than full", tools.length - names.length === 50, `${tools.length} - ${names.length}`);
    const ann = (n) => defs.find((t) => t.name === n)?.annotations || {};
    check("annotations: reads are readOnlyHint", ann("get_scene_tree").readOnlyHint === true && ann("capture_screenshot").readOnlyHint === true);
    check("annotations: delete is destructive, create is additive", ann("delete_element").destructiveHint === true && ann("create_cube").destructiveHint === false);
  } finally {
    g.stop();
  }

  console.log(`\n${failures === 0 ? "🎉 ALL CHECKS PASSED" : "💥 " + failures + " CHECK(S) FAILED"}`);
  h.stop();
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error("TEST ERROR:", e);
  h.stop();
  process.exit(1);
}
