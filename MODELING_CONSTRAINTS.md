# Modeling Constraints — Minecraft Java / GeckoLib / Blockbench

**These are HARD RULES, not suggestions.** They govern (a) how the AI drives this MCP
server as a 3D modeler, and (b) how new MCP tools are written. If a requested operation
conflicts with a rule, do **not** guess or silently change intent — fail with a clear
explanation and propose the engine-compatible workaround (rule 7).

The MCP tools enforce the machine-checkable parts of these rules and return a structured
error (`{ ok: false, error }`) instead of fabricating success.

---

## 1. Geometry & rotation — follow the format
Where rotation may go depends on the project's format. The tools read it from the open project
(`get_project_info` → `rules`) and refuse a rotation the format can't export, with the reason.

| Format | Group / bone rotation | Cube rotation | Coordinates |
|---|---|---|---|
| **GeckoLib / Bedrock** (entities, animated items and weapons, armor) | any axes | any axes — static only; anything that **animates** needs its own bone (rule 6) | no hard limit |
| **Java block/item** (blocks, static items, vanilla-style weapons), Minecraft **1.9–1.21.5** — incl. **1.20.1** | **not exported** — rotate the cube instead | **one axis**, only **-45 / -22.5 / 0 / 22.5 / 45°** | **-16..32** |
| Java block/item, Minecraft 1.21.6–1.21.10 | not exported | one axis, any angle | -16..32 |
| Java block/item, Minecraft 1.21.11 and newer | not exported | any axes | -16..32 |
| Unknown formats | one axis per group; nest groups for more | not allowed | — |

Measured on Blockbench 5.2.1 (2026-09-23) by exporting a cube rotated `[10, 30, 0]`: for 1.9–1.21.5
the exporter kept only `angle: 0, axis: x` (snapped, Y dropped), for 1.21.6 `angle: 10, axis: x`, for
1.21.11+ `{x: 10, y: 30}`. A group's rotation never reaches the vanilla file, and 60° became 67.5° —
which Minecraft 1.20.1 refuses to load. A new Java project targets Minecraft 1.20.1 unless
`create_project` gets another `minecraft_version` (`set_project` can change it).

- **Pivot/origin must be defined explicitly BEFORE applying any rotation.** Wrong pivots
  cause animation drift, orbiting, or large visual offsets. A cube's default pivot is its `from`
  corner — for a centred tilt set its origin to the centre (`set_origin` / `modify_cube origin`).
- Nesting single-axis groups is still a valid way to build up a rotation (and the only one in
  unknown formats), but GeckoLib does not require it.
- Tool contract: `set_rotation` takes a group or a cube; `create_cube(s)`, `create_group` and
  `modify_cube(s)` accept `rotation`; all of them check it against the table above.

## 2. Texture & UV
- A texture cannot be applied unless the texture asset **already exists, is registered,
  and the target element is present** in the model state. Sequence:
  1. Create the geometry.
  2. Register/load the texture asset.
  3. Apply the texture reference to faces / UV.
- UV: Box UV / auto-mapping for simple Minecraft blocks & items; per-face UV for complex
  GeckoLib models. Keep all UVs within the texture resolution bounds (16/32/64…).
- Do **not**: reference unloaded textures; apply UVs before the element exists; assume a
  texture index/UUID/path without confirming it is registered.

## 3. Execution & stability
- Execute in logical, **atomic** batches. Order: **geometry → group → pivot → texture →
  animate.**
- Do not texture/rename/animate an element in the same async step as its creation unless
  the creation has fully resolved. Never assume a state change completed unless the MCP
  response confirms success.
- If a command depends on prior state, confirm that state exists first.

## 4. Naming
- Always unique, descriptive, **stable** names, meaningful for GeckoLib binding & Java.
- Good: `staff_handle`, `floating_core`, `top_blade`, `gem_holder`, `lower_rune_ring`.
- Avoid: generic `Cube`, `Group`, `Bone`, `Part1`; reusing names across components.
- Tool contract: names must be **unique across all cubes and groups**; duplicates are
  rejected. (Generic-vs-descriptive is an AI behavioral rule.)

## 5. Spatial & structural safety
- Keep elements within reasonable coordinate ranges; keep standard models centered/aligned
  with the expected origin space.
- Extend outside normal bounds only intentionally, when the design needs it.
- Avoid accidental offsets that make the model impossible to animate or export cleanly.
- Tool contract: `from`/`to` must be 3 finite numbers; corners are normalized to min/max so
  the box is never inverted/degenerate. In Java block/item projects every coordinate must stay
  inside -16..32 (the game refuses the model otherwise) — checked on create/modify and by
  `validate_model`.

## 6. Animation compatibility
- Build the hierarchy with the final animation plan in mind.
- Any bone that rotates independently lives in its **own** group. Do not merge parts that
  must animate separately. Preserve a clean parent→child structure so GeckoLib can target
  the intended bones unambiguously.

## 7. Failure handling
- If an action is unsafe/impossible/unsupported: do not fabricate a result, do not silently
  break intent. Explain the limitation and offer the correct workaround (nested groups,
  pivots, sequential state updates).

## 8. Pre-flight checklist (before generating/modifying a model)
Verify:
- [ ] The target part exists.
- [ ] The required texture exists and is registered.
- [ ] The pivot is defined.
- [ ] The rotation fits the format (`get_project_info` → `rules`): bones in GeckoLib, cubes in Java block/item.
- [ ] The hierarchy supports the intended animation.

---

## Tool roadmap (how each rule maps to MCP tools)
| Need | Tool | Enforces |
|---|---|---|
| Create cube | `create_cube` (done) | rules 1, 4, 5 (unique name, valid geometry, format-checked rotation and coordinates) |
| Bone/group + pivot + rotation | `create_group`, `set_origin`, `set_rotation` | rules 1, 6 |
| Inspect state before acting | `get_project_info`, `list_outliner` | rules 3, 8 |
| Textures | `register_texture`, `apply_texture`/`set_uv` | rule 2 |

Pivot-first, state-safe, unique-named, format-aware rotation — every new tool must follow
this file.
