---
name: blockbench-mcp-overview
description: Overview of this Blockbench MCP server's tools and how they fit together. Use when starting a Blockbench session or to find the right tool. Covers modeling, texturing/UV, animation, camera, history, export and the efficiency rules that keep sessions fast.
---

# Blockbench MCP Overview

An MCP server that drives Blockbench through a plugin. It exposes **tools** (actions and queries)
and these **skill guides** (also readable as `skill://…` resources). There are no MCP prompts.

**Tool profile:** by default the server loads the `geckolib` profile — mesh editing, armatures/vertex
weights, Bedrock PBR/material instances and brush-emulation tools are not loaded, because GeckoLib
renders cubes only. If a task truly needs them, ask the user to set `BLOCKBENCH_MCP_PROFILE=full`.

## Tool map

| Domain | Tools |
|--------|-------|
| Project | `get_project_info`, `create_project` (new tab in a format: `geckolib`/`bedrock`/`java`), `set_project` |
| Geometry | `create_cubes` (batch: groups + cubes, one undo step), `modify_cubes` (batch edits, e.g. every cube's `uv_offset`), `create_cube`, `create_group`, `modify_cube`, `set_origin`, `set_rotation` (bones or cubes, as the format allows — `get_project_info` → `rules`), `duplicate_element`, `rename_element`, `reparent_element`, `delete_element` |
| Inspect | `get_scene_tree` (filters: `bone_names`, `include_faces`, `max_depth`), `find_elements_by_criteria`, `get_selection`, `validate_model` |
| Texture / UV | `pack_uv`, `validate_uv`, `create_texture`, `replace_texture`, `apply_texture`, `list_textures`, `get_texture`, `activate_texture` |
| Paint | `shade_cubes` (batch: many parts, own colours, one call), `shade_cube`, `paint_pixel_matrix`, `draw_shape_tool`, `paint_fill_tool`, `gradient_tool`, `color_picker_tool`, `texture_layer_management`, `list_palettes`, `get_palette` |
| Animation | `create_animation`, `set_keyframes` (batch: many bones × channels × times), `check_animation` (lint + floor check), `manage_animation` (delete/rename/duplicate), `manage_keyframes`, `get_keyframes` (one, several or all bones), `get_bone_pose`, `animation_timeline`, `animation_graph_editor`, `batch_keyframe_operations`, `animation_copy_paste`, `list_animations` |
| Camera | `capture_screenshot` (`time`, `max_size`), `set_camera_angle` (`screenshot:false`), `capture_app_screenshot` |
| History | `save_checkpoint`, `undo`, `redo`, `get_undo_stack` |
| Export | `list_export_formats`, `export_model`, `export_animations` |
| Escape hatches | `list_actions` + `trigger_action`, `fill_dialog`, `emulate_clicks`, `from_geo_json`, `risky_eval` (last resort) |

## Efficiency rules (these decide how fast a session is)

Tool calls themselves take milliseconds; the time goes into the number of round-trips and into
reading results. So:

1. **Batch.** One call per step, not per element: `create_cubes` builds the hierarchy,
   `modify_cubes` edits many cubes, `shade_cubes` textures every part with its own colour,
   `create_animation` / `set_keyframes` write all bones at once, `get_keyframes` with no bone reads
   them all back. Batches are all-or-nothing and one undo step each.
2. **Read narrowly.** `get_scene_tree` with `bone_names` / `include_faces:false` / `max_depth` instead
   of the full tree on big models.
3. **Screenshots sparingly.** Images are the most expensive thing to read. Screenshots are 800 px by
   default (`max_size`); use `set_camera_angle screenshot:false` to move the camera and take ONE
   `capture_screenshot` at the end, not after every step.
4. **Trust the reply.** Write tools echo what they stored (e.g. `manage_keyframes` lists the channel's
   keyframes) — don't re-query unless the reply shows a problem.
5. **Real tools over `risky_eval`.** They validate input and wrap Undo properly.

## Core workflow (GeckoLib model)

```
create_project: format="geckolib", name="dagger", model_identifier="dagger"
create_cubes: groups=[{name:"root", origin:[0,0,0]}, {name:"blade_bone", parent:"root", origin:[0,0,0]}],
              cubes=[{name:"blade", parent:"blade_bone", from:[-1,0,-0.5], to:[1,14,0.5]}, …]
set_rotation: target="blade_bone", rotation=[18,0,0]      # GeckoLib: any axes; Java 1.20.1: cubes, 22.5° steps
pack_uv                                                  # every cube gets its own atlas region
validate_uv                                              # must be VALID before painting
create_texture: name="atlas"                             # no size → uses the packed size
apply_texture: target="root", texture="atlas"
shade_cubes: items=[{cube_id:"blade", color:"#b9c2cb", edge_color:"#5f6b75", sheen:true},
                    {cube_id:"guard", color:"#d6b13a"}, {cube_id:"grip", color:"#5b3a1d"}]   # exact colours, one call
validate_model
capture_screenshot
export_model: codec_id="bedrock"   +   export_animations
```

## Animate

```
create_animation: name="idle", loop=true, animation_length=2,
  bones={"blade_bone":[{time:0, rotation:[0,0,0]}, {time:1, rotation:[4,0,0]}, {time:2, rotation:[0,0,0]}]}
check_animation: floor_y=0                     # jumps, loop pops, floor dips — one call
capture_screenshot: time=1                     # posed frame, not the rest pose
```

Read `blockbench-animation` before animating: keyframes ADD to a bone's rest rotation. All animation
tools use the values Blockbench shows; the exporter converts to the GeckoLib file convention.

## Errors

Failures start with a stable code, then the message:
`[NOT_CONNECTED]`, `[TIMEOUT]`, `[NO_PROJECT]`, `[DUPLICATE_NAME]`, `[NOT_FOUND]`, `[MISSING_TEXTURE]`,
`[ILLEGAL_ROTATION]`, `[FORMAT_UNSUPPORTED]`, `[UV_ERROR]`, `[INVALID_INPUT]`, `[ERROR]`.
Non-fatal notes arrive as `⚠️` lines in a successful reply (e.g. a cube thinner than 1 unit).

## Undo, checkpoints, export

```
save_checkpoint: name="before_arm_rework"      # appears in get_undo_stack as [checkpoint] …
undo: steps=2
list_export_formats: only_current_format=true
export_model: codec_id="bedrock", path="C:/models/dagger.geo.json", max_content_length=0
```

Content is truncated at `max_content_length` (default 100,000 chars); `byte_length` gives the real size.
