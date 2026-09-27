// export_bundle: the mod folder layout (packages/shared/src/modAssets.ts, straight from the
// TypeScript source) and the tool through the server and the mock, writing into real temporary
// mod folders — GeckoLib 4 and 5, the ways to name the folder, overwrite, the export-check gate.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
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

  console.log("\n--- import_bundle (real folders) ---");
  // A small real PNG (the mock's export texture is the signature alone).
  const png = (w, h) => {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
    return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const put = (rel, content) => { const f = inMod(...rel.split("/")); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, content); return f; };
  const geo = (id, bones) => J({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: `geometry.${id}` }, bones }] });
  const wolfBones = [{ name: "body", pivot: [0, 8, 0], cubes: [{ origin: [-3, 6, -5], size: [6, 6, 10] }] }, { name: "head", parent: "body", pivot: [0, 10, -5], cubes: [{ origin: [-2, 8, -9], size: [4, 4, 4] }, { origin: [-1, 8, -10], size: [2, 2, 1] }] }];
  put("geo/entity/wolf.geo.json", geo("wolf", wolfBones));
  put("animations/entity/wolf.animation.json", J({ format_version: "1.8.0", animations: { "animation.wolf.walk": { loop: true }, "animation.wolf.idle": { loop: true } } }));
  put("textures/entity/wolf.png", png(4, 2));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "wolf", dry_run: true });
  check("dry run: the three files where GeckoLib keeps them, what each holds, nothing opened",
    !r.isError && /^Plan \(nothing opened\): a new GeckoLib project "wolf" from /.test(r.text) && /geo\/entity\/wolf\.geo\.json  \(geometry\.wolf: 2 bone\(s\), 3 cube\(s\)\)/.test(r.text) &&
    /animations\/entity\/wolf\.animation\.json  \(2 animation\(s\): animation\.wolf\.walk, animation\.wolf\.idle\)/.test(r.text) && /textures\/entity\/wolf\.png  \(4×2\)/.test(r.text) && /To save it back: export_bundle to_source: true — the same files/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "wolf" });
  check("import: a new GeckoLib project with the bones, animations and texture; nothing linked",
    !r.isError && /^Opened "wolf" as a new geckolib_model project from .*: 2 bone\(s\), 3 cube\(s\), 2 animation\(s\) \(animation\.wolf\.walk, animation\.wolf\.idle\), texture wolf\.png 16×16; geometry identifier wolf\./.test(r.text) && /Nothing in the mod is linked/.test(r.text), one(r.text));
  put("geo/troll.geo.json", geo("troll", wolfBones.slice(0, 1)));
  put("animations/troll.animation.json", J({ format_version: "1.8.0", animations: { "animation.troll.smash": {} } }));
  const trollSkin = put("textures/entity/troll_skin.png", png(2, 2));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "troll" });
  check("a mod with its own GeoModel paths: found by name under geo/ and animations/; a texture with another name is not guessed",
    !r.isError && /geo\/troll\.geo\.json/.test(r.text) && /animations\/troll\.animation\.json/.test(r.text) && /no troll\.png found \(pass texture: its path/.test(r.text) && /to_source: true/.test(r.text) && /not GeckoLib's default places: export_bundle with mod_dir would write new files/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "troll", texture: trollSkin });
  check("…texture given by path", !r.isError && /texture troll_skin\.png/.test(r.text), one(r.text));
  put("geo/a/twin.geo.json", geo("twin", [])); put("geo/b/twin.geo.json", geo("twin", []));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "twin" });
  check("two files of that name: refused, both listed", r.isError && /there are 2 files named twin\.geo\.json: geo\/a\/twin\.geo\.json, geo\/b\/twin\.geo\.json/.test(r.text), one(r.text));
  const pack = put("geo/pack.geo.json", J({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.alpha" }, bones: [] }, { description: { identifier: "geometry.beta" }, bones: wolfBones }] }));
  r = await h.call("import_bundle", { geo: pack, name: "beta", dry_run: true });
  check("a file with several geometries: name picks one", !r.isError && /geometry\.beta: 2 bone\(s\), 3 cube\(s\), 1 of 2 geometries/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { geo: pack, name: "gamma" });
  check("…none of that name: refused, the identifiers listed", r.isError && /holds 2 geometries \(alpha, beta\) and none is "gamma"/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { geo: put("geo/entity/broken.geo.json", "{nope") });
  check("a geo file that isn't JSON: refused before Blockbench is touched", r.isError && /broken\.geo\.json" is not valid JSON/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { geo: put("geo/entity/notgeo.geo.json", J({ hello: 1 })) });
  check("JSON that is no model: refused", r.isError && /has no "minecraft:geometry"/.test(r.text), one(r.text));
  put("geo/entity/fake.geo.json", geo("fake", [])); put("textures/entity/fake.png", "not a png");
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "fake" });
  check("a .png that isn't one: refused", r.isError && /fake\.png" is not a PNG/.test(r.text), one(r.text));
  const loose = path.join(tmp, "loose", "lonely.geo.json"); mkdirSync(path.dirname(loose), { recursive: true }); writeFileSync(loose, geo("lonely", wolfBones));
  r = await h.call("import_bundle", { geo: loose });
  check("a geo file outside any mod: the name from the file; no animations or texture looked for", !r.isError && /^Opened "lonely"/.test(r.text) && /no lonely\.animation\.json found/.test(r.text) && /no lonely\.png found/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { mod_dir: inMod(), name: "ghost" });
  check("no such model: refused, where it looked is named", r.isError && /no ghost\.geo\.json in ".*" \(geo, geckolib\/models\)/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { geo: "relative/wolf.geo.json" });
  check("a relative path is refused", r.isError && /geo must be an absolute path/.test(r.text), one(r.text));
  r = await h.call("import_bundle", { name: "wolf" });
  check("neither mod_dir nor geo: says what is needed", r.isError && /give mod_dir \(with name\), or geo/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), name: "roundtrip", include: ["model", "animations"] });
  const back = await h.call("import_bundle", { mod_dir: inMod(), name: "roundtrip" });
  check("export_bundle, then import_bundle, finds the same files", !r.isError && !back.isError && /geo\/entity\/roundtrip\.geo\.json/.test(back.text) && /animations\/entity\/roundtrip\.animation\.json/.test(back.text) && /To save it back: export_bundle to_source: true/.test(back.text), one(back.text));

  console.log("\n--- export_bundle back to the imported files, and paths ---");
  await h.call("import_bundle", { mod_dir: inMod(), name: "troll", texture: trollSkin });
  const trollBefore = text(inMod("geo", "troll.geo.json"));
  r = await h.call("export_bundle", { to_source: true, dry_run: true });
  check("to_source, dry run: the three files the import came from, each would change",
    !r.isError && /^Plan \(nothing written\): "troll" for GeckoLib 4 \(as imported\) into /.test(r.text) && /geo\/troll\.geo\.json  — EXISTS and differs/.test(r.text) &&
    /animations\/troll\.animation\.json  — EXISTS and differs/.test(r.text) && /textures\/entity\/troll_skin\.png  — EXISTS and differs/.test(r.text) && /would write nothing: 3 existing file\(s\)/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { to_source: true });
  check("to_source without overwrite: nothing written, the files listed", r.isError && /\[DUPLICATE_NAME\]/.test(r.text) && r.text.includes(inMod("geo", "troll.geo.json")) && text(inMod("geo", "troll.geo.json")) === trollBefore, one(r.text));
  r = await h.call("export_bundle", { to_source: true, overwrite: true });
  check("to_source, overwrite: written back to the same three files",
    !r.isError && /geo\/troll\.geo\.json  \(\d+ B, replaced\)/.test(r.text) && /textures\/entity\/troll_skin\.png  \(\d+ B, replaced\)/.test(r.text) && /Written back to the files the model was imported from/.test(r.text) && text(inMod("geo", "troll.geo.json")) !== trollBefore, one(r.text));
  r = await h.call("export_bundle", { to_source: true, mod_dir: inMod() });
  check("to_source with mod_dir: refused (it writes back where the import came from)", r.isError && /leave out mod_dir and paths/.test(r.text), one(r.text));
  put("geo/solo.geo.json", geo("solo", wolfBones));
  await h.call("import_bundle", { mod_dir: inMod(), name: "solo" });
  r = await h.call("export_bundle", { to_source: true, dry_run: true });
  check("to_source, parts the import did not bring: at GeckoLib's default place, and said so",
    !r.isError && /geo\/solo\.geo\.json  — EXISTS and differs/.test(r.text) && /animations\/entity\/solo\.animation\.json  — new/.test(r.text) && /did not come with the import: written at GeckoLib's default place/.test(r.text), one(r.text));
  await h.call("import_bundle", { geo: loose });
  r = await h.call("export_bundle", { to_source: true, include: ["model"] });
  check("to_source for a file outside any mod's assets: refused", r.isError && /is not inside an assets\/<mod_id> folder/.test(r.text), one(r.text));
  h.scene.imported_from = null;
  r = await h.call("export_bundle", { to_source: true });
  check("to_source on a project that was not imported: refused, what to give instead", r.isError && /was not opened with import_bundle/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), name: "custom", include: ["model"], paths: { model: "geo/custom/custom.geo.json" } });
  check("paths, relative to assets/<mod_id>: the part goes there; the reply says the mod's GeoModel must point at it",
    !r.isError && existsSync(inMod("geo", "custom", "custom.geo.json")) && /geo\/custom\/custom\.geo\.json  \(\d+ B, new\)/.test(r.text) && /the mod's own GeoModel has to point at them/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { include: ["model"], paths: { model: inMod("geo", "absolute.geo.json") } });
  check("paths, absolute, without mod_dir: the assets folder is taken from the path", !r.isError && existsSync(inMod("geo", "absolute.geo.json")) && r.text.includes(inMod()), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), include: ["model"], paths: { model: "geo/custom.json" } });
  check("a path with the wrong extension: refused", r.isError && /paths\.model must end in \.geo\.json/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { include: ["model"], paths: { model: path.join(tmp, "outside.geo.json") } });
  check("a path outside any assets/<mod_id>: refused", r.isError && /is not inside an assets\/<mod_id> folder/.test(r.text) && !existsSync(path.join(tmp, "outside.geo.json")), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), include: ["model"], paths: { model: "geo/Custom.geo.json" } });
  check("a path Minecraft would refuse (a capital): refused", r.isError && /must be lowercase/.test(r.text), one(r.text));

  h.mock.setFormat({ id: "java_block", bone_rig: false, rotate_cubes: true, java_block_version: "1.9.0", coordinate_limits: [-16, 32] });
  r = await h.call("export_bundle", { mod_dir: project, mod_id: "goblinmod" });
  check("a Java block/item project needs kind: item or block", r.isError && /a Java model is an item or a block/.test(r.text), one(r.text));

  console.log("\n--- Java item / block ---");
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "entity" });
  check("…and not entity", r.isError && /a Java model is an item or a block/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "ruby_sword", dry_run: true });
  check("Java item, dry run: the model under models/item/, its texture under textures/item/, how the item finds it",
    !r.isError && /^Plan \(nothing written\): "ruby_sword" as a Java item model for Minecraft 1\.20\.1 into /.test(r.text) && /models\/item\/ruby_sword\.json  — new/.test(r.text) &&
    /textures\/item\/ruby_sword\.png  — new/.test(r.text) && /The item "goblinmod:ruby_sword" uses models\/item\/ruby_sword\.json by its registry name/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "ruby_sword" });
  const sword = JSON.parse(text(inMod("models", "item", "ruby_sword.json")));
  check("the texture reference points at the mod, a particle is added, the faces keep #0",
    !r.isError && J(sword.textures) === J({ 0: "goblinmod:item/ruby_sword", particle: "goblinmod:item/ruby_sword" }) && sword.elements.some((e) => e.faces?.north?.texture === "#0") && existsSync(inMod("textures", "item", "ruby_sword.png")), J(sword.textures));
  check("…written as Blockbench writes models: short arrays on one line", /"from": \[-?[\d.]+, -?[\d.]+, -?[\d.]+\]/.test(text(inMod("models", "item", "ruby_sword.json"))));
  await h.call("create_cubes", { cubes: [{ name: "gem_cube", from: [0, 24, 0], to: [1, 25, 1] }] });
  await h.call("create_texture", { name: "gem" });
  await h.call("apply_texture", { target: "gem_cube", texture: "gem", apply_mode: "all" });
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "gem_sword" });
  const gemSword = JSON.parse(text(inMod("models", "item", "gem_sword.json")));
  check("two textures: one file each, <name>_<texture>, each reference pointed at its own",
    !r.isError && existsSync(inMod("textures", "item", "gem_sword_goblin.png")) && existsSync(inMod("textures", "item", "gem_sword_gem.png")) &&
    Object.values(gemSword.textures).includes("goblinmod:item/gem_sword_goblin") && Object.values(gemSword.textures).includes("goblinmod:item/gem_sword_gem"), J(gemSword.textures));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "block", name: "goblin_block", extras: true });
  check("a block with extras: models/block/, textures/block/, the blockstate and the block's item model (before 1.21.4)",
    !r.isError && existsSync(inMod("models", "block", "goblin_block.json")) && JSON.parse(text(inMod("blockstates", "goblin_block.json"))).variants[""].model === "goblinmod:block/goblin_block" &&
    JSON.parse(text(inMod("models", "item", "goblin_block.json"))).parent === "goblinmod:block/goblin_block" && /finds this model through blockstates\/goblin_block\.json/.test(r.text), one(r.text));
  writeFileSync(inMod("blockstates", "goblin_block.json"), J({ variants: { "facing=north": { model: "goblinmod:block/goblin_block" } } }));
  const handMade = text(inMod("blockstates", "goblin_block.json"));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "block", name: "goblin_block", extras: true, overwrite: true });
  check("extras never change an existing blockstate — not even with overwrite: kept", !r.isError && /blockstates\/goblin_block\.json  \(\d+ B, kept — already there\)/.test(r.text) && text(inMod("blockstates", "goblin_block.json")) === handMade, one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "block", name: "plain_block" });
  check("without extras: the missing blockstate and item model are named, not written",
    !r.isError && /Missing: blockstates\/plain_block\.json, models\/item\/plain_block\.json — extras: true creates them/.test(r.text) && !existsSync(inMod("blockstates", "plain_block.json")), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "new_sword", minecraft_version: "1.21.4", extras: true });
  check("Minecraft 1.21.4: items/new_sword.json points at the model",
    !r.isError && J(JSON.parse(text(inMod("items", "new_sword.json")))) === J({ model: { type: "minecraft:model", model: "goblinmod:item/new_sword" } }) && /finds its model through items\/new_sword\.json/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "late_sword", minecraft_version: "26.3", dry_run: true });
  check("the project's rotation rules and the mod's Minecraft version differ: said so", /the mod is Minecraft 26\.3 — its rotations may not load there/.test(r.text), one(r.text));
  await h.call("create_texture", { name: "block/stone" });
  const stone = h.scene.textures.find((t) => t.name === "block/stone");
  h.scene.roots.push({ type: "cube", uuid: "stone-cube", name: "stone_base", from: [0, 0, 0], to: [16, 1, 16], origin: [0, 0, 0], rotation: [0, 0, 0], faces: { up: { texture: stone.uuid } } });
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "block", name: "stone_base_block", dry_run: true });
  check("a reference that already is a resource location (block/stone) is kept, its image not shipped",
    !r.isError && /Kept as they are — already resource locations, their images not shipped: block\/stone/.test(r.text) && !/stone_base_block_block/.test(r.text), one(r.text));
  h.scene.roots.pop();
  r = await h.call("export_bundle", { mod_dir: inMod(), kind: "item", name: "x", paths: { model: "models/item/x.json" } });
  check("paths / to_source are refused for a Java model", r.isError && /to_source and paths are for GeckoLib models/.test(r.text), one(r.text));
  r = await h.call("export_bundle", { kind: "item", name: "x" });
  check("no mod_dir: asks for it", r.isError && /give mod_dir/.test(r.text), one(r.text));
} finally {
  h.stop();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "🎉 BUNDLE CHECKS PASSED" : "💥 " + failures + " BUNDLE CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
