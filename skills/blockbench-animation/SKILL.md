---
name: blockbench-animation
description: Create and manage animations in Blockbench using MCP tools. Use when animating 3D models, creating keyframes, managing bone rigs, editing animation curves, or working with animation timelines. Covers walk cycles, idle animations, combat animations, and complex multi-bone animations.
---

# Blockbench Animation

Create animations for 3D models using Blockbench MCP tools.

## ⚠ Workflow & gotchas (read first — these cost whole sessions otherwise)
- **Verify by read-back, never by eye.** `manage_keyframes` and `set_keyframes` reply with the values
  ACTUALLY stored — read that instead of calling anything else. After `create_animation` or
  `animation_copy_paste`, one **`get_keyframes`** (omit `bone_name` to get every animated bone at
  once) confirms what landed. Catches silent write failures in round 1, not round 5.
- **Batch keyframe edits.** Key or fix a whole pose with ONE `set_keyframes` (many bones × channels ×
  times, one undo step, upsert by time); `clear_first:true` rewrites the listed channels.
- **Calibrate rotation direction ONCE, up front.** Don't guess "forward/back" from a camera angle —
  set a known +X on a bone, call **`get_bone_pose`** to read its world-space rotation (a number),
  note "for this rig +X = forward/back", then never guess again. What Blockbench shows is what plays
  in-game — the exporter handles the file's sign convention.
- **Check the whole animation in one call.** `check_animation` (with `floor_y: 0` for entities) samples
  the whole model across the animation and reports the lowest point, when it happens and how much to
  raise the model — plus keyframes past the end, rotation jumps over 90°, loops that pop, and keyframes
  on missing bones. For one bone at one moment, `get_bone_pose {time}` returns `world_rotation`,
  `world_position` and `world_bbox.lowest_y`. Confirm the look with `capture_screenshot {time}` (or
  `set_camera_angle {time}`), which evaluates that frame before rendering.
- **Keyframes ADD to the bone's rest rotation.** A bone set to `[18,0,0]` with `set_rotation` and a
  rotation keyframe of `[4,0,0]` shows 22°. To move a posed bone from 18° to 22°, key `0 → 4 → 0`,
  not `18 → 22 → 18`.
- **One value convention everywhere.** `create_animation`, `set_keyframes`, `manage_keyframes` and
  `get_keyframes` all use the values Blockbench stores and shows in its keyframe panel. The GeckoLib /
  Bedrock `.animation.json` uses flipped signs (rotation X and Y, position X) — `export_animations`
  converts automatically, so never pre-flip values yourself.
- **`manage_keyframes` edit/delete/select match existing keyframes by time (±0.001 s).** If no
  keyframe sits at that time, nothing changes — the reply now says so and lists the channel's stored
  keyframes, so check it instead of assuming the edit landed.
- **GeckoLib renders CUBES only — no meshes.** Model the whole mob/item from cubes in a
  Bedrock/GeckoLib format from minute one. A mesh model means redo geometry + UVs + texture near
  export. (`validate_model` / `export_model` warn if meshes are present.)
- **Rig hierarchy convention.** Use a clean parent chain (root → body → head → …), NOT every part
  as a separate child of root. If body and head both hang off root, leaning the whole torso means
  rotating root AND counter-rotating the head — error-prone. Prefer one **upper-body control bone**
  that leans the torso in a single move. Document the rig's hierarchy + the calibrated rotation
  direction in a project note so the next session doesn't rediscover it.
- **Neutral pose at the start AND end of every loop and attack**, identical, so GeckoLib blends
  seamlessly between states.
- **Curves:** `linear` for constant spins/orbits; `catmullrom` (smooth) for limb motion. Add
  anticipation before and follow-through after a strike; a touch of overshoot reads as weight.
- **Batch, then verify.** Make all related keyframe edits in one pass, then read back / screenshot
  at a few key poses — not after every tiny step.
- **Avoid `risky_eval` for edits** — it bypasses clean Undo (you can lose geometry). Use the real
  tools, which wrap `Undo.initEdit/finishEdit`.

## Available Tools

| Tool | Purpose |
|------|---------|
| `create_animation` | Create animation with keyframes for bones |
| `set_keyframes` | **Batch**: many bones × channels × times in one call (upsert, echoes stored values) |
| `manage_keyframes` | Create/edit/delete keyframes per bone and channel (echoes stored values) |
| `get_keyframes` | **Read back the actually-stored keyframe values** — one, several or all bones |
| `check_animation` | **Lint the animation**: past-the-end keys, >90° jumps, loop pops, missing bones, floor dips (`floor_y`) |
| `get_bone_pose` | **Measure a bone's local + world rotation, world position & bbox** (calibrate direction by number) |
| `manage_animation` | Delete / rename / duplicate a whole animation |
| `animation_graph_editor` | Fine-tune animation curves (smooth, linear, ease) |
| `animation_timeline` | Control playback, time, FPS, loop settings |
| `batch_keyframe_operations` | Batch operations: offset, scale, reverse, mirror |
| `animation_copy_paste` | Copy animation data between bones/animations |

## Quick Start

### Create a Simple Animation

```
1. create_animation: name="walk", animation_length=1.0, loop=true
2. manage_keyframes: bone_name="leg_left", channel="rotation",
   keyframes=[{time: 0, values: [30, 0, 0]}, {time: 0.5, values: [-30, 0, 0]}]
3. animation_timeline: action="play"
```

### Animation Channels

- `position` - [x, y, z] offset
- `rotation` - [x, y, z] degrees
- `scale` - [x, y, z] or uniform number

### Interpolation Types

- `linear` - Constant rate
- `catmullrom` - Smooth spline
- `bezier` - Custom curves
- `step` - Instant change

## Common Workflows

### Walk Cycle (1 second)

```
create_animation: name="walk", animation_length=1.0, loop=true, bones={
  "leg_left": [
    {time: 0, rotation: [30, 0, 0]},
    {time: 0.5, rotation: [-30, 0, 0]},
    {time: 1.0, rotation: [30, 0, 0]}
  ],
  "leg_right": [
    {time: 0, rotation: [-30, 0, 0]},
    {time: 0.5, rotation: [30, 0, 0]},
    {time: 1.0, rotation: [-30, 0, 0]}
  ]
}
```

### Smooth Curves

```
animation_graph_editor: bone_name="arm", channel="rotation", action="smooth"
```

### Copy Animation to Mirrored Bone

```
animation_copy_paste: action="copy", source={bone: "arm_left"}
animation_copy_paste: action="mirror_paste", target={bone: "arm_right", mirror_axis: "x"}
```

### Batch Timing Adjustment

```
batch_keyframe_operations: operation="scale", selection="all",
  parameters={scale_factor: 2.0}  # Double animation duration
```

## Bone Rigging

### Create Bone Structure

```
bone_rigging: action="create", bone_data={name: "spine", origin: [0, 12, 0]}
bone_rigging: action="create", bone_data={name: "head", origin: [0, 24, 0], parent: "spine"}
```

### Set Pivot Point

```
bone_rigging: action="set_pivot", bone_data={name: "arm_left", origin: [4, 22, 0]}
```

## Timeline Control

```
animation_timeline: action="set_fps", fps=60
animation_timeline: action="set_length", length=2.5
animation_timeline: action="loop", loop_mode="loop"  # or "once", "hold"
animation_timeline: action="set_time", time=0.5
animation_timeline: action="play"
```

## Tips

- Use `list_outline` to see available bones before animating
- Set up bone hierarchy first with `bone_rigging` before adding keyframes
- Use `catmullrom` interpolation for organic movement
- Use `step` interpolation for mechanical/robotic movement
- Mirror animations for symmetrical rigs to save time
