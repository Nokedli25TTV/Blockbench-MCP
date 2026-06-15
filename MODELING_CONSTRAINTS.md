# Modeling Constraints — Minecraft Java / GeckoLib / Blockbench

**These are HARD RULES, not suggestions.** They govern (a) how the AI drives this MCP
server as a 3D modeler, and (b) how new MCP tools are written. If a requested operation
conflicts with a rule, do **not** guess or silently change intent — fail with a clear
explanation and propose the engine-compatible workaround (rule 7).

The MCP tools enforce the machine-checkable parts of these rules and return a structured
error (`{ ok: false, error }`) instead of fabricating success.

---

## 1. Geometry & rotation — the single-axis rule
- A single cube/element **cannot** be freely rotated on multiple axes the way a generic 3D
  engine can. Multi-axis orientation **must** use nested groups/bones.
- Required approach for multi-axis rotation:
  1. Parent group A → apply axis 1 rotation.
  2. Child group B inside A → apply axis 2 rotation.
  3. (If a 3rd axis is needed) a further child group → axis 3.
  4. Place the cube in the **deepest** child group.
- **Never** apply a direct rotation like `[45, 15, 0]` to a single cube.
- **Pivot/origin must be defined explicitly BEFORE applying any rotation.** Wrong pivots
  cause animation drift, orbiting, or large visual offsets.
- Tool contract: `create_cube` does **not** accept a rotation. Rotation is a group-only
  operation (`create_group` / `set_rotation` on a group). Single-cube rotation is rejected.

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
  the box is never inverted/degenerate.

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
- [ ] The rotation strategy is engine-compatible (groups, not single-cube multi-axis).
- [ ] The hierarchy supports the intended animation.

---

## Tool roadmap (how each rule maps to MCP tools)
| Need | Tool | Enforces |
|---|---|---|
| Create cube | `create_cube` (done) | rules 4, 5 (unique name, valid geometry, no rotation) |
| Bone/group + pivot + rotation | `create_group`, `set_origin`, `set_rotation` | rules 1, 6 |
| Inspect state before acting | `get_project_info`, `list_outliner` | rules 3, 8 |
| Textures | `register_texture`, `apply_texture`/`set_uv` | rule 2 |

Pivot-first, state-safe, unique-named, single-axis-via-groups — every new tool must follow
this file.
