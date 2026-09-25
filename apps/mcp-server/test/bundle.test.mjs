// export_bundle: the mod folder layout (packages/shared/src/modAssets.ts, straight from the
// TypeScript source) and the tool through the server and the mock, writing into real temporary
// mod folders — GeckoLib 4 and 5, the ways to name the folder, overwrite, the export-check gate.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { geckolibFor, bundlePaths, bundleName, resourceNameError, pickTexture } from "../../../packages/shared/src/modAssets.ts";
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const one = (s) => s.replace(/\n/g, " ⏎ ").slice(0, 320);
const J = JSON.stringify;

console.log("--- layout ---");
check("Minecraft 1.20.1 and 1.21.4 → GeckoLib 4; 1.21.5, 1.21.11 and 26.1 → GeckoLib 5",
  geckolibFor("1.20.1") === 4 && geckolibFor("1.21.4") === 4 && geckolibFor("1.21.5") === 5 && geckolibFor("1.21.11") === 5 && geckolibFor("26.1") === 5);
check("a version that can't be read → null", geckolibFor("latest") === null);
const g4 = bundlePaths(4, "entity", "goblin"), g5 = bundlePaths(5, "item", "boss/axe");
check("GeckoLib 4: geo/, animations/, textures/ by kind", g4.model === "geo/entity/goblin.geo.json" && g4.animations === "animations/entity/goblin.animation.json" && g4.texture === "textures/entity/goblin.png", J(g4));
check("GeckoLib 5: geckolib/models/, geckolib/animations/, textures unchanged; sub-folders kept", g5.model === "geckolib/models/item/boss/axe.geo.json" && g5.animations === "geckolib/animations/item/boss/axe.animation.json" && g5.texture === "textures/item/boss/axe.png", J(g5));
check("the name: given, else the geometry identifier — without 'geometry.' or an extension",
  bundleName(undefined, "goblin") === "goblin" && bundleName(undefined, "geometry.goblin") === "goblin" && bundleName("goblin.geo.json", "x") === "goblin" && bundleName(undefined, "") === null);
check("resource names: lowercase, digits, _ - . and / between folders; nothing that climbs out",
  !resourceNameError("boss/goblin_2.v1", "name") && ["Goblin", "gob lin", "../up", "a/./b", "a//b", "/a", "a/"].every((v) => resourceNameError(v, "name")));
check("a mod_id has no folders", !resourceNameError("goblinmod", "mod_id", false) && !!resourceNameError("goblin/mod", "mod_id", false));
const twoTextures = {
  roots: [{ type: "group", name: "g", children: [{ type: "cube", name: "c", faces: { north: { texture: "b" }, south: { texture: "b" }, up: { texture: "a" }, down: { texture: null } } }] }],
  textures: [{ uuid: "a", name: "skin.png" }, { uuid: "b", name: "glow.png" }],
};
const most = pickTexture(twoTextures);
check("several textures: the one on the most faces ships, the others are named", most.texture?.name === "glow.png" && most.faces === 2 && most.others.map((t) => t.name).join() === "skin.png", J(most));
check("…or the one asked for, by name (with or without .png) or uuid", pickTexture(twoTextures, "skin").texture?.uuid === "a" && pickTexture(twoTextures, "skin.png").texture?.uuid === "a" && pickTexture(twoTextures, "b").texture?.name === "glow.png");
check("an unknown texture is an error that lists the project's", /Texture "nope" not found — the project has "skin\.png", "glow\.png"/.test(pickTexture(twoTextures, "nope").error || ""));
check("no texture at all: none, and no error", pickTexture({ roots: [], textures: [] }).texture === null);

console.log("\n--- through the server (mock Blockbench, real folders) ---");
// A mod project as the MDK lays it out, with a vanilla override folder that is not the mod's.
const tmp = mkdtempSync(path.join(tmpdir(), "bb-bundle-"));
const project = path.join(tmp, "goblinmod");
const resources = path.join(project, "src", "main", "resources");
const assets = path.join(resources, "assets");
mkdirSync(path.join(assets, "goblinmod", "lang"), { recursive: true });
mkdirSync(path.join(assets, "minecraft", "textures"), { recursive: true });
const inMod = (...p) => path.join(assets, "goblinmod", ...p);
const text = (f) => readFileSync(f, "utf8");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const h = await startHarness();
try {
  h.mock.setFormat({ id: "geckolib_model", bone_rig: true, rotate_cubes: true });
  await h.call("create_cubes", { groups: [{ name: "body", origin: [0, 12, 0] }], cubes: [{ name: "body_cube", parent: "body", from: [-4, 12, -2], to: [4, 24, 2] }] });
  await h.call("create_texture", { name: "goblin.png" });
  await h.call("apply_texture", { target: "body", texture: "goblin.png", apply_mode: "all" });

  let r = await h.call("export_bundle", { mod_dir: project });
  check("no name and no geometry identifier: asks for one", r.isError && /^\[INVALID_INPUT\] export_bundle failed: a name is required/.test(r.text), one(r.text));

  await h.call("set_project", { model_identifier: "goblin" });
  await h.call("create_animation", { name: "walk", animation_length: 1, loop: true, bones: { body: [{ time: 0, rotation: [0, 0, 0] }] } });

  r = await h.call("export_bundle", { mod_dir: project, dry_run: true });
  check("dry_run: the plan, into the mod's namespace (not the vanilla override), nothing written",
    !r.isError && /^Plan \(nothing written\): "goblin" for GeckoLib 4 \(for Minecraft 1\.20\.1\) into /.test(r.text) && r.text.includes(inMod()) &&
    /geo\/entity\/goblin\.geo\.json  — new/.test(r.text) && /animations\/entity\/goblin\.animation\.json  — new/.test(r.text) &&
    /textures\/entity\/goblin\.png  — new/.test(r.text) && /Export check: READY ✅/.test(r.text) && /would write these files/.test(r.text) && !existsSync(inMod("geo")), one(r.text));

  r = await h.call("export_bundle", { mod_dir: project });
  check("ONE call writes all three files", !r.isError && /^Exported "goblin" for GeckoLib 4/.test(r.text) && (r.text.match(/, new\)/g) || []).length === 3 && /DefaultedEntityGeoModel finds these files from "goblinmod:goblin"/.test(r.text), one(r.text));
  check("…the geometry as the codec compiled it", JSON.parse(text(inMod("geo", "entity", "goblin.geo.json")))["minecraft:geometry"]?.[0]?.description?.identifier === "geometry.mock");
  check("…the animations", !!JSON.parse(text(inMod("animations", "entity", "goblin.animation.json"))).animations?.["animation.idle"]);
  check("…the texture as PNG bytes", readFileSync(inMod("textures", "entity", "goblin.png")).subarray(0, 8).equals(PNG_SIGNATURE));
  check("…and no temp file is left behind", readdirSync(inMod("geo", "entity")).join() === "goblin.geo.json");

  r = await h.call("export_bundle", { mod_dir: project });
  check("again with nothing changed: fine, every file unchanged", !r.isError && (r.text.match(/, unchanged\)/g) || []).length === 3, one(r.text));

  const realAnimations = h.mock.handlers.export_animations;
  h.mock.handlers.export_animations = (input) => ({ ...realAnimations(input), content: J({ format_version: "1.8.0", animations: { "animation.walk": { loop: true } } }) });
  const before = text(inMod("animations", "entity", "goblin.animation.json"));
  r = await h.call("export_bundle", { mod_dir: project });
  check("a file that would change: nothing written, only that file named, overwrite suggested",
    r.isError && /^\[DUPLICATE_NAME\] export_bundle failed: nothing was written — each of these already exists with different content/.test(r.text) &&
    r.text.includes("goblin.animation.json") && !r.text.includes("goblin.geo.json") && /overwrite: true/.test(r.text) && text(inMod("animations", "entity", "goblin.animation.json")) === before, one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, dry_run: true });
  check("dry_run says which file differs and what would stop the call", !r.isError && /goblin\.animation\.json  — EXISTS and differs/.test(r.text) && /would write nothing: 1 existing file\(s\) that would change/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, overwrite: true });
  check("overwrite: true replaces it — and only it", !r.isError && /goblin\.animation\.json  \(\d+ B, replaced\)/.test(r.text) && /goblin\.geo\.json  \(\d+ B, unchanged\)/.test(r.text) && text(inMod("animations", "entity", "goblin.animation.json")).includes("animation.walk"), one(r.text));
  h.mock.handlers.export_animations = realAnimations;

  r = await h.call("export_bundle", { mod_dir: project, minecraft_version: "1.21.5" });
  check("Minecraft 1.21.5: GeckoLib 5 folders; the texture stays where it was",
    !r.isError && /for GeckoLib 5 \(for Minecraft 1\.21\.5\)/.test(r.text) && existsSync(inMod("geckolib", "models", "entity", "goblin.geo.json")) &&
    existsSync(inMod("geckolib", "animations", "entity", "goblin.animation.json")) && /textures\/entity\/goblin\.png  \(\d+ B, unchanged\)/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), geckolib: "5", kind: "item", name: "boss/axe", include: ["model"] });
  check("assets/<mod_id> as mod_dir; GeckoLib 5 as asked; an item in a sub-folder; only the model",
    !r.isError && /for GeckoLib 5 \(as asked\)/.test(r.text) && existsSync(inMod("geckolib", "models", "item", "boss", "axe.geo.json")) &&
    !existsSync(inMod("textures", "item")) && /DefaultedItemGeoModel finds these files from "goblinmod:boss\/axe"/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: resources, kind: "block", name: "goblin_totem", include: ["texture"] });
  check("the resources folder as mod_dir; a block texture", !r.isError && existsSync(inMod("textures", "block", "goblin_totem.png")), one(r.text));

  const realTexture = h.mock.handlers.get_texture;
  const bigPng = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1_200_000, 7)]);
  h.mock.handlers.get_texture = (input) => ({ ...realTexture(input), data_url: "data:image/png;base64," + bigPng.toString("base64") });
  r = await h.call("export_bundle", { mod_dir: project, name: "big", include: ["texture"] });
  check("a texture over Socket.IO's old 1 MB limit crosses the bridge whole", !r.isError && readFileSync(inMod("textures", "entity", "big.png")).equals(bigPng), one(r.text));
  h.mock.handlers.get_texture = realTexture;

  const realModel = h.mock.handlers.export_model;
  h.mock.handlers.export_model = (input) => ({ ...realModel(input), codec: { id: "project" }, content: J({ meta: { format_version: "5.0" } }) });
  r = await h.call("export_bundle", { mod_dir: project, name: "wrong_codec" });
  check("a codec that doesn't give Bedrock geometry: refused, nothing written", r.isError && /the project codec did not produce Bedrock geometry/.test(r.text) && !existsSync(inMod("geo", "entity", "wrong_codec.geo.json")) && !existsSync(inMod("textures", "entity", "wrong_codec.png")), one(r.text));
  h.mock.handlers.export_model = realModel;

  r = await h.call("export_bundle", { mod_dir: "relative/goblinmod" });
  check("a relative mod_dir is refused", r.isError && /^\[INVALID_INPUT\] .*must be an absolute path/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: path.join(tmp, "nope") });
  check("a mod_dir that isn't there: NOT_FOUND", r.isError && /^\[NOT_FOUND\]/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmdo" });
  check("a mod_id with no folder next to another mod's: refused, and the one there is named", r.isError && /^\[NOT_FOUND\] .*assets\/goblinmdo was not found .*holds goblinmod/.test(r.text) && !existsSync(path.join(assets, "goblinmdo")), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), mod_id: "other" });
  check("assets/<id> as mod_dir with a different mod_id: refused", r.isError && /^\[INVALID_INPUT\] .*so mod_id must be "goblinmod" \(got "other"\)/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, name: "Goblin King" });
  check("a name Minecraft would refuse is refused", r.isError && /^\[INVALID_INPUT\] .*name "Goblin King" must be lowercase/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "GoblinMod" });
  check("…and so is such a mod_id", r.isError && /^\[INVALID_INPUT\] .*mod_id "GoblinMod" must be lowercase/.test(r.text), one(r.text));
  mkdirSync(path.join(assets, "addonmod"));
  r = await h.call("export_bundle", { mod_dir: project, dry_run: true });
  check("two mods' assets and no mod_id: asks which", r.isError && /^\[INVALID_INPUT\] export_bundle failed: mod_id is required: .*several mods' assets \(/.test(r.text) && /addonmod/.test(r.text), one(r.text));

  const fresh = path.join(tmp, "freshmod");
  mkdirSync(path.join(fresh, "src", "main", "resources"), { recursive: true });
  r = await h.call("export_bundle", { mod_dir: fresh });
  check("a fresh mod without an assets folder: mod_id is needed", r.isError && /mod_id is required/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: fresh, mod_id: "freshmod" });
  check("…with mod_id, assets/<mod_id> is created", !r.isError && /\(created\)/.test(r.text) && existsSync(path.join(fresh, "src", "main", "resources", "assets", "freshmod", "geo", "entity", "goblin.geo.json")), one(r.text));

  await h.call("create_texture", { name: "goblin_glow.png" });
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod", name: "goblin_two", dry_run: true });
  check("two textures: the one on the faces ships, the other is named", !r.isError && /exported "goblin\.png" \(on 6 face\(s\)\), not "goblin_glow\.png"/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod", name: "goblin_glowmask", texture: "goblin_glow", include: ["texture"] });
  check("…texture picks the other (no note then)", !r.isError && existsSync(inMod("textures", "entity", "goblin_glowmask.png")) && !/one texture/.test(r.text), one(r.text));

  h.scene.roots[0].children.push({ type: "cube", uuid: "dup", name: "body_cube", from: [0, 0, 0], to: [1, 1, 1], origin: [0, 0, 0], rotation: [0, 0, 0], faces: {} });
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod", name: "broken" });
  check("an export-check error: NOT READY with the report, nothing written",
    r.isError && /^Export check: NOT READY ❌/.test(r.text) && /\(duplicate-name\) Name "body_cube" is used 2 times/.test(r.text) && /Nothing was written/.test(r.text) && !existsSync(inMod("geo", "entity", "broken.geo.json")), one(r.text));
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod", name: "broken", force: true });
  check("force: true writes anyway, and says so", !r.isError && existsSync(inMod("geo", "entity", "broken.geo.json")) && /Written although the export check found 1 error\(s\) \(force\)/.test(r.text), one(r.text));
  h.scene.roots[0].children.pop();

  h.mock.setFormat({ id: "java_block", bone_rig: false, rotate_cubes: true, java_block_version: "1.9.0", coordinate_limits: [-16, 32] });
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod" });
  check("a Java block/item project is refused: export_model is the tool there", r.isError && /^\[FORMAT_UNSUPPORTED\] .*"java_block" format is unsupported/.test(r.text), one(r.text));
} finally {
  h.stop();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "🎉 BUNDLE CHECKS PASSED" : "💥 " + failures + " BUNDLE CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
