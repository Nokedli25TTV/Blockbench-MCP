// Reusable test harness: spawns the real MCP server (dist/index.js), connects a
// mock Blockbench plugin (in-memory scene graph) over socket.io, performs the MCP
// stdio handshake, and exposes a `call(name, args)` helper.
//
// This exercises the real MCP tool wiring, the socket bridge, and the real shared
// validateScene() logic. The plugin's Blockbench-API layer is the only simulated
// part — verify that in real Blockbench.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(dir, "..", "dist", "index.js");
const { io } = require(require.resolve("socket.io-client", { paths: [path.join(dir, "..", "..", "mcp-plugin")] }));

// --------------------------------------------------------------------------
// In-memory mock Blockbench scene + faithful tool handlers.
// --------------------------------------------------------------------------
export function createMockScene() {
  const scene = { roots: [], textures: [] };
  let selected = null;

  const walk = (nodes, fn) => nodes.forEach((n) => { fn(n); if (n.type === "group") walk(n.children, fn); });
  const findGroup = (name) => { let r = null; walk(scene.roots, (n) => { if (n.type === "group" && n.name === name) r = n; }); return r; };
  const findCube = (name) => { let r = null; walk(scene.roots, (n) => { if (n.type === "cube" && n.name === name) r = n; }); return r; };
  const taken = (name) => !!(findGroup(name) || findCube(name));
  const nonZero = (v) => v.filter((n) => Math.abs(n) > 1e-6).length;

  const handlers = {
    create_group(input) {
      if (!input.name) return { ok: false, error: "name required" };
      if (taken(input.name)) return { ok: false, error: `Name "${input.name}" already exists` };
      let parent = null;
      if (input.parent) { parent = findGroup(input.parent); if (!parent) return { ok: false, error: "parent not found" }; }
      const g = { type: "group", uuid: randomUUID(), name: input.name, origin: input.origin || [0, 0, 0], rotation: [0, 0, 0], children: [] };
      (parent ? parent.children : scene.roots).push(g);
      selected = g;
      return { ok: true, name: g.name, uuid: g.uuid, parent: parent ? parent.name : null };
    },
    create_cube(input) {
      if (input.name && taken(input.name)) return { ok: false, error: `Name "${input.name}" already exists` };
      let parent = null;
      if (input.parent) { parent = findGroup(input.parent); if (!parent) return { ok: false, error: "parent not found" }; }
      else parent = selected;
      const from = input.from || [0, 0, 0];
      const to = input.to || [from[0] + (input.size || 8), from[1] + (input.size || 8), from[2] + (input.size || 8)];
      const c = { type: "cube", uuid: randomUUID(), name: input.name || "element_1", from, to, origin: input.origin || from, rotation: [0, 0, 0], faces: {} };
      (parent ? parent.children : scene.roots).push(c);
      return { ok: true, name: c.name, from, to };
    },
    set_origin(input) {
      if (findCube(input.target)) return { ok: false, error: "target is a cube" };
      const g = findGroup(input.target); if (!g) return { ok: false, error: "group not found" };
      g.origin = input.origin; return { ok: true, name: g.name, origin: g.origin };
    },
    set_rotation(input) {
      if (findCube(input.target)) return { ok: false, error: "cube cannot be rotated (rule #1)" };
      const g = findGroup(input.target); if (!g) return { ok: false, error: "group not found" };
      if (nonZero(input.rotation) > 1) return { ok: false, error: "multi-axis rotation rejected (rule #1)" };
      g.rotation = input.rotation; return { ok: true, name: g.name, rotation: g.rotation };
    },
    register_texture(input) {
      if (!input.name) return { ok: false, error: "name required" };
      if (scene.textures.some((t) => t.name === input.name)) return { ok: false, error: "already registered" };
      const t = { uuid: randomUUID(), name: input.name };
      scene.textures.push(t);
      return { ok: true, id: t.uuid, name: t.name };
    },
    apply_texture(input) {
      const t = scene.textures.find((x) => x.uuid === input.texture || x.name === input.texture);
      if (!t) return { ok: false, error: "texture not registered (rule #2)" };
      const c = findCube(input.target); if (!c) return { ok: false, error: "cube not found" };
      (input.faces && input.faces.length ? input.faces : ["north", "south", "east", "west", "up", "down"]).forEach((f) => (c.faces[f] = { texture: t.uuid }));
      return { ok: true, target: c.name, texture: t.name };
    },
    modify_cube(input) {
      const c = findCube(input.id);
      if (!c) return { ok: false, error: `Cube "${input.id}" not found` };
      if (input.name && input.name !== c.name && taken(input.name)) return { ok: false, error: "name taken (rule #4)" };
      const from = input.from ?? c.from;
      const to = input.to ?? c.to;
      c.from = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
      c.to = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
      if (input.name) c.name = input.name;
      if (input.origin) c.origin = input.origin;
      return { ok: true, name: c.name, from: c.from, to: c.to };
    },
    delete_element(input) {
      const removeFrom = (nodes) => {
        const i = nodes.findIndex((n) => n.name === input.id || n.uuid === input.id);
        if (i >= 0) return nodes.splice(i, 1)[0];
        for (const n of nodes) if (n.type === "group") { const r = removeFrom(n.children); if (r) return r; }
        return null;
      };
      const el = removeFrom(scene.roots);
      if (!el) return { ok: false, error: `Element "${input.id}" not found` };
      return { ok: true, deleted: el.name, kind: el.type };
    },
    reparent_element(input) {
      const detach = (nodes) => {
        const i = nodes.findIndex((n) => n.name === input.id || n.uuid === input.id);
        if (i >= 0) return nodes.splice(i, 1)[0];
        for (const n of nodes) if (n.type === "group") { const r = detach(n.children); if (r) return r; }
        return null;
      };
      const isDescendant = (root, name) => root.type === "group" && (root.children.some((c) => c.name === name) || root.children.some((c) => isDescendant(c, name)));
      const moving = findGroup(input.id) || findCube(input.id);
      if (!moving) return { ok: false, error: `Element "${input.id}" not found` };
      if (input.parent !== "root") {
        const target = findGroup(input.parent);
        if (!target) return { ok: false, error: `Parent "${input.parent}" not found` };
        if (moving.type === "group" && (moving === target || isDescendant(moving, input.parent))) {
          return { ok: false, error: "cannot move group into its own descendant" };
        }
      }
      const el = detach(scene.roots);
      (input.parent === "root" ? scene.roots : findGroup(input.parent).children).push(el);
      return { ok: true, name: el.name, parent: input.parent };
    },
    list_export_formats() {
      return { ok: true, current_format_codec: "bedrock", count: 1, codecs: [{ id: "bedrock", name: "Bedrock", extension: "geo.json", has_compile: true, belongs_to_current_format: true }] };
    },
    export_model(input) {
      const id = input.codec_id || "bedrock";
      const content = JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.mock" } }] });
      return { ok: true, codec: { id, name: id, extension: "geo.json" }, file_name: "mock.geo.json", byte_length: content.length, encoding: "utf-8", wrote_to_path: input.path || null, truncated: false, content: input.max_content_length === 0 ? null : content };
    },
    get_project_info() {
      return { ok: true, info: { project: { name: "mock", uuid: "u", model_identifier: scene.model_identifier || null }, format: { id: "bedrock", animation_mode: true }, counts: { animations: scene.animations?.length || 0 } } };
    },
    set_project(input) {
      const changed = [];
      if (input.model_identifier !== undefined) { scene.model_identifier = input.model_identifier; changed.push("model_identifier"); }
      if (input.name !== undefined) changed.push("name");
      if (!changed.length) return { ok: false, error: "nothing to set" };
      return { ok: true, changed, model_identifier: scene.model_identifier || null, name: input.name || "mock" };
    },
    export_animations(input) {
      const content = JSON.stringify({ format_version: "1.8.0", animations: { "animation.idle": { loop: true } } });
      return { ok: true, count: 1, byte_length: content.length, wrote_to_path: input.path || null, truncated: false, content: input.max_content_length === 0 ? null : content };
    },
    create_texture(input) {
      if (!input.name) return { ok: false, error: "name required" };
      if (scene.textures.some((t) => t.name === input.name)) return { ok: false, error: "already exists" };
      const t = { uuid: randomUUID(), name: input.name, id: String(scene.textures.length), width: input.width || 16, height: input.height || 16 };
      scene.textures.push(t);
      return { ok: true, id: t.uuid, uuid: t.uuid, name: t.name, width: t.width, height: t.height };
    },
    list_textures() { return { ok: true, textures: scene.textures }; },
    get_texture(input) {
      const t = input.texture ? scene.textures.find((x) => x.uuid === input.texture || x.name === input.texture) : scene.textures[0];
      if (!t) return { ok: false, error: "texture not found" };
      return { ok: true, name: t.name, uuid: t.uuid, data_url: "data:image/png;base64,iVBORw0KGgo=" };
    },
    activate_texture(input) {
      const t = scene.textures.find((x) => x.uuid === input.texture || x.name === input.texture);
      if (!t) return { ok: false, error: "texture not found" };
      return { ok: true, name: t.name, uuid: t.uuid };
    },
    add_texture_group(input) {
      if (!input.name) return { ok: false, error: "name required" };
      return { ok: true, name: input.name, uuid: randomUUID() };
    },
    save_checkpoint(input) {
      scene.history = scene.history || []; scene.index = scene.index ?? 0;
      scene.history.length = scene.index; // drop redo tail
      scene.history.push({ action: `[checkpoint] ${input.name}`, type: "edit", time: Date.now() });
      scene.index = scene.history.length;
      return { ok: true, name: input.name, label: `[checkpoint] ${input.name}`, index: scene.index, total: scene.history.length };
    },
    undo(input) {
      scene.history = scene.history || []; scene.index = scene.index ?? 0;
      if (scene.index === 0) return { ok: false, error: "nothing to undo" };
      const n = Math.min(input.steps || 1, scene.index);
      const undone = [];
      for (let i = 0; i < n; i++) { scene.index--; undone.push(scene.history[scene.index].action); }
      return { ok: true, undone_count: n, undone, new_index: scene.index };
    },
    redo(input) {
      scene.history = scene.history || []; scene.index = scene.index ?? 0;
      const avail = scene.history.length - scene.index;
      if (avail === 0) return { ok: false, error: "nothing to redo" };
      const n = Math.min(input.steps || 1, avail);
      const redone = [];
      for (let i = 0; i < n; i++) { redone.push(scene.history[scene.index].action); scene.index++; }
      return { ok: true, redone_count: n, redone, new_index: scene.index };
    },
    get_undo_stack() {
      const history = scene.history || []; const index = scene.index ?? 0;
      return { ok: true, stack: { index, total: history.length, can_undo: index > 0, can_redo: index < history.length, entries: history.map((e, i) => ({ index: i, action: e.action, is_applied: i < index })).reverse() } };
    },
    capture_screenshot() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    capture_app_screenshot() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    set_camera_angle() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    rename_element(input) {
      const find = (n) => findGroup(n) || findCube(n);
      const el = find(input.id);
      if (!el) return { ok: false, error: "not found" };
      if (input.new_name !== el.name && taken(input.new_name)) return { ok: false, error: "name taken" };
      el.name = input.new_name;
      return { ok: true, id: input.id, name: input.new_name };
    },
    duplicate_element(input) {
      const el = findCube(input.id) || findGroup(input.id);
      if (!el) return { ok: false, error: "not found" };
      const name = input.newName || `${el.name}_copy`;
      const dupe = { ...el, uuid: randomUUID(), name, children: el.type === "group" ? [] : undefined };
      scene.roots.push(dupe);
      return { ok: true, source: el.name, name: dupe.name, uuid: dupe.uuid };
    },
    find_elements_by_criteria(input) {
      const matches = [];
      walk(scene.roots, (n) => {
        if (input.type && input.type !== "any" && n.type !== input.type) return;
        if (input.name_contains && !n.name.toLowerCase().includes(input.name_contains.toLowerCase())) return;
        matches.push({ uuid: n.uuid, name: n.name, type: n.type });
      });
      return { ok: true, count: matches.length, truncated: false, matches };
    },
    select_all_of_type(input) {
      let count = 0;
      walk(scene.roots, (n) => { if (n.type === input.type) count++; });
      return { ok: true, type: input.type, selected: count, parent_group: input.parent_group || null };
    },
    filter_by_material(input) {
      const tex = scene.textures.find((t) => t.uuid === input.texture || t.name === input.texture);
      if (!tex) return { ok: false, error: "texture not found" };
      const matches = [];
      walk(scene.roots, (n) => {
        if (n.type !== "cube") return;
        const keys = Object.keys(n.faces || {}).filter((k) => n.faces[k].texture === tex.uuid);
        if (keys.length) matches.push({ uuid: n.uuid, name: n.name, type: "cube", ...(input.include_face_keys ? { faces: keys } : {}) });
      });
      return { ok: true, texture: { uuid: tex.uuid, name: tex.name }, count: matches.length, matches };
    },
    get_selection() { return { ok: true, counts: { cubes: 0, meshes: 0, groups: 0 }, cubes: [], meshes: [], groups: [], active_texture: null }; },
    create_pbr_material(input) {
      scene.materials = scene.materials || [];
      const m = { uuid: randomUUID(), name: input.name, is_material: true, channels: {} };
      scene.materials.push(m);
      return { ok: true, name: m.name, uuid: m.uuid };
    },
    list_materials() { return { ok: true, materials: scene.materials || [] }; },
    get_material_info(input) {
      const m = (scene.materials || []).find((x) => x.name === input.material || x.uuid === input.material);
      if (!m) return { ok: false, error: "material not found" };
      return { ok: true, info: { name: m.name, uuid: m.uuid, is_material: true, textures: [], config: null, texture_set_json: null } };
    },
    configure_material(input) {
      const m = (scene.materials || []).find((x) => x.name === input.material || x.uuid === input.material);
      if (!m) return { ok: false, error: "material not found" };
      return { ok: true, name: m.name };
    },
    assign_texture_channel(input) {
      const m = (scene.materials || []).find((x) => x.name === input.material || x.uuid === input.material);
      if (!m) return { ok: false, error: "material not found" };
      if (!scene.textures.some((t) => t.uuid === input.texture || t.name === input.texture)) return { ok: false, error: "texture not found" };
      return { ok: true, texture: input.texture, channel: input.channel, material: m.name };
    },
    import_texture_set(input) { return { ok: true, path: input.path }; },
    save_material_config() { return { ok: false, error: "no file path (mock)" }; },
    set_face_material_instance(input) {
      const c = findCube(input.cube_id);
      if (input.cube_id && !c) return { ok: false, error: "cube not found" };
      const cubes = c ? [c] : [];
      const faces = input.faces || ["north", "south", "east", "west", "up", "down"];
      cubes.forEach((cb) => faces.forEach((f) => { cb.faces[f] = { ...(cb.faces[f] || { texture: null }), material_name: input.material_name }; }));
      return { ok: true, material_name: input.material_name, faces: faces.length * cubes.length, cubes: cubes.length };
    },
    get_face_material_instances(input) {
      const c = findCube(input.cube_id);
      if (!c) return { ok: false, error: "cube not found" };
      const faces = {};
      Object.keys(c.faces || {}).forEach((f) => { faces[f] = { material_name: c.faces[f].material_name || "", texture: c.faces[f].texture || null }; });
      return { ok: true, cube: { name: c.name, uuid: c.uuid }, faces };
    },
    list_material_instances() {
      const map = {};
      walk(scene.roots, (n) => { if (n.type === "cube") Object.keys(n.faces || {}).forEach((f) => { const mn = n.faces[f].material_name; if (mn) (map[mn] = map[mn] || []).push({ cube_name: n.name, face: f }); }); });
      const list = Object.entries(map).map(([name, usages]) => ({ name, usage_count: usages.length, usages }));
      return { ok: true, total_unique_instances: list.length, material_instances: list };
    },
    bulk_set_material_instances(input) {
      let faces = 0; const cubeSet = new Set();
      (input.assignments || []).forEach((a) => { const c = findCube(a.cube_id); if (c) { cubeSet.add(c); a.faces.forEach((f) => { c.faces[f] = { ...(c.faces[f] || { texture: null }), material_name: a.material_name }; faces++; }); } });
      return { ok: true, assignments: (input.assignments || []).length, faces, cubes: cubeSet.size };
    },
    clear_material_instances(input) {
      let cleared = 0;
      walk(scene.roots, (n) => { if (n.type === "cube") Object.keys(n.faces || {}).forEach((f) => { if (n.faces[f].material_name) { n.faces[f].material_name = ""; cleared++; } }); });
      return { ok: true, cleared, cubes: 1 };
    },
    paint_fill_tool(input) {
      const t = input.texture_id ? scene.textures.find((x) => x.uuid === input.texture_id || x.name === input.texture_id) : scene.textures[0];
      if (!t) return { ok: false, error: "no texture" };
      return { ok: true, x: input.x, y: input.y, texture: t.name };
    },
    draw_shape_tool(input) {
      const t = input.texture_id ? scene.textures.find((x) => x.uuid === input.texture_id || x.name === input.texture_id) : scene.textures[0];
      if (!t) return { ok: false, error: "no texture" };
      return { ok: true, shape: input.shape, texture: t.name };
    },
    gradient_tool(input) {
      const t = input.texture_id ? scene.textures.find((x) => x.uuid === input.texture_id || x.name === input.texture_id) : scene.textures[0];
      if (!t) return { ok: false, error: "no texture" };
      return { ok: true, texture: t.name };
    },
    color_picker_tool(input) {
      const t = input.texture_id ? scene.textures.find((x) => x.uuid === input.texture_id || x.name === input.texture_id) : scene.textures[0];
      if (!t) return { ok: false, error: "no texture" };
      return { ok: true, color: "#785adc", x: input.x, y: input.y, texture: t.name };
    },
    place_mesh(input) { return { ok: true, meshes: (input.elements || []).map((e) => ({ name: e.name, uuid: randomUUID() })) }; },
    create_sphere(input) { return { ok: true, meshes: (input.elements || []).map((e) => ({ name: e.name, uuid: randomUUID() })) }; },
    create_cylinder(input) { return { ok: true, meshes: (input.elements || []).map((e) => ({ name: e.name, uuid: randomUUID() })) }; },
    extrude_mesh(input) { return { ok: true, mesh: input.mesh_id || "mesh", mode: input.mode || "faces", distance: input.distance ?? 1 }; },
    subdivide_mesh(input) { return { ok: true, mesh: input.mesh_id || "mesh", cuts: input.cuts ?? 1 }; },
    select_mesh_elements(input) { return { ok: true, mesh: input.mesh_id, mode: input.mode, selected: { vertices: 0, edges: 0, faces: 0 } }; },
    move_mesh_vertices(input) { return { ok: true, mesh: input.mesh_id || "mesh", moved: (input.vertices || []).length }; },
    delete_mesh_elements(input) { return { ok: true, mesh: input.mesh_id || "mesh", mode: input.mode || "faces" }; },
    merge_mesh_vertices(input) { return { ok: true, mesh: input.mesh_id, merged: 0 }; },
    create_mesh_face(input) { return { ok: true, mesh: input.mesh_id || "mesh", face: "f0" }; },
    knife_tool(input) { return { ok: true, mesh: input.mesh_id, points: (input.points || []).length }; },
    trigger_action(input) { return { ok: true, action: input.action, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    risky_eval(input) { return { ok: true, result: "(eval ok)" }; },
    emulate_clicks() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    fill_dialog() { return { ok: true, stack_depth: 0 }; },
    from_geo_json() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    list_armatures() { return { ok: true, data: { count: (scene.armatures || []).length, armatures: scene.armatures || [] } }; },
    add_armature(input) { scene.armatures = scene.armatures || []; const a = { uuid: randomUUID(), name: input.name || "armature", bones: [] }; scene.armatures.push(a); return { ok: true, message: `Created armature "${a.name}"`, armature: a }; },
    get_armature(input) { const a = (scene.armatures || []).find((x) => x.name === input.id || x.uuid === input.id); return a ? { ok: true, data: a } : { ok: false, error: "not found" }; },
    remove_armature(input) { return { ok: true, message: `Removed armature "${input.id}"` }; },
    update_armature(input) { return { ok: true, message: `Updated armature "${input.id}"` }; },
    list_armature_bones() { return { ok: true, data: { count: 0, bones: [] } }; },
    get_armature_bone(input) { return { ok: false, error: `Bone "${input.id}" not found.` }; },
    add_armature_bone(input) { return { ok: true, message: `Created bone "${input.name || "bone"}"`, bone: { uuid: randomUUID(), name: input.name || "bone" } }; },
    remove_armature_bone(input) { return { ok: true, message: `Removed bone "${input.id}"` }; },
    update_armature_bone(input) { return { ok: true, message: `Updated bone "${input.id}"` }; },
    update_armature_bones_batch(input) { return { ok: true, message: `Updated ${(input.ids || []).length} bone(s)` }; },
    select_armature_bones(input) { return { ok: true, message: `Selected ${(input.ids || []).length} bone(s)` }; },
    get_vertex_weights() { return { ok: true, data: { weights: {} } }; },
    set_vertex_weight(input) { return { ok: true, message: `Set weight ${input.weight}` }; },
    set_vertex_weights_batch(input) { return { ok: true, message: `Set ${Object.keys(input.weights || {}).length} weights` }; },
    clear_vertex_weights() { return { ok: true, message: "Cleared 0 vertex weights" }; },
    copy_brush_tool() { return { ok: true, texture: "atlas" }; },
    eraser_tool(input) { return { ok: true, erased: (input.coordinates || []).length, texture: "atlas" }; },
    paint_settings(input) { return { ok: true, applied: Object.keys(input) }; },
    paint_with_brush(input) { return { ok: true, painted: (input.coordinates || []).length, texture: "atlas" }; },
    create_brush_preset(input) { return { ok: true, name: input.name }; },
    load_brush_preset(input) { return { ok: true, name: input.preset_name }; },
    texture_selection(input) { return { ok: true, action: input.action, texture: "atlas" }; },
    texture_layer_management(input) { return { ok: true, action: input.action, message: `${input.action} ok` }; },
    paint_pixel_matrix(input) {
      const rows = input.pixels || [];
      let painted = 0;
      for (const r of rows) for (const ch of String(r)) if ("01234".includes(ch)) painted++;
      return { ok: true, texture: input.texture_id || "atlas", palette: input.palette, painted, origin: [input.origin?.x ?? 0, input.origin?.y ?? 0], size: [Math.max(...rows.map((r) => String(r).length)), rows.length] };
    },
    get_scene_tree() { return { ok: true, tree: scene }; },
  };

  return { scene, handlers, findGroup, findCube };
}

// --------------------------------------------------------------------------
// Start server + mock + MCP client, return helpers.
// --------------------------------------------------------------------------
export async function startHarness() {
  const mock = createMockScene();
  // Run on an isolated random port so an open Blockbench (on 9999) can't interfere.
  const port = process.env.MCP_BRIDGE_PORT || String(20000 + Math.floor(Math.random() * 2000));
  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MCP_BRIDGE_PORT: port },
  });

  let buf = "";
  let nextId = 100;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });

  const rpc = (method, params) => {
    const id = nextId++;
    const p = new Promise((res) => pending.set(id, res));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? "", raw: r.result };
  };
  const listTools = async () => (await rpc("tools/list", {})).result.tools.map((t) => t.name);

  const socket = io(`http://localhost:${port}`, { transports: ["websocket", "polling"] });
  socket.on("tool_command", (cmd, ack) => {
    const fn = mock.handlers[cmd.tool];
    ack(fn ? fn(cmd.input || {}) : { ok: false, error: `unknown tool ${cmd.tool}` });
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("harness: mock socket failed to connect")), 10000);
    socket.on("connect", async () => {
      clearTimeout(t);
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "harness", version: "0" } });
      notify("notifications/initialized");
      resolve();
    });
  });

  const stop = () => { try { socket.disconnect(); } catch {} try { child.kill(); } catch {} };
  return { call, rpc, notify, listTools, scene: mock.scene, mock, stop };
}
