---
name: blockbench-use
description: "MANDATORY prerequisite — read BEFORE any mcp__blockbench__* tool call that creates, modifies, or exports Blockbench content. Routes to the right domain skill (modeling, texturing, animation, pixel shading, PBR), lists the pre-flight checks and the safety/efficiency rules. Trigger on: 3D model/texture/animation creation or edits in Blockbench; 'build a Minecraft model', 'paint a texture', 'animate this rig', 'export the model'."
---

# Blockbench Use

Read this before touching the scene, then load the domain skill(s) with `get_skill`.

## Routing

| Intent | Skill | Also load when… |
|---|---|---|
| Bones, cubes, hierarchy, pivots | `blockbench-modeling` | it needs a texture → `blockbench-texturing` |
| UV, atlas, painting, exact colours | `blockbench-texturing` | pixel-art look → `blockbench-pixel-shading` |
| Keyframes, idle/walk/attack, rigs | `blockbench-animation` | bones don't exist yet → `blockbench-modeling` |
| Normal / MER / `.texture_set.json` (Bedrock RTX) | `blockbench-pbr-materials` | needs `BLOCKBENCH_MCP_PROFILE=full` |
| "What can this do?" / unclear scope | `blockbench-mcp-overview` | — |
| Writing a Blockbench JS plugin | `blockbench-plugins` | — |

## Pre-flight (before the first edit)

1. **`get_project_info`** — is a project open, in the right format? GeckoLib / Minecraft entities need an
   animated cube format (`geckolib_model` or `bedrock`); plain blocks and static items (e.g. a
   vanilla-style sword) use `java`. Wrong or no project → `create_project` with `format="geckolib"`
   (or `bedrock` / `java`; a Java project targets Minecraft 1.20.1 unless you pass `minecraft_version`);
   it opens a new tab and leaves the current one alone. Its **`rules`** say where rotation may go:
   GeckoLib/Bedrock bones and cubes on any axes; Java block/item only cubes — groups don't export
   rotation — at one axis and -45/-22.5/0/22.5/45° for 1.9–1.21.5, inside -16..32.
2. **What's already there?** `get_scene_tree format:"outline"` (one line per part), or the JSON — on big models narrow it with `bone_names`,
   `include_faces:false` or `max_depth`; `find_elements_by_criteria` for targeted lookups.
3. **Tool missing?** The default `geckolib` profile does not load mesh, armature, PBR and brush tools.
   Ask the user to set `BLOCKBENCH_MCP_PROFILE=full` if the task truly needs them.

## Rules for every session

1. **Checkpoint before risk.** For 3+ edits you may want to undo: `save_checkpoint` first, `undo` to
   return. Never `trigger_action` "undo"/"redo" — use the dedicated tools.
2. **Batch.** `create_cubes`, `modify_cubes`, `shade_cubes`, `set_keyframes` do in one call what used to
   take dozens; each is all-or-nothing and one undo step. A known sequence of different calls goes in
   one `run_batch` (with `on_error: "rollback"` if it must be all-or-nothing).
3. **Trust the replies.** Write tools echo what they stored and add `⚠️` notes; errors start with a code
   such as `[NOT_FOUND]` or `[DUPLICATE_NAME]`. Re-query only when the reply shows a problem.
4. **Screenshots at milestones only.** They are 800 px by default; `set_camera_angle screenshot:false`
   moves the camera without an image; `time` renders an animation frame; `views` / `times` put several
   angles or frames into ONE contact-sheet image.
5. **Validate before export.** `validate_model for_export:true` checks everything the export needs in
   one report (structure, UV, faces without texture, every animation, the geometry identifier,
   meshes) and says READY or what to fix; then `export_model` (GeckoLib: `.geo.json`) and
   `export_animations`. (`validate_uv` before painting, `check_animation` while animating.)
6. **Real tools over `risky_eval`.** Use it only when no tool exists — it bypasses validation.

## Typical flows

```
New GeckoLib entity:   create_project → blockbench-modeling (create_cubes) → blockbench-texturing
                       (pack_uv → validate_uv → create_texture → apply_texture → shade_cubes)
                       → blockbench-animation (create_animation / set_keyframes → check_animation)
                       → validate_model for_export:true → export_model + export_animations
Retexture:             list_textures / filter_by_material → replace_texture or repaint the regions
Fix an animation:      get_keyframes (no bone = all bones) → set_keyframes → check_animation
```
