# Changelog

All notable changes to this fork. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/):

- **patch** (0.3.0 → 0.3.1) — bug fixes, description/skill fixes, internal changes; no new tools.
- **minor** (0.3.1 → 0.4.0) — new tools, new optional parameters, new capabilities; everything that
  worked before still works.
- **major** (0.4.0 → 1.0.0) — breaking changes: a tool removed or renamed, a parameter renamed or
  made required, a reply format changed, or a server/plugin pair that must be updated together.
  Before 1.0.0, breaking changes bump the minor version and are marked **BREAKING** below.

Write every change under **Unreleased** as you make it; `pnpm bump patch|minor|major` turns that
section into the new version (see README → Releasing).

## [Unreleased]

### Added
- `export_bundle`: a GeckoLib model into a mod in ONE call — the geometry (`.geo.json`), the animations
  (`.animation.json`) and the texture (`.png`), each where GeckoLib's defaulted models
  (`DefaultedEntityGeoModel`, `…ItemGeoModel`, `…BlockGeoModel`) load it, under `assets/<mod_id>/`:
  - GeckoLib 4 (Minecraft up to 1.21.4): `geo/<kind>/`, `animations/<kind>/`, `textures/<kind>/`;
  - GeckoLib 5 (1.21.5 and newer): `geckolib/models/<kind>/`, `geckolib/animations/<kind>/`, and the
    texture where it was. `minecraft_version` (default `BLOCKBENCH_MCP_MC_VERSION`, 1.20.1) picks the
    layout; `geckolib: "4" | "5"` forces one.

  `mod_dir` is the mod project, its `src/main/resources` or its `assets/<mod_id>` folder; `mod_id` is
  read from it when there is only one mod's assets. The file name is the geometry identifier unless
  `name` gives another (sub-folders allowed; names Minecraft would refuse are refused). `kind` is
  `entity`, `item` or `block`; with several textures the one on the most faces ships, or `texture`.
  Nothing is written when the export check (as `validate_model for_export`) finds an error — `force`
  overrides — or when a file already there would change: identical files count as unchanged, and
  `overwrite: true` replaces the rest. `dry_run` shows the plan. The server writes the files (temp
  file, then moved into place), so Blockbench shows no file-permission prompt.
- `measure`: parts by number instead of from a screenshot. Each target's world box (min→max, size,
  centre) and, for every pair, where the first is relative to the second in `place_relative`'s words
  (on_top, below, left = −X, right, front = −Z, back, inside) and whether they are apart (the gap on
  each axis, the distance), touching or OVERLAPPING (how deep, the shared box and its volume). Targets
  are cubes or groups (a group's box holds everything inside it); none = the whole model. At rest it
  uses the math `place_relative` uses; with `time` (and `animation_id`) it measures the animated pose
  at that moment and puts the timeline back — does a leg pass through the body at 0.5 s? The relations
  live in `packages/shared/src/measure.ts` (`test:measure`).

### Fixed
- A plugin reply over 1 MB — e.g. a large texture, or a screenshot at `max_size: 0` — closed the
  plugin's connection, and the call timed out. The bridge now takes replies up to 64 MB, like the
  relay endpoint.

### Changed
- `validate_model for_export` names `export_bundle` as the next step for GeckoLib and Bedrock models.
- The `geckolib` profile loads 76 tools (was 74), `full` 126 (was 124).

## [0.5.0] - 2026-09-25

### Fixed
- **Undo did not work for several tools on Blockbench 5** — found by `run_batch`'s rollback, then by a
  live audit that runs every editing tool, undoes and redoes it and compares the project:
  - undoing `create_group` or `create_cubes` left the new groups behind;
  - undoing `set_origin` / `set_rotation` on a group, or `rename_element` on a group, changed nothing;
  - undoing `delete_element` on a group brought back neither the group nor its cubes;
  - `create_animation`, `create_texture`, `register_texture` and `animation_timeline` set_length /
    set_fps / loop recorded no undo step at all, so the next undo reverted an EARLIER edit instead
    (in the audit: the whole model).

  They now record what Blockbench's own actions record (groups, animations and textures in their
  own undo aspects). All 24 audited cases undo and redo cleanly.
- `from_geo_json` failed on Blockbench 5 ("reading 'initEntity'"): it parsed the geometry into the open
  project, which the Bedrock codec then tried to switch to its own format. It now loads it into a new
  Bedrock project, and refuses input that is not JSON or has no `minecraft:geometry`.
- `export_model` without `codec_id` in a GeckoLib project exported the `.bbmodel` project file (the
  GeckoLib format's own codec) instead of the model. It now exports Bedrock geometry (`.geo.json`,
  what GeckoLib loads) — or a registered GeckoLib codec — and says so; `codec_id: "project"` still
  gives the `.bbmodel`.
- `shade_cube(s)` treated UV units as pixels, so on a texture with more pixels than its UV grid (e.g.
  a 32×32 texture on 16×16 UV) it painted only the top-left part. Each face is now painted at the
  texture's pixel size.

### Added
Building without coordinate maths (the model faces north, so front is −Z and its own left is −X):
- `create_from_spec`: a whole rig from a part list in ONE call and one undo step (all-or-nothing).
  Each part becomes a bone with one cube: its size, what it rests against (`attach`: side, gap,
  align, offset — as `place_relative`) or an explicit corner, its pivot as an anchor of its own box
  (top for a shoulder or hip) or a point, a rotation, and `mirror: "x"` for the left↔right twin
  (names swapped, positions / pivots / rotations mirrored, its children under the twin). Planned in
  the server and built with one `create_cubes` call, so the format's rules apply to the whole rig;
  `dry_run` shows the plan.
- `place_relative`: put a part against another one — `side` on_top, below, left, right, front, back
  or inside, a `gap`, `align` on the other axes (center, min, max, keep — for both, or per axis like
  `{ y: "min" }`), an extra `offset` and `dry_run`. Works on cubes and whole groups using their world
  bounds, rotations included.
- `move_element`: move a cube, mesh or a whole group — everything inside it, pivots included — by a
  world `offset` (rotated parents are accounted for), or put its pivot at a world point with `to`.
  One undo step, `dry_run`, and the format's coordinate range is checked before anything moves.
- `set_origin` → `anchor`: the pivot from the part's own geometry — its centre or the centre of its
  top, bottom, left, right, front or back side (an arm's shoulder is `top`).
- `duplicate_element` → `mirror` (x, y or z; plane at `mirror_center`, default 0, or 8 in Java
  block/item): the copy is the mirror image — positions, pivots, rotations and box UV mirrored like
  Blockbench's own Flip, and side names swapped (left_arm → right_arm, arm_L → arm_R). `count` makes
  a row of copies, each `offset` further on; `newName` then takes `{i}`. Still one undo step.

Seeing and checking in fewer reads:
- `capture_screenshot` → `views` and `times`: a contact sheet — several angles (front, back, left,
  right, top, bottom, iso, iso_back; each framed on the whole model) and/or animation frames in ONE
  labelled image, with a line saying which cell is which. Up to 16 pictures (one view at several
  times, or one frame from several views, is a near-square grid); the camera and the timeline are
  put back afterwards.
- `get_scene_tree` → `format: "outline"`: one line per group or cube (pivot, rotation, from→to,
  size, box-UV offset) instead of the pretty-printed JSON — a fraction of the text.
- `validate_model` → `for_export: true`: the export preflight in one report — the structure checks
  plus the UV layout, faces without a texture, every animation (`check_animation`), the geometry
  identifier (GeckoLib/Bedrock) and meshes a cubes-only format would drop — ending in a verdict,
  READY or what to fix first, and the next step.

Animation and sequences:
- `generate_animation`: a looping `walk` or `idle` from the rig in ONE call. Bones are found by name
  (legs and arms with left = −X, body / torso / chest, head) or given; a walk swings the legs in
  opposite phase (four legs trot in diagonal pairs), the arms against the legs, bobs the body
  (highest as the legs pass) and leans it over the stance leg, keeping the head level; idle breathes,
  drifts the arms and nods. The last keyframe repeats the first, so the loop has no seam. It warns
  when a leg or arm does not pivot at its top, and runs `check_animation` on the result.
- `run_batch`: several different tool calls in ONE round trip, in order (up to 50). Each step is
  checked and run exactly like a direct call; the reply lists every step's result and carries any
  images. `on_error`: `stop` (default), `continue`, or `rollback` — undo everything the batch changed.

Under the hood: the math lives in `packages/shared/src` (`placement.ts` — world bounds with Euler ZYX,
as Blockbench renders, checked live against its 3D view — plus `views.ts`, `outline.ts`, `spec.ts`,
`gaits.ts`), each with its own test in `pnpm test` (`test:placement`, `test:views`, `test:batch`,
`test:spec`, `test:preflight`, `test:gait`).

### Changed
- The `geckolib` profile loads 74 tools (was 69), `full` 124 (was 119).
- The `blockbench-modeling` skill uses the real tool names (it still listed `place_cube`,
  `add_group`, `list_outline`) and shows the build / place / pivot / mirror workflow.

## [0.4.0] - 2026-09-24

### Fixed
- `capture_screenshot` with `project` rendered whichever project came first in the tab list when the
  open one was earlier — a screenshot of another tab silently showed the wrong model. It now matches
  the named project exactly and lists the open projects if the name is unknown.
- `duplicate_element` now uses Blockbench's own duplicate: it keeps per-face UV and textures,
  copies every child type, moves meshes once (their vertices are relative to the origin), names
  only the top copy `newName` and everything inside a unique `<name>_copy`, refuses a `newName`
  that is taken, and is a single undo step that also removes duplicated groups. Before, duplicating
  a group reported an error although the copy had been made.
- `set_project`, `create_project` and `pack_uv` refresh the UV editor and UV density after changing
  the texture size (Blockbench 5 has no `setProjectResolution`).
- `create_animation` describes the shape of `bones` in its description, because some clients flatten
  that part of the schema.
- Java block/item models could be exported with rotations Minecraft 1.20.1 refuses to load (e.g. 30°,
  or 67.5° from Blockbench's snapping), or silently lose a second axis and every group rotation. These
  are now caught before export (see Changed).

### Changed
- **`shade_cube` / `shade_cubes` paint shaded pixel art instead of flat bands.** Before, every side got
  three flat stripes and the top and bottom one colour each, so neighbouring pixels were identical and
  models looked stripy and plastic. Now each pixel is computed from an even, hue-shifted palette built
  in OKLab around the exact colour, light from above with a soft top→bottom gradient, lit top edges
  and a contact shadow, and a `material` that paints structure; each cube gets its own seed. Texture
  comes from small 2–3 px colour clusters instead of dithering, and a clean-up pass folds every lone
  pixel into its cluster, so surfaces keep their grain without dotting (single pixels remain only
  for stitches, cracks, scratches, facet edges and at most two glints per face). `colors` takes 3–9
  hex (was exactly 5).
- **Rotation rules follow the project's format** (MODELING_CONSTRAINTS rule 1):
  - GeckoLib/Bedrock: bones and cubes may rotate on several axes. The old single-axis rule came from
    Java block models; Blockbench's GeckoLib format does not restrict it.
  - **BREAKING (Java block/item):** rotating a group is refused — it was accepted before but never
    reached the game. Cube rotation is checked against the target Minecraft version (1.20.1: one axis,
    -45/-22.5/0/22.5/45°) and coordinates must stay inside -16..32.
  - `validate_model` applies the same rules; unknown formats keep the old strict rule.
- The plugin is typechecked against `blockbench-types` 5.1 (Blockbench 5) with no errors;
  `pnpm typecheck` is strict for the server and the plugin.
- The server takes its version from `apps/mcp-server/package.json`.
- CI and the release workflow run on Node 24 (the tests import the shared rules module directly).

### Removed
- Dead `auto_shade` code in the plugin (the tool was removed on 2026-06-16).
- The obsolete `@types/socket.io-client` dev dependency.

### Added
- `material`, `detail`, `lighting` and `smoothing` on `shade_cube(s)`. Materials: generic, fur, skin,
  leather (padded middle, stitched seams: warm dark holes with a light thread pixel), cloth, wood,
  planks, stone, metal, gem, plant, dungeon_stone (running-bond blocks, soft mortar, worn bevels,
  cool-tinted shadows, cracks), crystal (cut Voronoi facets around a glowing core, each a shaded
  plane, bright ridge edges), monster_fur (hanging V-shaped locks: dark roots, light tips),
  ancient_metal (sharp diagonal highlight, three-tone rust with stained metal around it, at the rims
  only), wavy_wood (flowing grain, growth rings), magma (a hot yellow-white middle, orange streaks
  along the flow, a few crust plates with a thin red glow and hairline cracks), moss, water (depth
  gradient, waves) and ice (glassy: diagonal light streaks, one straight fracture with an almost
  white edge, deep blue toward the bottom). `smoothing` runs from strong clustered texture (0) to a
  calm surface (1); each material has its own default. The painter is a pure module
  (`packages/shared/src/facePainter.ts`) with its own test (`test:painter`, part of `pnpm test`)
  that fails on flat bands, on surfaces smoothed flat, on lone dots and when a material loses its
  defining look.
- `rotation` on `create_cube`, `create_cubes` (groups and cubes), `create_group` and `modify_cube(s)`;
  `set_rotation` takes a group or a cube, `set_origin` also a cube where cubes rotate.
- `get_project_info` → `rules`: where rotation may go and the coordinate range, for the open project.
- `minecraft_version` on `create_project` / `set_project` for Java block/item projects; new Java
  projects target Minecraft 1.20.1 (`BLOCKBENCH_MCP_MC_VERSION` changes the default).
- `[OUT_OF_RANGE]` error code for coordinates outside the format's range.
- `pnpm bump patch|minor|major`, this changelog, and a release workflow that builds the zip and
  drafts a GitHub Release when a `v*` tag is pushed.
- README: installing from a release zip without building.

## [0.3.0] - 2026-09-23

First release of this fork.

### Added
- Shared bridge: several AI clients can use Blockbench at once. The first server owns port 9999,
  later ones relay through it, and a relay takes over when the owner quits. A call resent after an
  owner crash is applied once. `get_project_info` → `mcp_bridge` shows the role.
- Batch tools: `create_cubes`, `modify_cubes`, `shade_cubes`, `set_keyframes`; `get_keyframes` for
  many bones. Also `create_project`, `manage_animation`, `replace_texture`, `check_animation`
  (keyframes past the end, rotation jumps, loop seams, floor clipping), `list_actions`.
- `BLOCKBENCH_MCP_PROFILE` (default `geckolib`: 69 of 119 tools), MCP read-only/destructive
  annotations, `[CODE]` error prefixes.
- Screenshots downscaled to 800 px (`max_size`); `set_camera_angle` and `capture_screenshot` can
  pose an animation frame (`time`).
- Build id stamped automatically (`plugin_build`), CI on Ubuntu and Windows, `pnpm report`
  (usage report from Claude's local logs).

### Changed
- One animation convention: every tool stores and reports the values Blockbench shows; the exporter
  handles the GeckoLib file convention.
- World bounding boxes measure element geometry only; keyframe writes report when they extend the
  animation length; the [0,0,0]-pivot warning ignores pivots inside the bone's own cubes.

### Security
- The bridge listens on 127.0.0.1 only and refuses connections from web pages (`http(s)` and `null`
  origins); the relay endpoint requires no Origin, a custom header and a loopback Host.

Earlier history (before this fork's first release): see the git log.
