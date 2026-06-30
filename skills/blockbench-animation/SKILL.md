---
name: blockbench-animation
description: Create and manage animations in Blockbench using MCP tools. Use when animating 3D models, creating keyframes, managing bone rigs, editing animation curves, or working with animation timelines. Covers walk cycles, idle animations, combat animations, and complex multi-bone animations.
---

# Blockbench Animation

Create animations for 3D models using Blockbench MCP tools.

## ⚠ Workflow & gotchas (read first — these cost whole sessions otherwise)
- **Verify by read-back, never by eye.** After EVERY `manage_keyframes` / `animation_copy_paste`,
  call **`get_keyframes`** (it returns the values ACTUALLY stored). `manage_keyframes` also echoes
  the stored values in its ack. Catches silent write failures in round 1, not round 5.
- **Calibrate rotation direction ONCE, up front.** Don't guess "forward/back" from a camera angle —
  set a known +X on a bone, call **`get_bone_pose`** to read its world-space rotation (a number),
  note "for this rig +X = forward/back", then never guess again. **Sign conventions can differ
  between the Blockbench UI display and the exported GeckoLib/Bedrock JSON** — a rotation can read one
  way in the editor and the opposite in-game. Trust the calibrated `get_bone_pose` number, not the
  viewport, and don't hard-code an assumed sign flip.
- **Check ground-clipping by NUMBER, not by eye.** `get_bone_pose` with a `time` also returns
  `world_position` (the bone's animated pivot) and `world_bbox.lowest_y` (the lowest point of the
  bone + its cubes at that moment). Read `lowest_y` at the key times to see if the model dips below
  the floor — calibrate the floor once against a bone you know rests on the ground. To VERIFY a pose
  visually, call `capture_screenshot` with a `time`: it evaluates that frame before rendering,
  otherwise the screenshot can show the rest pose instead of the animated one.
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
| `manage_keyframes` | Create/edit/delete keyframes per bone and channel (echoes stored values) |
| `get_keyframes` | **Read back the actually-stored keyframe values** (verify writes) |
| `get_bone_pose` | **Measure a bone's local + world rotation, world position & bbox** (calibrate direction / check ground-clipping by number) |
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
