// validate_model for_export (the export preflight) through the real server and the mock:
// structure, geometry identifier, textures, UV, meshes and every animation in one report.
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const one = (s) => s.replace(/\n/g, " ⏎ ").slice(0, 300);

const h = await startHarness();
try {
  h.mock.setFormat({ id: "geckolib_model", bone_rig: true, rotate_cubes: true });
  await h.call("create_cubes", {
    groups: [{ name: "body", origin: [0, 12, 0] }, { name: "head", parent: "body", origin: [0, 24, 0] }],
    cubes: [{ name: "body_cube", parent: "body", from: [-4, 12, -2], to: [4, 24, 2] }, { name: "head_cube", parent: "head", from: [-4, 24, -4], to: [4, 32, 4] }],
  });
  const cube = (name) => { let r = null; const walk = (ns) => ns.forEach((n) => { if (n.name === name) r = n; if (n.children) walk(n.children); }); walk(h.scene.roots); return r; };
  const faces = (texture) => Object.fromEntries(["north", "south", "east", "west", "up", "down"].map((f) => [f, { texture }]));
  cube("body_cube").faces = faces(null);
  cube("head_cube").faces = faces(null);

  const plain = await h.call("validate_model", {});
  check("without for_export: the old structure report", !plain.isError && /^Validation PASSED/.test(plain.text), one(plain.text));

  let r = await h.call("validate_model", { for_export: true });
  check("no identifier, no texture: NOT READY with the reasons", r.isError && /NOT READY/.test(r.text) && /\(geometry-identifier\)/.test(r.text) && /\(no-texture\)/.test(r.text), one(r.text));

  await h.call("set_project", { model_identifier: "preflight_mob" });
  await h.call("create_texture", { name: "skin" });
  r = await h.call("validate_model", { for_export: true });
  check("faces without a texture are listed", /\(faces-without-texture\) 12 face\(s\) have no texture: /.test(r.text) && /body_cube \(north, south, east, west, up, down\)/.test(r.text) && /head_cube \(/.test(r.text) && !/geometry-identifier/.test(r.text), one(r.text));

  await h.call("apply_texture", { target: "body", texture: "skin", apply_mode: "all" });
  const realUv = h.mock.handlers.validate_uv;
  h.mock.handlers.validate_uv = () => ({ ok: true, valid: false, overlaps: 2, out_of_bounds: 1, null_uv: 0, zero_size_uv: 0 });
  r = await h.call("validate_model", { for_export: true });
  check("an invalid UV layout is an error (run pack_uv)", r.isError && /\(uv\) UV layout is not valid — overlaps 2, out of bounds 1/.test(r.text), one(r.text));
  h.mock.handlers.validate_uv = realUv;

  h.scene.format = { ...h.scene.format, meshes: false };
  h.scene.mesh_count = 2;
  r = await h.call("validate_model", { for_export: true });
  check("meshes in a cubes-only format are an error for export", r.isError && /\[ERROR\] \(mesh-in-box-format\) 2 mesh element/.test(r.text), one(r.text));
  h.scene.mesh_count = 0;

  await h.call("create_animation", { name: "walk", animation_length: 1, loop: true, bones: { body: [{ time: 0, rotation: [0, 0, 0] }] } });
  await h.call("set_keyframes", { keyframes: [{ bone: "body", channel: "rotation", time: 0, values: [0, 0, 0] }, { bone: "body", channel: "rotation", time: 0.5, values: [120, 0, 0] }] });
  r = await h.call("validate_model", { for_export: true });
  check("animation problems are reported per animation, warnings still READY", !r.isError && /READY ✅/.test(r.text) && /\(animation animation\.walk\) body\.rotation turns 120°/.test(r.text), one(r.text));
  check("…with the next step", /Next: export_model \(GeckoLib → \.geo\.json\) and export_animations\./.test(r.text), one(r.text));
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 PREFLIGHT CHECKS PASSED" : "💥 " + failures + " PREFLIGHT CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
