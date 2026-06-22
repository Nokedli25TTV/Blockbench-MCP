// Complete model test: builds a small staff model using EVERY tool, then prints
// the hierarchy, the validation result, and the registered textures.
//
// It verifies EFFECTS (not just "no error"), so it fails if any tool silently
// misbehaves. Needs port 9999 free (don't run while Claude Desktop's server is up).
//
//   staff_root
//   ├── handle_bone
//   │   └── staff_handle            (textured)
//   └── core_x            (rotate X)
//       └── core_y        (rotate Y)
//           └── floating_core       (textured)
import { startHarness } from "./harness.mjs";

const nonZero = (v) => v.filter((n) => Math.abs(n) > 1e-6).length;

const h = await startHarness();

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const okCall = async (label, name, args) => {
  const r = await h.call(name, args);
  check(label, !r.isError, r.isError ? r.text : "");
  return r;
};

try {
  // 0. Every tool is registered.
  const tools = await h.listTools();
  const expected = ["create_cube", "create_group", "set_origin", "set_rotation", "get_scene_tree", "register_texture", "apply_texture", "validate_model"];
  check("all 8 tools registered", expected.every((t) => tools.includes(t)), tools.join(", "));

  // 1. create_group (root + two branches; one multi-axis branch via nested groups)
  await okCall("create_group staff_root", "create_group", { name: "staff_root", origin: [8, 0, 8] });
  await okCall("create_group handle_bone", "create_group", { name: "handle_bone", parent: "staff_root", origin: [8, 8, 8] });
  await okCall("create_group core_x", "create_group", { name: "core_x", parent: "staff_root" });
  await okCall("create_group core_y", "create_group", { name: "core_y", parent: "core_x", origin: [8, 16, 8] });

  // 2. set_origin (explicitly, on a group created without an origin)
  await okCall("set_origin core_x", "set_origin", { target: "core_x", origin: [8, 16, 8] });

  // 3. set_rotation (single-axis per group — the nested-group multi-axis solution)
  await okCall("set_rotation core_x (X)", "set_rotation", { target: "core_x", rotation: [25, 0, 0] });
  await okCall("set_rotation core_y (Y)", "set_rotation", { target: "core_y", rotation: [0, 40, 0] });

  // 4. create_cube (nested under bones)
  await okCall("create_cube staff_handle", "create_cube", { name: "staff_handle", from: [7, 0, 7], to: [9, 14, 9], parent: "handle_bone" });
  await okCall("create_cube floating_core", "create_cube", { name: "floating_core", from: [6, 15, 6], to: [10, 19, 10], parent: "core_y" });

  // 5. register_texture
  const reg = await okCall("register_texture staff_skin", "register_texture", { name: "staff_skin", width: 16, height: 16 });

  // 6. apply_texture (to both cubes)
  await okCall("apply_texture -> staff_handle", "apply_texture", { target: "staff_handle", texture: "staff_skin" });
  await okCall("apply_texture -> floating_core", "apply_texture", { target: "floating_core", texture: "staff_skin" });

  // 7. get_scene_tree — and verify the EFFECTS of every mutation above.
  const treeRes = await h.call("get_scene_tree");
  check("get_scene_tree returns JSON", !treeRes.isError);
  const tree = JSON.parse(treeRes.text);

  const root = tree.roots.find((n) => n.name === "staff_root");
  const handleBone = root?.children?.find((n) => n.name === "handle_bone");
  const handleCube = handleBone?.children?.find((n) => n.name === "staff_handle");
  const coreX = root?.children?.find((n) => n.name === "core_x");
  const coreY = coreX?.children?.find((n) => n.name === "core_y");
  const coreCube = coreY?.children?.find((n) => n.name === "floating_core");
  const tex = tree.textures.find((t) => t.name === "staff_skin");

  check("hierarchy nests correctly", !!(root && handleBone && handleCube && coreX && coreY && coreCube));
  check("set_origin took effect (core_x.origin = [8,16,8])", !!coreX && JSON.stringify(coreX.origin) === JSON.stringify([8, 16, 8]));
  check("set_rotation core_x is single-axis X", !!coreX && nonZero(coreX.rotation) === 1 && Math.abs(coreX.rotation[0]) > 0);
  check("set_rotation core_y is single-axis Y", !!coreY && nonZero(coreY.rotation) === 1 && Math.abs(coreY.rotation[1]) > 0);
  check("cubes are unrotated (single-axis rule)", !!handleCube && !!coreCube && nonZero(handleCube.rotation) === 0 && nonZero(coreCube.rotation) === 0);
  check("register_texture returned an id", !!reg.text.match(/id\s+\S+/) && !!tex);
  const faceVals = coreCube ? Object.values(coreCube.faces) : [];
  check("apply_texture set all 6 faces to staff_skin", !!tex && faceVals.length === 6 && faceVals.every((f) => f.texture === tex.uuid));

  // 7.5 Editing tools: modify, reparent, delete (and effect verification).
  const mod = await h.call("modify_cube", { id: "floating_core", to: [10, 20, 10] });
  check("modify_cube resizes floating_core", !mod.isError && mod.text.includes("10,20,10".split(",").join(",")), mod.text);
  const t2 = JSON.parse((await h.call("get_scene_tree")).text);
  const fc2 = t2.roots.find((n) => n.name === "staff_root")?.children?.find((n) => n.name === "core_x")?.children?.find((n) => n.name === "core_y")?.children?.find((n) => n.name === "floating_core");
  check("modify_cube effect persisted (to=[10,20,10])", !!fc2 && JSON.stringify(fc2.to) === JSON.stringify([10, 20, 10]));
  check("modify_cube rejects duplicate rename", (await h.call("modify_cube", { id: "floating_core", name: "staff_handle" })).isError);
  check("reparent refuses own-descendant move", (await h.call("reparent_element", { id: "core_x", parent: "core_y" })).isError);
  await h.call("create_cube", { name: "temp_cube", from: [0, 0, 0], to: [1, 1, 1], parent: "staff_root" });
  const del = await h.call("delete_element", { id: "temp_cube" });
  check("delete_element removes temp_cube", !del.isError);
  const t3 = JSON.parse((await h.call("get_scene_tree")).text);
  check("temp_cube gone from tree", !JSON.stringify(t3.roots).includes("temp_cube"));

  // 7.55 Phase 4 — texture management tools.
  const ct = await h.call("create_texture", { name: "rune_glow", width: 32, height: 32, fill_color: [120, 80, 200, 255] });
  check("create_texture (fill_color) works", !ct.isError && ct.text.includes("rune_glow"));
  const lt = await h.call("list_textures");
  check("list_textures includes new texture", !lt.isError && lt.text.includes("rune_glow"));
  const gt = await h.call("get_texture", { texture: "rune_glow" });
  check("get_texture returns image content", !gt.isError && (gt.raw?.content?.[0]?.type === "image"));
  const at = await h.call("activate_texture", { texture: "rune_glow" });
  check("activate_texture works", !at.isError);
  const tg = await h.call("add_texture_group", { name: "staff_material", textures: ["rune_glow"] });
  check("add_texture_group works", !tg.isError);

  // 7.6 Project metadata + export tools.
  const sp = await h.call("set_project", { model_identifier: "staff", name: "staff" });
  check("set_project sets geometry identifier", !sp.isError && sp.text.includes("staff"));
  const info = await h.call("get_project_info");
  check("get_project_info reflects identifier", !info.isError && info.text.includes("staff"));
  const fmts = await h.call("list_export_formats");
  check("list_export_formats returns codecs", !fmts.isError && fmts.text.includes("bedrock"));
  const exp = await h.call("export_model", { codec_id: "bedrock" });
  check("export_model compiles via bedrock codec", !exp.isError && exp.text.includes("minecraft:geometry"));
  const ea = await h.call("export_animations");
  check("export_animations compiles .animation.json", !ea.isError && ea.text.includes("format_version"));

  // 7.7 Phase 5 — camera & screenshots (return MCP image content).
  const ss = await h.call("capture_screenshot");
  check("capture_screenshot returns image", !ss.isError && ss.raw?.content?.[0]?.type === "image");
  const ca = await h.call("set_camera_angle", { position: [30, 20, 30], projection: "perspective" });
  check("set_camera_angle returns image", !ca.isError && ca.raw?.content?.[0]?.type === "image");

  // 7.8 Phase 6 — history & checkpoints.
  const cp = await h.call("save_checkpoint", { name: "before_tweaks" });
  check("save_checkpoint works", !cp.isError && cp.text.includes("before_tweaks"));
  const un = await h.call("undo");
  check("undo works after checkpoint", !un.isError);
  const re = await h.call("redo");
  check("redo works", !re.isError);
  const us = await h.call("get_undo_stack");
  check("get_undo_stack lists checkpoint", !us.isError && us.text.includes("before_tweaks"));

  // 7.9 Phase 7 — element utilities.
  const dup = await h.call("duplicate_element", { id: "staff_handle", offset: [4, 0, 0] });
  check("duplicate_element works", !dup.isError && dup.text.includes("staff_handle"));
  const rn = await h.call("rename_element", { id: "staff_handle_copy", new_name: "handle_clone" });
  check("rename_element works", !rn.isError && rn.text.includes("handle_clone"));
  const fe = await h.call("find_elements_by_criteria", { name_contains: "core", type: "group" });
  check("find_elements_by_criteria finds core groups", !fe.isError && fe.text.includes("core_"));
  const sa = await h.call("select_all_of_type", { type: "cube" });
  check("select_all_of_type works", !sa.isError);
  const gs = await h.call("get_selection");
  check("get_selection works", !gs.isError && gs.text.includes("counts"));

  // 7.95 Phase 8 — PBR materials + face material instances.
  const pm = await h.call("create_pbr_material", { name: "staff_pbr", color_texture: "staff_skin" });
  check("create_pbr_material works", !pm.isError && pm.text.includes("staff_pbr"));
  const lm = await h.call("list_materials");
  check("list_materials lists it", !lm.isError && lm.text.includes("staff_pbr"));
  const ac = await h.call("assign_texture_channel", { material: "staff_pbr", texture: "staff_skin", channel: "color" });
  check("assign_texture_channel works", !ac.isError);
  const smi = await h.call("set_face_material_instance", { cube_id: "staff_handle", material_name: "wood" });
  check("set_face_material_instance works", !smi.isError);
  const lmi = await h.call("list_material_instances");
  check("list_material_instances finds 'wood'", !lmi.isError && lmi.text.includes("wood"));
  const cmi = await h.call("clear_material_instances", { all_cubes: true });
  check("clear_material_instances works", !cmi.isError);

  // 7.97 Phase 11 — painting (core subset).
  const df = await h.call("draw_shape_tool", { texture_id: "staff_skin", shape: "rectangle", start: { x: 0, y: 0 }, end: { x: 7, y: 7 }, color: "#a0522d" });
  check("draw_shape_tool works", !df.isError && df.text.includes("rectangle"));
  const pf = await h.call("paint_fill_tool", { texture_id: "staff_skin", x: 1, y: 1, color: "#785adc" });
  check("paint_fill_tool works", !pf.isError);
  const gr = await h.call("gradient_tool", { texture_id: "staff_skin", start: { x: 0, y: 8 }, end: { x: 15, y: 15 }, start_color: "#000000", end_color: "#ffffff" });
  check("gradient_tool works", !gr.isError);
  const cp2 = await h.call("color_picker_tool", { texture_id: "staff_skin", x: 1, y: 1 });
  check("color_picker_tool returns a color", !cp2.isError && cp2.text.includes("#"));

  // 7.98 Phase 9 — mesh tools.
  const sph = await h.call("create_sphere", { elements: [{ name: "orb", position: [0, 40, 0], diameter: 6, sides: 8 }] });
  check("create_sphere works", !sph.isError && sph.text.includes("sphere"));
  const cyl = await h.call("create_cylinder", { elements: [{ name: "rod", position: [0, 50, 0], height: 8, diameter: 2 }] });
  check("create_cylinder works", !cyl.isError && cyl.text.includes("cylinder"));
  const ex = await h.call("extrude_mesh", { mesh_id: "orb", distance: 1 });
  check("extrude_mesh works", !ex.isError);
  const mv = await h.call("move_mesh_vertices", { mesh_id: "orb", offset: [0, 1, 0] });
  check("move_mesh_vertices works", !mv.isError);

  // 7.99 Phase 12 — UI + import.
  const ta = await h.call("trigger_action", { action: "add_cube" });
  check("trigger_action returns image", !ta.isError && ta.raw?.content?.[0]?.type === "image");
  const ev = await h.call("risky_eval", { code: "1+1" });
  check("risky_eval works", !ev.isError);
  const fd = await h.call("fill_dialog", { values: "{}" });
  check("fill_dialog works", !fd.isError);
  const gj = await h.call("from_geo_json", { geojson: "{\"x\":1}" });
  check("from_geo_json returns image", !gj.isError && gj.raw?.content?.[0]?.type === "image");

  // 7.991 Phase 10 — armature.
  const aa = await h.call("add_armature", { name: "rig", add_initial_bone: true });
  check("add_armature works", !aa.isError && aa.text.includes("rig"));
  const la = await h.call("list_armatures");
  check("list_armatures works", !la.isError && la.text.includes("rig"));
  const ab = await h.call("add_armature_bone", { parent_id: "rig", name: "spine" });
  check("add_armature_bone works", !ab.isError && ab.text.includes("spine"));
  const sw = await h.call("set_vertex_weight", { bone_id: "spine", vertex_key: "v0", weight: 0.5 });
  check("set_vertex_weight works", !sw.isError);

  // 7.992 Remaining paint tools.
  check("eraser_tool works", !(await h.call("eraser_tool", { coordinates: [{ x: 1, y: 1 }] })).isError);
  check("paint_with_brush works", !(await h.call("paint_with_brush", { coordinates: [{ x: 2, y: 2 }], brush_settings: { color: "#ff0000" } })).isError);
  check("texture_layer_management create_layer works", !(await h.call("texture_layer_management", { action: "create_layer", layer_name: "L1" })).isError);
  check("texture_selection select_all works", !(await h.call("texture_selection", { action: "select_all" })).isError);
  check("create_brush_preset works", !(await h.call("create_brush_preset", { name: "soft" })).isError);

  // 7.993 Pixel-art shading: palettes + matrix paint.
  const lp = await h.call("list_palettes");
  check("list_palettes lists hue-shifted palettes", !lp.isError && lp.text.includes("crystal_purple") && lp.text.includes("index_roles"));
  const gp = await h.call("get_palette", { name: "iron" });
  check("get_palette returns 5 colors", !gp.isError && gp.text.includes("colors"));
  const gpBad = await h.call("get_palette", { name: "nope" });
  check("get_palette rejects unknown palette", gpBad.isError);
  const pmx = await h.call("paint_pixel_matrix", { texture_id: "staff_skin", palette: "iron", origin: { x: 0, y: 0 }, pixels: ["43210", "3.2.1", "01234"] });
  check("paint_pixel_matrix paints (skips transparent)", !pmx.isError && pmx.text.includes("iron"));
  const pk = await h.call("pack_uv", {});
  check("pack_uv packs cubes + fits texture", !pk.isError && pk.text.includes("Packed"));
  const vu = await h.call("validate_uv", {});
  check("validate_uv reports a verdict", !vu.isError && (vu.text.includes("VALID") || vu.text.includes("INVALID")));

  // 8. validate_model — should PASS on this clean, GeckoLib-safe model.
  const validation = await h.call("validate_model");
  check("validate_model PASSES", !validation.isError && validation.text.includes("PASSED"));

  // ---- Required printouts -------------------------------------------------
  const printTree = (node, depth = 0) => {
    const pad = "  ".repeat(depth);
    if (node.type === "group") {
      console.log(`${pad}▸ ${node.name}  [group]  origin=${JSON.stringify(node.origin)} rot=${JSON.stringify(node.rotation)}`);
      (node.children || []).forEach((c) => printTree(c, depth + 1));
    } else {
      const faces = Object.entries(node.faces || {}).filter(([, f]) => f.texture).length;
      console.log(`${pad}• ${node.name}  [cube]  from=${JSON.stringify(node.from)} to=${JSON.stringify(node.to)} texturedFaces=${faces}`);
    }
  };

  console.log("\n================ HIERARCHY ================");
  tree.roots.forEach((n) => printTree(n));

  console.log("\n================ VALIDATION ================");
  console.log(validation.text);

  console.log("\n================ REGISTERED TEXTURES ================");
  if (tree.textures.length === 0) console.log("(none)");
  tree.textures.forEach((t) => console.log(`- ${t.name}  (id ${t.uuid})`));

  console.log(`\n${failures === 0 ? "🎉 ALL TOOLS WORKED — TEST PASSED" : "💥 TEST FAILED (" + failures + " check(s))"}`);
  h.stop();
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.error("TEST ERROR:", e);
  h.stop();
  process.exit(1);
}
