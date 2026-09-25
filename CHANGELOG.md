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
- `place_relative`: put a part against another one without computing coordinates — `side` on_top,
  below, left, right, front, back or inside, a `gap`, `align` on the other axes (center, min, max,
  keep), an extra `offset` and `dry_run`. Works on cubes and whole groups using their world bounds,
  rotations included; the model faces north, so front is −Z and its own left is −X.
- `move_element`: move a cube, mesh or a whole group — everything inside it, pivots included — by a
  world `offset` (rotated parents are accounted for), or put its pivot at a world point with `to`.
  One undo step, `dry_run`, and the format's coordinate range is checked before anything moves.
- `set_origin` → `anchor`: the pivot from the part's own geometry — its centre or the centre of its
  top, bottom, left, right, front or back side (an arm's shoulder is `top`).
- `duplicate_element` → `mirror` (x, y or z; plane at `mirror_center`, default 0, or 8 in Java
  block/item): the copy is the mirror image — positions, pivots, rotations and box UV mirrored like
  Blockbench's own Flip, and side names swapped (left_arm → right_arm, arm_L → arm_R). `count` makes
  a row of copies, each `offset` further on; `newName` then takes `{i}`. Still one undo step.
- `packages/shared/src/placement.ts`: the shared world-bounds and placement math (Euler ZYX, as
  Blockbench renders), with its own test (`test:placement`, part of `pnpm test`); checked live against
  Blockbench's 3D view.
- `capture_screenshot` → `views` and `times`: a contact sheet — several angles (front, back, left,
  right, top, bottom, iso, iso_back; each framed on the whole model) and/or animation frames in ONE
  labelled image, with a line saying which cell is which. Up to 16 pictures; the camera and the
  timeline are put back afterwards. One image read instead of one per angle or frame.
- `get_scene_tree` → `format: "outline"`: one line per group or cube (pivot, rotation, from→to,
  size, box-UV offset) instead of the pretty-printed JSON — a fraction of the text for orienting on a
  model. Views and outline have their own test (`test:views`).

### Fixed
- `export_model` without `codec_id` in a GeckoLib project exported the `.bbmodel` project file (the
  GeckoLib format's own codec) instead of the model. It now exports Bedrock geometry (`.geo.json`,
  what GeckoLib loads) — or a registered GeckoLib codec — and says so; `codec_id: "project"` still
  gives the `.bbmodel`.
- `shade_cube(s)` treated UV units as pixels, so on a texture with more pixels than its UV grid (e.g.
  a 32×32 texture on 16×16 UV) it painted only the top-left part. Each face is now painted at the
  texture's pixel size.

### Changed
- The `blockbench-modeling` skill uses the real tool names (it still listed `place_cube`,
  `add_group`, `list_outline`) and shows the place / pivot / mirror workflow.

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
