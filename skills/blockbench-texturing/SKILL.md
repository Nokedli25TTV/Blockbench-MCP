---
name: blockbench-texturing
description: Create and paint textures in Blockbench using MCP tools. Use when creating textures, painting on models, using brush tools, filling colors, drawing shapes, applying gradients, managing texture layers, or working with UV mapping. Covers pixel art texturing, procedural painting, and UV manipulation.
---

# Blockbench Texturing

Create and paint textures for 3D models using Blockbench MCP tools.

## ★ Recommended workflow (read first — do these IN ORDER)
1. **Build the geometry** (cubes/bones). Don't texture yet.
2. **`pack_uv` — DO NOT SKIP.** Gives every cube its own non-overlapping atlas region AND sizes the
   texture to fit the model. Without it, every cube's UV sits at `[0,0]` and overlaps, so any paint
   pass overwrites the others → a garbled texture, and the atlas ends up far bigger than the model
   uses. Run it once, after geometry: `pack_uv` (no args = all cubes).
3. **`validate_uv` — the gate. NEVER paint on an invalid layout.** Confirms `valid: true`
   (overlaps:0, out_of_bounds:0, null:0, zero_size:0). If it reports overlaps, re-run `pack_uv` and
   validate again. This is what stops the AI from "thinking it succeeded" while every cube shares one
   spot. (`get_scene_tree` also now shows each cube's `box_uv`/`autouv`/`uv_offset`.)
4. **`create_texture`** — omit width/height so it uses the fitted size from `pack_uv`. Add
   `layers: true` for non-destructive base/shade/highlight passes.
5. **`apply_texture`** on a cube, mesh, or a whole **group** (textures every descendant in one call).
6. **Texture each part — `shade_cubes` / `shade_cube`.** From your EXACT colour they paint shaded pixel
   art: a 7-shade hue-shifted ramp (your colour in the middle), light from above (top face bright,
   sides a smooth dithered top→bottom gradient, bottom in shade), lit top edges and a contact shadow at
   the bottom, and a **`material`** pattern so neighbouring pixels vary: `generic` (default), `fur`,
   `skin`, `leather`, `cloth`, `wood` (grain along the long axis), `planks`, `stone`, `metal` (specular
   streak), `gem` (facets), `plant`. `detail` (0–2) sets the pattern strength (0 = gradient only),
   `lighting` (0–2) the light/shadow strength. Each cube gets its own seed, so repeated parts don't
   look stamped. Use `target` (a group) to shade all its cubes, `edge_color` for a dark cutting edge,
   `sheen` for a blade highlight, `colors` (3–9 hex, dark → light) for a hand-picked ramp.
   **Texture the whole model in ONE call with `shade_cubes`** — `items=[{cube_id|target, color,
   material?, …}, …]` paints every part in one texture edit and one undo step (all-or-nothing; items
   paint in order). Then add the details that make it a character — eyes, mouth, belts, trims — with
   `paint_pixel_matrix` / `draw_shape_tool` on top (all take real hex). Need manual UV offsets? Set
   them all at once with `modify_cubes cubes=[{id, uv_offset:[u,v]}, …]`.
7. **Verify.** `get_texture` (image) + `capture_screenshot`.

### ⚠ Critical: UV must be packed first (the #1 texturing failure)
By default ALL cubes' UV nets sit at the atlas origin and overlap — so the LAST thing you paint on
that region wins and every other cube shows the wrong pixels. **`pack_uv` is the fix** (step 2). It
works whether the format is box-UV (sets each cube's `uv_offset` + `autouv:0`) or per-face/GeckoLib
(writes the explicit per-face UV rects). A cube `(w,h,d)` needs a footprint of `2·(w+d)` wide ×
`(h+d)` tall. Manual alternative: `modify_cube` with a `uv_offset` (it forces `autouv:0` so the
offset sticks; with `autouv:1` Blockbench re-collapses it to `[0,0]`).

## Available Tools

### Texture Management
| Tool | Purpose |
|------|---------|
| `create_texture` | Create new texture (size, fill color, `layers`) |
| `list_textures` | List all project textures |
| `get_texture` | Get texture image data |
| `apply_texture` | Apply texture to a cube/mesh/group (`apply_mode`: blank/all/none) |
| `pack_uv` | Pack each cube's UV into its own region + fit the texture (run before painting) |
| `validate_uv` | Check UVs (overlap/oob) before painting |
| `shade_cube` | **Shade a cube's faces from ONE exact hex** — dithered gradients, lit edges, a `material` pattern (fur, stone, wood…) |
| `shade_cubes` | **Batch `shade_cube`** — many parts, each its own colour, one call / one undo step |
| `modify_cubes` | Batch cube edits, e.g. every cube's `uv_offset` in one call |

### Paint Tools
| Tool | Purpose |
|------|---------|
| `paint_with_brush` | Paint with customizable brush |
| `paint_fill_tool` | Bucket fill areas |
| `draw_shape_tool` | Draw rectangles/ellipses |
| `gradient_tool` | Apply gradients |
| `eraser_tool` | Erase with brush settings |
| `color_picker_tool` | Pick colors from texture |
| `copy_brush_tool` | Clone/copy texture areas |

### Brush Management
| Tool | Purpose |
|------|---------|
| `create_brush_preset` | Save brush settings |
| `load_brush_preset` | Load saved brush |
| `paint_settings` | Configure paint mode |

### Layers & Selection
| Tool | Purpose |
|------|---------|
| `texture_layer_management` | Manage texture layers |
| `texture_selection` | Create/modify selections |

### UV Tools
| Tool | Purpose |
|------|---------|
| `set_mesh_uv` | Set UV coordinates |
| `auto_uv_mesh` | Auto-generate UVs |
| `rotate_mesh_uv` | Rotate UV mapping |

## Resources

| Resource | URI | Purpose |
|----------|-----|---------|
| textures | `textures://{id}` | List/read texture info |

## Creating Textures

### New Blank Texture

```
create_texture: name="skin", width=64, height=64, fill_color="#808080"
```

### Texture with Transparency

```
create_texture: name="overlay", width=32, height=32, fill_color=[0, 0, 0, 0]
```

### Apply to Element

```
apply_texture: target="body", texture="skin", apply_mode="all"   # blank (default) | all | none
# target can be a cube, a mesh, or a GROUP (textures every descendant in one call)
```

### Pack UVs + fit the texture (do this BEFORE painting)

```
pack_uv: {}            # every cube gets its own atlas region; texture sized to fit the model
validate_uv: {}        # confirm valid (overlaps:0) before painting
```

## Painting

### Basic Brush Stroke

```
paint_with_brush: texture_id="skin", coordinates=[
  {x: 10, y: 10},
  {x: 15, y: 12},
  {x: 20, y: 10}
], brush_settings={color: "#FF0000", size: 3, shape: "circle"}
```

### Soft Brush

```
paint_with_brush: texture_id="skin", coordinates=[{x: 32, y: 32}],
  brush_settings={color: "#FFFFFF", size: 10, softness: 50, opacity: 128}
```

### Fill Area

```
paint_fill_tool: texture_id="skin", x=16, y=16, color="#3366FF",
  fill_mode="color_connected", tolerance=10
```

### Fill Entire Face

```
paint_fill_tool: texture_id="skin", x=0, y=0, color="#228B22",
  fill_mode="face"
```

## Shapes & Gradients

### Draw Rectangle

```
draw_shape_tool: texture_id="skin", shape="rectangle",
  start={x: 0, y: 0}, end={x: 16, y: 16}, color="#FFCC00"
```

### Draw Hollow Ellipse

```
draw_shape_tool: texture_id="skin", shape="ellipse_h",
  start={x: 8, y: 8}, end={x: 24, y: 24}, color="#000000", line_width=2
```

### Apply Gradient

```
gradient_tool: texture_id="skin",
  start={x: 0, y: 0}, end={x: 0, y: 32},
  start_color="#87CEEB", end_color="#1E90FF"
```

## Erasing

```
eraser_tool: texture_id="skin", coordinates=[{x: 10, y: 10}, {x: 12, y: 12}],
  brush_size=5, shape="circle", opacity=255
```

## Color Picking

```
color_picker_tool: texture_id="skin", x=16, y=16
# Returns picked color, sets as active
```

## Clone/Copy Brush

```
copy_brush_tool: texture_id="skin",
  source={x: 0, y: 0}, target={x: 32, y: 0},
  brush_size=8, mode="copy"
```

## Brush Presets

### Create Preset

```
create_brush_preset: name="soft_round", size=8, shape="circle",
  softness=30, opacity=200, color="#FFFFFF"
```

### Load Preset

```
load_brush_preset: preset_name="soft_round"
```

## Texture Layers

### Create Layer

```
texture_layer_management: texture_id="skin", action="create_layer",
  layer_name="details"
```

### Set Layer Opacity

```
texture_layer_management: texture_id="skin", action="set_opacity",
  layer_name="details", opacity=75
```

### Merge Down

```
texture_layer_management: texture_id="skin", action="merge_down",
  layer_name="details"
```

## Selections

### Rectangle Selection

```
texture_selection: texture_id="skin", action="select_rectangle",
  coordinates={x1: 0, y1: 0, x2: 16, y2: 16}
```

### Add to Selection

```
texture_selection: texture_id="skin", action="select_ellipse",
  coordinates={x1: 8, y1: 8, x2: 24, y2: 24}, mode="add"
```

### Invert Selection

```
texture_selection: texture_id="skin", action="invert_selection"
```

### Feather Edges

```
texture_selection: texture_id="skin", action="feather_selection", radius=2
```

## UV Mapping

### Auto UV for Mesh

```
auto_uv_mesh: mesh_id="sphere", mode="project"  # project, unwrap, cylinder, sphere
```

### Set Custom UV

```
set_mesh_uv: mesh_id="cube", face_key="north",
  uv_mapping={"v1": [0, 0], "v2": [16, 0], "v3": [16, 16], "v4": [0, 16]}
```

### Rotate UV

```
rotate_mesh_uv: mesh_id="cube", angle="90"
```

## Paint Settings

```
paint_settings: pixel_perfect=true, mirror_painting={enabled: true, axis: ["x"]},
  lock_alpha=true
```

## Common Workflows

### Skin Texture

```
# Create texture
create_texture: name="player_skin", width=64, height=64, fill_color="#C4A484"

# Base colors
paint_fill_tool: x=8, y=8, color="#C4A484", fill_mode="face"  # Face
paint_fill_tool: x=20, y=20, color="#3366CC", fill_mode="face"  # Body

# Details with brush
paint_with_brush: coordinates=[{x: 10, y: 10}, {x: 12, y: 10}],
  brush_settings={color: "#000000", size: 1}  # Eyes

# Apply
apply_texture: id="head", texture="player_skin"
```

### Procedural Pattern

```
# Create base
create_texture: name="pattern", width=32, height=32, fill_color="#FFFFFF"

# Draw grid
draw_shape_tool: shape="rectangle_h", start={x: 0, y: 0}, end={x: 32, y: 32},
  color="#CCCCCC", line_width=1
draw_shape_tool: shape="rectangle_h", start={x: 8, y: 8}, end={x: 24, y: 24},
  color="#999999", line_width=1
```

## Tips

- Use `pixel_perfect=true` in paint_settings for clean pixel art
- Enable `mirror_painting` for symmetrical textures
- Use layers for non-destructive editing
- `lock_alpha` prevents painting outside existing pixels
- Use `fill_mode="color_connected"` to fill only touching same-color pixels
- Create brush presets for frequently used settings
