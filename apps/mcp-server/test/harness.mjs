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
// The same rotation/coordinate rules the plugin enforces (Node strips the TS types).
import { rulesFor, checkRotation, checkBounds, javaBlockVersionFor } from "../../../packages/shared/src/formatRules.ts";
import { rampFromBase, MATERIALS } from "../../../packages/shared/src/facePainter.ts";
import { VIEWS, sheetLayout } from "../../../packages/shared/src/views.ts";
import { worldPoints, boxOf, throughChain, toModelDelta, placementDelta, anchorPoint, mirroredName, mirrorCoord, shiftBox, roundVec, SIDES, ALIGNS, ANCHORS } from "../../../packages/shared/src/placement.ts";

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(dir, "..", "dist", "index.js");
const { io } = require(require.resolve("socket.io-client", { paths: [path.join(dir, "..", "..", "mcp-plugin")] }));

// --------------------------------------------------------------------------
// In-memory mock Blockbench scene + faithful tool handlers.
// --------------------------------------------------------------------------
export function createMockScene() {
  // format null = the legacy strict rules (groups one axis, cubes never); tests switch
  // formats with setFormat({ id, bone_rig, rotate_cubes, java_block_version, coordinate_limits }).
  const scene = { roots: [], textures: [], format: null };
  let selected = null;
  const rules = () => rulesFor(scene.format);
  const setFormat = (f) => { scene.format = f; };
  const rotationError = (kind, rot, label) => (rot ? checkRotation(kind === "cube" ? rules().cube : rules().bone, rot, label) : null);
  const boundsError = (from, to, label) => checkBounds(rules(), from, to, label);

  const walk = (nodes, fn) => nodes.forEach((n) => { fn(n); if (n.type === "group") walk(n.children, fn); });
  const findGroup = (name) => { let r = null; walk(scene.roots, (n) => { if (n.type === "group" && n.name === name) r = n; }); return r; };
  const findCube = (name) => { let r = null; walk(scene.roots, (n) => { if (n.type === "cube" && n.name === name) r = n; }); return r; };
  const taken = (name) => !!(findGroup(name) || findCube(name));
  // Placement helpers — the plugin's, over the mock scene (packages/shared/src/placement.ts).
  const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const geo = (n) => n.type === "group"
    ? { name: n.name, kind: "group", origin: n.origin || [0, 0, 0], rotation: n.rotation || [0, 0, 0], children: (n.children || []).map(geo) }
    : { name: n.name, kind: "cube", origin: n.origin || [0, 0, 0], rotation: n.rotation || [0, 0, 0], from: n.from, to: n.to };
  const groupsAbove = (target) => {
    const find = (nodes, trail) => {
      for (const n of nodes) {
        if (n === target) return trail;
        if (n.type === "group") { const r = find(n.children || [], [n, ...trail]); if (r) return r; }
      }
      return null;
    };
    return find(scene.roots, []) || [];
  };
  const chainOf = (n) => groupsAbove(n).map((g) => ({ origin: g.origin || [0, 0, 0], rotation: g.rotation || [0, 0, 0] }));
  const worldBox = (n) => boxOf(worldPoints(geo(n), chainOf(n)));
  const subtree = (n) => [n, ...(n.type === "group" ? (n.children || []).flatMap(subtree) : [])];
  const shiftNode = (n, d) => {
    const add = (v) => v && v.map((x, i) => Math.round((x + d[i]) * 1e4) / 1e4);
    if (n.type === "group") n.origin = add(n.origin);
    else { n.from = add(n.from); n.to = add(n.to); n.origin = add(n.origin); }
  };
  const moveRangeError = (nodes, d) => {
    for (const n of nodes) {
      if (n.type !== "cube") continue;
      const err = boundsError(n.from.map((v, i) => v + d[i]), n.to.map((v, i) => v + d[i]), `Cube "${n.name}"`);
      if (err) return err;
    }
    return null;
  };
  const findAny = (id) => findCube(id) || findGroup(id);
  // Mirrors the plugin: sub-1-unit cubes are allowed but reported as a warning.
  const thinWarning = (from, to, label) => {
    const d = [0, 1, 2].map((i) => Math.abs(to[i] - from[i]));
    return d.some((n) => n < 1) ? `${label} is thinner than 1 unit on an axis [${d.join(", ")}]` : null;
  };
  const keyframes = {}; // "bone.channel" -> [{ time, values, interpolation }]
  const animations = []; // [{ uuid, name }]
  let mockAnimLength = 2; // seconds, for set_keyframes / check_animation
  const animName = (n) => (n.startsWith("animation.") ? n : `animation.${n}`);
  const findAnim = (id) => animations.find((a) => a.uuid === id || a.name === id || a.name === animName(id));

  const handlers = {
    create_group(input) {
      if (!input.name) return { ok: false, error: "name required" };
      if (taken(input.name)) return { ok: false, error: `Name "${input.name}" already exists` };
      let parent = null;
      if (input.parent) { parent = findGroup(input.parent); if (!parent) return { ok: false, error: "parent not found" }; }
      const rotErr = rotationError("bone", input.rotation, `Group "${input.name}"`);
      if (rotErr) return { ok: false, error: rotErr };
      const g = { type: "group", uuid: randomUUID(), name: input.name, origin: input.origin || [0, 0, 0], rotation: input.rotation || [0, 0, 0], children: [] };
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
      const problem = boundsError(from, to, `Cube "${input.name || "new cube"}"`) || rotationError("cube", input.rotation, `Cube "${input.name || "new cube"}"`);
      if (problem) return { ok: false, error: problem };
      const c = { type: "cube", uuid: randomUUID(), name: input.name || "element_1", from, to, origin: input.origin || from, rotation: input.rotation || [0, 0, 0], faces: {}, uv_offset: input.uv_offset };
      (parent ? parent.children : scene.roots).push(c);
      const warning = thinWarning(from, to, `Cube "${c.name}"`);
      return { ok: true, name: c.name, from, to, ...(warning ? { warning } : {}) };
    },
    create_animation(input) {
      if (!input.name) return { ok: false, error: "name required" };
      const missing = Object.keys(input.bones || {}).filter((b) => !findGroup(b));
      if (missing.length) return { ok: false, error: `Bone(s) not found: ${missing.join(", ")}` };
      if (findAnim(input.name)) return { ok: false, error: `Animation "${input.name}" already exists` };
      const a = { uuid: randomUUID(), name: animName(input.name) };
      animations.push(a);
      return { ok: true, name: a.name, uuid: a.uuid, selected: true, bones: Object.keys(input.bones || {}).length };
    },
    list_animations() { return { ok: true, animations: animations.map((a) => ({ uuid: a.uuid, name: a.name })) }; },
    manage_animation(input) {
      const a = findAnim(input.animation_id || "");
      if (!a) return { ok: false, error: `Animation "${input.animation_id}" not found` };
      if (input.action === "delete") { animations.splice(animations.indexOf(a), 1); return { ok: true, action: "delete", name: a.name, remaining: animations.length }; }
      if (!input.new_name) return { ok: false, error: `new_name is required for ${input.action}` };
      const nn = animName(input.new_name);
      if (findAnim(nn)) return { ok: false, error: `Animation "${nn}" already exists` };
      if (input.action === "rename") { const prev = a.name; a.name = nn; return { ok: true, action: "rename", name: nn, previous_name: prev, uuid: a.uuid }; }
      const copy = { uuid: randomUUID(), name: nn };
      animations.push(copy);
      return { ok: true, action: "duplicate", name: nn, source: a.name, uuid: copy.uuid };
    },
    create_project(input) {
      const aliases = { geckolib: "geckolib_model", bedrock: "bedrock", java: "java_block" };
      const known = ["geckolib_model", "bedrock", "java_block", "free"];
      const id = aliases[String(input.format || "").toLowerCase()] || input.format;
      if (!known.includes(id)) return { ok: false, error: `Format "${input.format}" not found. Available: ${known.join(", ")}.` };
      if (input.model_identifier) scene.model_identifier = input.model_identifier;
      // Report the new project's rules like the plugin does — without switching the mock's
      // own format, which the other checks rely on (tests use setFormat for that).
      const javaVersion = id === "java_block" ? javaBlockVersionFor(String(input.minecraft_version || input.default_minecraft_version || "26.3")) : null;
      const newRules = rulesFor(id === "java_block"
        ? { id, bone_rig: false, rotate_cubes: true, java_block_version: javaVersion, coordinate_limits: [-16, 32] }
        : { id, bone_rig: true, rotate_cubes: true });
      return { ok: true, format: id, name: input.name || null, model_identifier: scene.model_identifier || null, animation_mode: id !== "java_block", texture: [input.texture_width || 16, input.texture_height || 16], rules: newRules.summary, java_block_version: javaVersion };
    },
    replace_texture(input) {
      const t = scene.textures.find((x) => x.uuid === input.texture || x.name === input.texture);
      if (!t) return { ok: false, error: `Texture "${input.texture}" not found` };
      if (!input.data) return { ok: false, error: "data required" };
      return { ok: true, name: t.name, uuid: t.uuid, source: String(input.data).startsWith("data:image/") ? "data_url" : "path" };
    },
    set_keyframes(input) {
      const entries = input.keyframes || [];
      if (!entries.length) return { ok: false, error: "keyframes[] is required" };
      for (let i = 0; i < entries.length; i++) if (!findGroup(entries[i].bone)) return { ok: false, error: `keyframes[${i}]: bone "${entries[i].bone}" not found` };
      let created = 0, updated = 0, cleared = 0;
      if (input.clear_first) for (const key of new Set(entries.map((e) => `${e.bone}.${e.channel}`))) { cleared += (keyframes[key] || []).length; keyframes[key] = []; }
      const touched = new Set();
      for (const e of entries) {
        const key = `${e.bone}.${e.channel}`;
        const ch = (keyframes[key] ??= []);
        const k = ch.find((x) => Math.abs(x.time - e.time) < 0.001);
        if (k) { k.values = e.values; updated++; } else { ch.push({ time: e.time, values: e.values, interpolation: e.interpolation || "linear" }); created++; }
        ch.sort((a, b) => a.time - b.time);
        touched.add(key);
      }
      const stored = {};
      for (const key of touched) stored[key] = keyframes[key].map((k) => ({ ...k }));
      // Like Blockbench: a keyframe past the end grows the animation.
      const before = mockAnimLength;
      for (const e of entries) mockAnimLength = Math.max(mockAnimLength, e.time);
      return { ok: true, animation: "animation.mock", created, updated, cleared, stored, ...(mockAnimLength !== before ? { length_changed: { from: before, to: mockAnimLength } } : {}) };
    },
    check_animation(input) {
      const maxJump = input.max_jump || 90;
      const issues = [];
      const bones = new Set();
      let count = 0;
      for (const [key, kfs] of Object.entries(keyframes)) {
        if (!kfs.length) continue;
        const [bone, ch] = key.split(".");
        bones.add(bone); count += kfs.length;
        if (!findGroup(bone)) issues.push({ severity: "error", rule: "missing-bone", message: `Keyframes target "${bone}", which is not a bone in this model.` });
        if (ch === "rotation") for (let i = 1; i < kfs.length; i++) {
          const d = Math.max(...[0, 1, 2].map((j) => Math.abs(kfs[i].values[j] - kfs[i - 1].values[j])));
          if (d > maxJump) issues.push({ severity: "warning", rule: "rotation-jump", message: `${bone}.rotation turns ${d}° between ${kfs[i - 1].time}s and ${kfs[i].time}s.` });
        }
      }
      return { ok: true, animation: "animation.mock", length: mockAnimLength, loop: "loop", bones: bones.size, keyframes: count, issues, ...(typeof input.floor_y === "number" ? { lowest: { y: -0.5, time: 1 } } : {}) };
    },
    get_keyframes(input) {
      const chans = input.channel ? [input.channel] : ["rotation", "position", "scale"];
      const read = (bone) => Object.fromEntries(chans.map((c) => [c, (keyframes[`${bone}.${c}`] || []).map((k) => ({ ...k }))]));
      if (input.bone_name && !input.bone_names) {
        if (!findGroup(input.bone_name)) return { ok: false, error: `Bone/group "${input.bone_name}" not found.` };
        return { ok: true, animation: "animation.mock", bone: input.bone_name, has_animator: true, channels: read(input.bone_name) };
      }
      const names = input.bone_names || [...new Set(Object.keys(keyframes).filter((k) => keyframes[k].length).map((k) => k.split(".")[0]))];
      const bones = {}, not_found = [];
      for (const n of names) { if (!findGroup(n)) not_found.push(n); else bones[n] = read(n); }
      return { ok: true, animation: "animation.mock", bones, ...(not_found.length ? { not_found } : {}) };
    },
    manage_keyframes(input) {
      if (!findGroup(input.bone_name)) return { ok: false, error: `Bone "${input.bone_name}" not found` };
      const ch = (keyframes[`${input.bone_name}.${input.channel}`] ??= []);
      const at = (t) => ch.find((k) => Math.abs(k.time - t) < 0.001);
      let affected = 0;
      for (const kf of input.keyframes || []) {
        const k = at(kf.time);
        if (input.action === "create") { ch.push({ time: kf.time, values: kf.values ?? [0, 0, 0], interpolation: kf.interpolation || "linear" }); affected++; }
        else if (input.action === "edit" && k) { if (kf.values !== undefined) k.values = kf.values; affected++; }
        else if (input.action === "delete" && k) { ch.splice(ch.indexOf(k), 1); affected++; }
        else if (input.action === "select" && k) affected++;
      }
      ch.sort((a, b) => a.time - b.time);
      return { ok: true, action: input.action, affected, bone: input.bone_name, channel: input.channel, stored: ch.map((k) => ({ ...k })) };
    },
    create_cubes(input) {
      const groups = Array.isArray(input.groups) ? input.groups : [];
      const cubes = Array.isArray(input.cubes) ? input.cubes : [];
      if (!groups.length && !cubes.length) return { ok: false, error: "provide groups[] and/or cubes[]" };
      // Pre-validate (all-or-nothing): unique names + resolvable parents.
      const pending = new Set();
      const batchGroups = new Set();
      for (const g of groups) {
        if (!g.name) return { ok: false, error: "group name required" };
        if (taken(g.name) || pending.has(g.name)) return { ok: false, error: `Name "${g.name}" already exists` };
        if (g.parent && !batchGroups.has(g.parent) && !findGroup(g.parent)) return { ok: false, error: `parent "${g.parent}" not found` };
        const rotErr = rotationError("bone", g.rotation, `groups ("${g.name}")`);
        if (rotErr) return { ok: false, error: rotErr };
        pending.add(g.name); batchGroups.add(g.name);
      }
      for (const c of cubes) {
        if (c.name && (taken(c.name) || pending.has(c.name))) return { ok: false, error: `Name "${c.name}" already exists` };
        if (c.parent && !batchGroups.has(c.parent) && !findGroup(c.parent)) return { ok: false, error: `parent "${c.parent}" not found` };
        const f0 = c.from || [0, 0, 0];
        const t0 = c.to || [f0[0] + (c.size || 8), f0[1] + (c.size || 8), f0[2] + (c.size || 8)];
        const problem = boundsError(f0, t0, `cubes ("${c.name}")`) || rotationError("cube", c.rotation, `cubes ("${c.name}")`);
        if (problem) return { ok: false, error: problem };
        if (c.name) pending.add(c.name);
      }
      // Apply.
      const made = {};
      const resolve = (name) => (name ? (made[name] || findGroup(name)) : null);
      const createdGroups = [], createdCubes = [], warnings = [];
      for (const g of groups) {
        const node = { type: "group", uuid: randomUUID(), name: g.name, origin: g.origin || [0, 0, 0], rotation: g.rotation || [0, 0, 0], children: [] };
        const parent = resolve(g.parent);
        (parent ? parent.children : scene.roots).push(node);
        made[g.name] = node; createdGroups.push(g.name);
      }
      let idx = 1;
      for (const c of cubes) {
        let name = c.name;
        if (!name) { while (taken(`element_${idx}`) || pending.has(`element_${idx}`)) idx++; name = `element_${idx}`; pending.add(name); }
        const from = c.from || [0, 0, 0];
        const to = c.to || [from[0] + (c.size || 8), from[1] + (c.size || 8), from[2] + (c.size || 8)];
        const node = { type: "cube", uuid: randomUUID(), name, from, to, origin: c.origin || from, rotation: c.rotation || [0, 0, 0], faces: {}, uv_offset: c.uv_offset };
        const parent = resolve(c.parent);
        (parent ? parent.children : scene.roots).push(node);
        createdCubes.push(name);
        const w = thinWarning(from, to, `Cube "${name}"`);
        if (w) warnings.push(w);
      }
      return { ok: true, groups: createdGroups, cubes: createdCubes, ...(warnings.length ? { warnings } : {}) };
    },
    set_origin(input) {
      const anchor = input.anchor;
      if (anchor !== undefined && input.origin !== undefined) return { ok: false, error: "Give 'origin' [x,y,z] or 'anchor', not both." };
      if (anchor !== undefined && !ANCHORS.includes(anchor)) return { ok: false, error: `anchor must be one of ${ANCHORS.join(", ")}.` };
      if (anchor === undefined && !isV3(input.origin)) return { ok: false, error: "'origin' must be 3 finite numbers [x,y,z] (rule #1)." };
      const pivotFor = (n) => {
        if (anchor === undefined) return input.origin;
        const g = geo(n);
        const b = boxOf(g.kind === "group" ? g.children.flatMap((c) => worldPoints(c, [])) : worldPoints({ ...g, rotation: [0, 0, 0] }, []));
        return b ? anchorPoint(b, anchor) : null;
      };
      const noGeometry = (n) => ({ ok: false, error: `"${n.name}" has no geometry to anchor a pivot to — give 'origin' instead.` });
      const cube = findCube(input.target);
      if (cube) {
        if (!rules().cube.allowed) return { ok: false, error: "target is a cube, and cubes don't rotate in this format" };
        const o = pivotFor(cube); if (!o) return noGeometry(cube);
        cube.origin = o; return { ok: true, name: cube.name, origin: cube.origin, type: "cube", ...(anchor ? { anchor } : {}) };
      }
      const g = findGroup(input.target); if (!g) return { ok: false, error: "group not found" };
      const o = pivotFor(g); if (!o) return noGeometry(g);
      g.origin = o; return { ok: true, name: g.name, origin: g.origin, ...(anchor ? { anchor } : {}) };
    },
    set_rotation(input) {
      const cube = findCube(input.target);
      if (cube) {
        const err = rotationError("cube", input.rotation, `Cube "${cube.name}"`);
        if (err) return { ok: false, error: err };
        cube.rotation = input.rotation; return { ok: true, name: cube.name, rotation: cube.rotation, type: "cube" };
      }
      const g = findGroup(input.target); if (!g) return { ok: false, error: "group not found" };
      const err = rotationError("bone", input.rotation, `Group "${g.name}"`);
      if (err) return { ok: false, error: err };
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
      let cubes = [];
      const c = findCube(input.target);
      if (c) cubes = [c];
      else {
        const g = findGroup(input.target);
        if (!g) return { ok: false, error: "target not found" };
        walk(g.children, (n) => { if (n.type === "cube") cubes.push(n); });
        if (!cubes.length) return { ok: false, error: "group has no descendant cubes" };
      }
      const faces = input.faces && input.faces.length ? input.faces : ["north", "south", "east", "west", "up", "down"];
      cubes.forEach((cu) => faces.forEach((f) => (cu.faces[f] = { texture: t.uuid })));
      return { ok: true, target: input.target, texture: t.name, cubes: cubes.length, meshes: 0, mode: input.apply_mode || "blank" };
    },
    modify_cube(input) {
      const c = findCube(input.id);
      if (!c) return { ok: false, error: `Cube "${input.id}" not found` };
      if (input.name && input.name !== c.name && taken(input.name)) return { ok: false, error: "name taken (rule #4)" };
      const from = input.from ?? c.from;
      const to = input.to ?? c.to;
      const problem = (input.from || input.to ? boundsError(from, to, `Cube "${c.name}"`) : null) || rotationError("cube", input.rotation, `Cube "${c.name}"`);
      if (problem) return { ok: false, error: problem };
      if (input.rotation) c.rotation = input.rotation;
      c.from = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
      c.to = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
      if (input.name) c.name = input.name;
      if (input.origin) c.origin = input.origin;
      return { ok: true, name: c.name, from: c.from, to: c.to };
    },
    modify_cubes(input) {
      const entries = input.cubes || [];
      if (!entries.length) return { ok: false, error: "cubes[] is required" };
      const seen = new Set();
      for (let i = 0; i < entries.length; i++) {
        const c = findCube(entries[i].id);
        if (!c) return { ok: false, error: `cubes[${i}]: Cube "${entries[i].id}" not found` };
        if (seen.has(c.uuid)) return { ok: false, error: `cubes[${i}]: cube "${c.name}" appears twice in the batch` };
        seen.add(c.uuid);
        const e = entries[i];
        const problem = (e.from || e.to ? boundsError(e.from ?? c.from, e.to ?? c.to, `Cube "${c.name}"`) : null) || rotationError("cube", e.rotation, `Cube "${c.name}"`);
        if (problem) return { ok: false, error: `cubes[${i}]: ${problem}` };
      }
      const out = entries.map((e) => {
        const c = findCube(e.id);
        const from = e.from ?? c.from, to = e.to ?? c.to;
        c.from = [0, 1, 2].map((i) => Math.min(from[i], to[i]));
        c.to = [0, 1, 2].map((i) => Math.max(from[i], to[i]));
        if (e.uv_offset) c.uv_offset = e.uv_offset;
        if (e.rotation) c.rotation = e.rotation;
        if (e.name) c.name = e.name;
        return { name: c.name, from: c.from, to: c.to, uv_offset: c.uv_offset };
      });
      return { ok: true, cubes: out };
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
      const r = rules();
      return { ok: true, info: { project: { name: "mock", uuid: "u", model_identifier: scene.model_identifier || null }, format: { id: scene.format?.id || "bedrock", animation_mode: true }, rules: { summary: r.summary, coordinate_limits: r.coordinateLimits }, counts: { animations: scene.animations?.length || 0 } } };
    },
    set_project(input) {
      const changed = [];
      if (input.model_identifier !== undefined) { scene.model_identifier = input.model_identifier; changed.push("model_identifier"); }
      if (input.name !== undefined) changed.push("name");
      if (input.minecraft_version !== undefined) {
        if (scene.format?.id !== "java_block") return { ok: false, error: "minecraft_version only applies to Java block/item projects." };
        const key = javaBlockVersionFor(String(input.minecraft_version));
        if (!key) return { ok: false, error: `"${input.minecraft_version}" is not a Minecraft version like 1.20.1 or 26.3.` };
        scene.format = { ...scene.format, java_block_version: key };
        changed.push("minecraft_version");
      }
      if (!changed.length) return { ok: false, error: "nothing to set" };
      return { ok: true, changed, model_identifier: scene.model_identifier || null, name: input.name || "mock", rules: rules().summary };
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
    capture_screenshot(input) {
      const png = "data:image/png;base64,iVBORw0KGgo=";
      if (!Array.isArray(input.views) && !Array.isArray(input.times)) return { ok: true, data_url: png };
      // Contact sheet: the plugin renders; the mock reports the same cell labels and grid.
      const views = input.views || [], times = input.times || [];
      if (views.some((v) => !VIEWS.includes(v))) return { ok: false, error: `views must be from: ${VIEWS.join(", ")}.` };
      const cells = [];
      for (const t of times.length ? times : [null]) for (const v of views.length ? views : [null]) cells.push([v, t !== null ? `t=${t}s` : null].filter(Boolean).join(" · ") || "current view");
      return { ok: true, data_url: png, cells, ...sheetLayout(views.length, times.length) };
    },
    capture_app_screenshot() { return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" }; },
    set_camera_angle(input) {
      if (input.screenshot === false) return { ok: true, message: `Camera set to [${(input.position || []).join(", ")}].` };
      return { ok: true, data_url: "data:image/png;base64,iVBORw0KGgo=" };
    },
    rename_element(input) {
      const find = (n) => findGroup(n) || findCube(n);
      const el = find(input.id);
      if (!el) return { ok: false, error: "not found" };
      if (input.new_name !== el.name && taken(input.new_name)) return { ok: false, error: "name taken" };
      el.name = input.new_name;
      return { ok: true, id: input.id, name: input.new_name };
    },
    duplicate_element(input) {
      // Mirrors the plugin: newName for the top copy only ('{i}' with count), unique "_copy"
      // names inside, and a mirrored copy takes the other side's name when it is free.
      const el = findCube(input.id) || findGroup(input.id);
      if (!el) return { ok: false, error: "not found" };
      const count = input.count === undefined ? 1 : input.count;
      const axis = input.mirror === undefined ? null : ["x", "y", "z"].indexOf(input.mirror);
      const center = typeof input.mirror_center === "number" ? input.mirror_center : (scene.format?.id === "java_block" ? 8 : 0);
      if (input.newName && count > 1 && !input.newName.includes("{i}")) return { ok: false, error: "With count > 1, newName needs '{i}' for the copy number." };
      const topName = (k) => (input.newName ? (count > 1 ? input.newName.replace("{i}", String(k)) : input.newName) : null);
      for (let k = 1; k <= count; k++) if (topName(k) && taken(topName(k))) return { ok: false, error: `Name "${topName(k)}" already exists` };
      const off = input.offset || [0, 0, 0];
      const names = [];
      const free = (n) => !taken(n) && !names.includes(n);
      const copyName = (base) => { let n = `${base}_copy`, i = 1; while (!free(n)) n = `${base}_copy${i++}`; return n; };
      const pickName = (src, top, k) => {
        if (top && topName(k)) return topName(k);
        if (axis !== null) { const m = mirroredName(src.name, axis); if (m !== src.name && free(m)) return m; }
        return copyName(src.name);
      };
      const mirrorV = (v) => v && v.map((x, i) => (i === axis ? mirrorCoord(x, center) : x));
      const clone = (src, top, k) => {
        const name = pickName(src, top, k);
        names.push(name);
        const c = { ...src, uuid: randomUUID(), name };
        if (axis !== null) {
          c.origin = mirrorV(src.origin);
          c.rotation = (src.rotation || [0, 0, 0]).map((r, i) => (i === axis ? r : -r + 0));
          if (src.type === "cube") {
            const f = mirrorV(src.from), t = mirrorV(src.to);
            c.from = f.map((v, i) => Math.min(v, t[i])); c.to = f.map((v, i) => Math.max(v, t[i]));
            if (axis === 0) c.mirror_uv = !src.mirror_uv;
          }
        }
        shiftNode(c, off.map((v) => v * k));
        if (src.type === "group") c.children = src.children.map((ch) => clone(ch, false, k));
        return c;
      };
      const made = [];
      for (let k = 1; k <= count; k++) { const dupe = clone(el, true, k); scene.roots.push(dupe); made.push(dupe); }
      return {
        ok: true, source: el.name, name: made[0].name, uuid: made[0].uuid, count: names.length, copies: made.map((c) => c.name), names,
        ...(axis !== null ? { mirrored: { axis: input.mirror, center } } : {}),
      };
    },
    move_element(input) {
      const part = findAny(input.target);
      if (!part) return { ok: false, error: `Element or group "${input.target}" not found.` };
      if (isV3(input.offset) === isV3(input.to)) return { ok: false, error: "Give exactly one of 'offset' [x,y,z] (move by) or 'to' [x,y,z] (where the pivot goes) — both must be 3 finite numbers." };
      const chain = chainOf(part);
      const pivot = throughChain(part.origin || [0, 0, 0], chain);
      const world = isV3(input.offset) ? input.offset : roundVec([0, 1, 2].map((i) => input.to[i] - pivot[i]));
      const d = toModelDelta(world, chain);
      const nodes = subtree(part);
      const err = moveRangeError(nodes, d);
      if (err) return { ok: false, error: err };
      const before = worldBox(part);
      if (input.dry_run) return { ok: true, dry_run: true, name: part.name, delta: world, moved: nodes.length, box: before && shiftBox(before, world) };
      nodes.forEach((n) => shiftNode(n, d));
      return { ok: true, name: part.name, delta: world, moved: nodes.length, box: worldBox(part) };
    },
    place_relative(input) {
      const part = findAny(input.target);
      if (!part) return { ok: false, error: `Element or group "${input.target}" not found.` };
      const ref = findAny(input.ref);
      if (!ref) return { ok: false, error: `Reference "${input.ref}" not found.` };
      if (part === ref || subtree(part).includes(ref)) return { ok: false, error: `"${ref.name}" is inside "${part.name}" and would move with it — place against a part outside it.` };
      if (!SIDES.includes(input.side)) return { ok: false, error: `side must be one of ${SIDES.join(", ")}.` };
      const align = input.align ?? "center";
      if (!ALIGNS.includes(align)) return { ok: false, error: `align must be one of ${ALIGNS.join(", ")}.` };
      const box = worldBox(part), refBox = worldBox(ref);
      if (!box) return { ok: false, error: `"${part.name}" has no geometry to place.` };
      if (!refBox) return { ok: false, error: `Reference "${ref.name}" has no geometry to place against.` };
      const world = placementDelta(box, refBox, input.side, { gap: input.gap ?? 0, align, offset: isV3(input.offset) ? input.offset : undefined });
      const d = toModelDelta(world, chainOf(part));
      const nodes = subtree(part);
      const err = moveRangeError(nodes, d);
      if (err) return { ok: false, error: err };
      const result = { name: part.name, ref: ref.name, side: input.side, delta: world, ref_box: refBox };
      if (input.dry_run) return { ok: true, dry_run: true, ...result, box: shiftBox(box, world) };
      nodes.forEach((n) => shiftNode(n, d));
      return { ok: true, ...result, box: worldBox(part) };
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
    list_actions(input) {
      input = input || {};
      const all = [
        { id: "add_cube", name: "Add Cube", description: "Add a cube", type: "Action", triggerable: true },
        { id: "export_over", name: "Save", description: "Export over the file", type: "Action", triggerable: true },
        { id: "add_group", name: "Add Group", description: "Add a group", type: "Action", triggerable: true },
      ];
      const q = (typeof input.search === "string" ? input.search : "").toLowerCase();
      const limit = (typeof input.limit === "number" && input.limit > 0) ? Math.floor(input.limit) : 200;
      const matched = q ? all.filter((a) => a.id.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)) : all;
      const actions = matched.slice(0, limit);
      return { ok: true, count: matched.length, truncated: matched.length > actions.length, actions };
    },
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
    pack_uv(input) {
      let cubes = [];
      if (input.target) { const g = findGroup(input.target); if (g) walk(g.children, (n) => { if (n.type === "cube") cubes.push(n); }); else { const c = findCube(input.target); if (c) cubes = [c]; } }
      else walk(scene.roots, (n) => { if (n.type === "cube") cubes.push(n); });
      if (!cubes.length) return { ok: false, error: "no cubes" };
      let x = 0, W = 0, H = 0;
      cubes.forEach((c) => {
        const w = Math.abs((c.to?.[0] ?? 2) - (c.from?.[0] ?? 0)), h = Math.abs((c.to?.[1] ?? 2) - (c.from?.[1] ?? 0)), d = Math.abs((c.to?.[2] ?? 2) - (c.from?.[2] ?? 0));
        const fw = Math.max(1, Math.ceil(2 * (w + d))), fh = Math.max(1, Math.ceil(h + d));
        c.uv_offset = [x, 0]; x += fw + 1; W = x; H = Math.max(H, fh);
      });
      return { ok: true, cubes: cubes.length, texture_width: Math.max(16, W), texture_height: Math.max(16, H), packed_width: W, packed_height: H, box_uv: true, layout: cubes.map((c) => ({ name: c.name, uv_offset: c.uv_offset || [0, 0], footprint: [8, 8] })) };
    },
    validate_uv(input) {
      let cubes = [];
      if (input.target) { const g = findGroup(input.target); if (g) walk(g.children, (n) => { if (n.type === "cube") cubes.push(n); }); else { const c = findCube(input.target); if (c) cubes = [c]; } }
      else walk(scene.roots, (n) => { if (n.type === "cube") cubes.push(n); });
      return { ok: true, valid: true, cubes: cubes.length, faces: cubes.length * 6, uv_mode: "box_uv", box_uv_cubes: cubes.length, texture: [16, 16], overlaps: 0, overlapping_pairs: [], out_of_bounds: 0, null_uv: 0, zero_size_uv: 0, recommendation: "UV layout is valid." };
    },
    shade_cube(input) {
      let cubes = [];
      if (input.cube_id) { const c = findCube(input.cube_id); if (!c) return { ok: false, error: "cube not found" }; cubes = [c]; }
      else if (input.target) { const g = findGroup(input.target); if (g) walk(g.children, (n) => { if (n.type === "cube") cubes.push(n); }); else { const c = findCube(input.target); if (c) cubes = [c]; } }
      else return { ok: false, error: "cube_id or target required" };
      if (!input.color && !input.colors) return { ok: false, error: "color or colors required" };
      if (input.material !== undefined && !MATERIALS.includes(input.material)) return { ok: false, error: `Unknown material "${input.material}"` };
      let painted = 0; cubes.forEach((c) => { painted += Object.keys(c.faces || {}).length * 8; });
      const ramp = input.colors ? input.colors.slice(0, 9) : rampFromBase(input.color);
      return { ok: true, cubes: cubes.length, painted, texture: input.texture_id || "atlas", ramp, layer: input.layer || null };
    },
    shade_cubes(input) {
      const items = input.items || [];
      if (!items.length) return { ok: false, error: "items[] is required" };
      const resolved = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let cubes = [];
        if (it.cube_id) { const c = findCube(it.cube_id); if (!c) return { ok: false, error: `items[${i}]: Cube "${it.cube_id}" not found.` }; cubes = [c]; }
        else if (it.target) { const g = findGroup(it.target); if (!g) return { ok: false, error: `items[${i}]: "${it.target}" is not a group.` }; walk(g.children, (n) => { if (n.type === "cube") cubes.push(n); }); }
        else return { ok: false, error: `items[${i}]: cube_id or target required` };
        if (!it.color && !it.colors) return { ok: false, error: `items[${i}]: color or colors required` };
        if (it.material !== undefined && !MATERIALS.includes(it.material)) return { ok: false, error: `items[${i}]: Unknown material "${it.material}"` };
        resolved.push({ target: it.cube_id || it.target, cubes: cubes.length, painted: cubes.length * 48 });
      }
      return { ok: true, items: resolved.length, cubes: resolved.reduce((a, r) => a + r.cubes, 0), painted: resolved.reduce((a, r) => a + r.painted, 0), texture: input.texture_id || "atlas", layer: input.layer || null, results: resolved };
    },
    get_bone_pose(input) {
      const g = findGroup(input.bone_name);
      if (!g) return { ok: false, error: `Bone/group "${input.bone_name}" not found.` };
      // No THREE scene in the mock, so world_* are canned — this exercises the
      // server-side field passthrough, NOT the real transform math (Blockbench-only).
      return {
        ok: true, bone: input.bone_name, time: input.time ?? null,
        local_rotation: g.rotation || [0, 0, 0],
        origin: g.origin || [0, 0, 0],
        world_rotation: [0, 0, 0],
        world_position: g.origin || [0, 0, 0],
        world_bbox: { min: [0, -3, 0], max: [4, 5, 4], lowest_y: -3 },
      };
    },
    get_scene_tree(input) {
      input = input || {};
      const hasFilter = Array.isArray(input.bone_names) || input.include_faces !== undefined || input.max_depth !== undefined;
      if (!hasFilter) return { ok: true, tree: scene }; // default path unchanged
      const includeFaces = input.include_faces !== false;
      const maxDepth = (typeof input.max_depth === "number" && input.max_depth >= 0) ? Math.floor(input.max_depth) : undefined;
      const mapNode = (node, depth) => {
        if (node.type === "group") {
          const out = { type: "group", uuid: node.uuid, name: node.name, origin: node.origin, rotation: node.rotation };
          const kids = node.children || [];
          if (maxDepth !== undefined && depth >= maxDepth) { out.children = []; if (kids.length) out.truncated_children = kids.length; }
          else out.children = kids.map((c) => mapNode(c, depth + 1));
          return out;
        }
        const cube = { type: "cube", uuid: node.uuid, name: node.name, from: node.from, to: node.to, origin: node.origin, rotation: node.rotation, uv_offset: node.uv_offset };
        if (includeFaces) cube.faces = node.faces || {};
        return cube;
      };
      let rootNodes, notFound;
      const requested = Array.isArray(input.bone_names) ? input.bone_names.filter(Boolean) : [];
      if (requested.length) {
        rootNodes = []; notFound = [];
        for (const n of requested) { const g = findGroup(n); if (g) rootNodes.push(g); else notFound.push(n); }
      } else rootNodes = scene.roots;
      const tree = { roots: rootNodes.map((n) => mapNode(n, 0)), textures: scene.textures, format: scene.format || null, mesh_count: scene.mesh_count || 0 };
      if (notFound && notFound.length) tree.requested_bones_not_found = notFound;
      return { ok: true, tree };
    },
  };

  return { scene, handlers, findGroup, findCube, setFormat };
}

// --------------------------------------------------------------------------
// Start server + mock + MCP client, return helpers.
// --------------------------------------------------------------------------
// Spawn one MCP server process on `port` and speak MCP to it over stdio. Several
// can share a port: the first owns the bridge, later ones join it as relays.
export function startServer({ port, profile = "full" }) {
  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MCP_BRIDGE_PORT: String(port), BLOCKBENCH_MCP_PROFILE: profile },
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
  const listToolDefs = async () => (await rpc("tools/list", {})).result.tools;
  const listTools = async () => (await listToolDefs()).map((t) => t.name);
  const initialize = async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "harness", version: "0" } });
    notify("notifications/initialized");
  };
  const kill = () => { try { child.kill(); } catch {} };
  return { child, rpc, notify, call, listToolDefs, listTools, initialize, kill };
}

// `profile` defaults to "full" so the suites exercise every tool; pass
// "geckolib" to test the lean default profile.
export async function startHarness({ profile = "full" } = {}) {
  const mock = createMockScene();
  // Run on an isolated random port so an open Blockbench (on 9999) can't interfere.
  const port = process.env.MCP_BRIDGE_PORT || String(20000 + Math.floor(Math.random() * 2000));
  const server = startServer({ port, profile });
  const { rpc, notify, call, listTools, listToolDefs } = server;

  const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket", "polling"] });
  // Mirrors the plugin: a resent relay call (same call_id) gets the first result.
  const recentCalls = new Map();
  socket.on("tool_command", (cmd, ack) => {
    if (cmd.call_id && recentCalls.has(cmd.call_id)) return ack(recentCalls.get(cmd.call_id));
    const fn = mock.handlers[cmd.tool];
    const r = fn ? fn(cmd.input || {}) : { ok: false, error: `unknown tool ${cmd.tool}` };
    if (cmd.call_id) recentCalls.set(cmd.call_id, r);
    ack(r);
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("harness: mock socket failed to connect")), 10000);
    socket.once("connect", async () => {
      clearTimeout(t);
      await server.initialize();
      resolve();
    });
  });

  const stop = () => { try { socket.disconnect(); } catch {} server.kill(); };
  // Try one extra Socket.IO connection (e.g. with a browser Origin header) and
  // disconnect it again; resolves "connected" or "rejected".
  const probeConnect = (extraHeaders = {}) => new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], extraHeaders, reconnection: false, timeout: 3000 });
    const done = (r) => { try { s.disconnect(); } catch {} resolve(r); };
    s.on("connect", () => done("connected"));
    s.on("connect_error", () => done("rejected"));
  });

  return { call, rpc, notify, listTools, listToolDefs, probeConnect, scene: mock.scene, mock, stop, port, server };
}
