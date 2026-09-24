---
name: blockbench-modeling
description: Create and edit 3D models in Blockbench using MCP tools. Use when building geometry with cubes, creating meshes, placing spheres/cylinders, editing vertices, extruding faces, or organizing models with groups. Covers both cube-based Minecraft modeling and freeform mesh editing.
---

# Blockbench Modeling

Build 3D models using cubes and meshes in Blockbench.

## Available Tools

### Cube & part tools
| Tool | Purpose |
|------|---------|
| `create_cubes` | Build a hierarchy in one call — groups (bones) + cubes, one undo step |
| `create_cube` / `create_group` | One cube / one group |
| `modify_cube` / `modify_cubes` | Edit cubes: from/to, origin, rotation, inflate, UV |
| `place_relative` | Put a part against another (on_top, below, left, right, front, back, inside) with a gap and alignment — no coordinate maths |
| `move_element` | Move a cube or a whole group — everything inside, pivots included — by an offset, or put its pivot at a point |
| `set_origin` | Set a pivot by value, or with `anchor` from the part's own geometry (top = shoulder/hip, bottom, center, a side = hinge) |
| `set_rotation` | Rotate a bone, or a cube where the format allows (`get_project_info` → `rules`) |
| `duplicate_element` | Copy a cube or group; `mirror: "x"` builds the other side (left↔right names swap), `count` + `offset` a row |
| `rename_element` / `reparent_element` / `delete_element` | Organise the outliner |

### Mesh Tools
| Tool | Purpose |
|------|---------|
| `place_mesh` | Create mesh with vertices |
| `create_sphere` | Create sphere mesh |
| `create_cylinder` | Create cylinder mesh |
| `extrude_mesh` | Extrude faces/edges/vertices |
| `subdivide_mesh` | Add geometry detail |
| `select_mesh_elements` | Select vertices/edges/faces |
| `move_mesh_vertices` | Move selected vertices |
| `delete_mesh_elements` | Remove geometry |
| `merge_mesh_vertices` | Weld nearby vertices |
| `create_mesh_face` | Create face from vertices |
| `knife_tool` | Cut edges into faces |

### Inspect
| Tool | Purpose |
|------|---------|
| `get_scene_tree` | The hierarchy (narrow it with `bone_names`, `include_faces:false`, `max_depth`) |
| `find_elements_by_criteria` | Query elements by name pattern, type, parent, size |
| `select_all_of_type` | Bulk-select cubes, meshes, or groups |
| `filter_by_material` | Find elements referencing a texture |

## Cube Modeling

### Build a hierarchy in one call

```
create_cubes: groups=[{name: "body", origin: [0, 12, 0]}, {name: "head", parent: "body", origin: [0, 24, 0]}],
  cubes=[{name: "torso", parent: "body", from: [-4, 12, -2], to: [4, 24, 2]},
         {name: "skull", parent: "head", from: [-4, 0, -4], to: [4, 8, 4]}]
```

### Place parts instead of computing coordinates

```
place_relative: target="head", ref="body", side="on_top"                    # centred on top
place_relative: target="arm_left", ref="body", side="left", align="max"     # beside it, flush with its top
place_relative: target="tail", ref="body", side="back", gap=-1              # sunk 1 unit in
move_element: target="arm_left", offset=[0, -1, 0]                          # nudge a whole part
```

Sides are world axes and the model faces north (−Z): `left` = +X (its own left), `front` = −Z.
Groups move with everything inside and keep their pivots; bounds include rotations. Add
`dry_run: true` to see where it would go first.

### Pivots from the geometry

```
set_origin: target="arm_left", anchor="top"     # shoulder = centre of the arm's top side
set_origin: target="leg_left", anchor="top"     # hip
set_origin: target="lid", anchor="back"         # a hinge along the back side
```

Set pivots before rotating (rule #1).

### Build one side, mirror the other

```
duplicate_element: id="arm_left", mirror="x"                                   # → arm_right, everything inside renamed
duplicate_element: id="spike", count=5, offset=[2, 0, 0], newName="spike_{i}"  # a row of five
```

The mirror copy gets mirrored positions, pivots and rotations (across x = 0; 8 in Java block
models) and mirrored box UV, so a shared texture still reads right.

### Modify a cube

```
modify_cube: id="torso", inflate=0.25
```

## Mesh Modeling

### Create Sphere

```
create_sphere: elements=[{
  name: "ball",
  position: [0, 8, 0],
  diameter: 16,
  sides: 12
}]
```

### Create Cylinder

```
create_cylinder: elements=[{
  name: "pillar",
  position: [0, 0, 0],
  diameter: 8,
  height: 24,
  sides: 12,
  capped: true
}]
```

### Extrude Face

```
select_mesh_elements: mesh_id="pillar", mode="face", elements=["top_face"]
extrude_mesh: mesh_id="pillar", mode="faces", distance=4
```

### Subdivide for Detail

```
subdivide_mesh: mesh_id="sphere", cuts=2
```

### Move Vertices

```
select_mesh_elements: mesh_id="mesh1", mode="vertex", elements=["v1", "v2"]
move_mesh_vertices: offset=[0, 2, 0]
```

### Merge Close Vertices

```
merge_mesh_vertices: mesh_id="mesh1", threshold=0.1
```

### Knife Cut

```
knife_tool: mesh_id="cube_mesh", points=[
  {position: [0, 8, -4]},
  {position: [0, 8, 4]}
]
```

## Organization

```
create_group: name="root", origin=[0, 0, 0]
create_group: name="body", parent="root", origin=[0, 12, 0]
reparent_element: id="head", parent="body"
get_scene_tree: bone_names=["body"], include_faces=false   # check the result
```

## Selection & Filtering

Query the model without loading the full outline. These tools are read-only except `select_all_of_type`.

### Find Elements by Criteria

Combine any of: regex name match, substring match, type, parent-group scope, cube size bounds, selection scope.

```
# All cubes under "body" named like "arm_*"
find_elements_by_criteria: type="cube", parent_group="body", name_pattern="^arm_"

# Small cubes (under 4 units on any axis) in the currently selected elements
find_elements_by_criteria: selected_only=true, max_size=[4, 4, 4]

# Groups whose name contains "hand" (case-insensitive)
find_elements_by_criteria: type="group", name_contains="hand"
```

Returns `{ count, truncated, matches: [{ uuid, name, type, parent }] }`.

### Select All of Type

```
# Replace selection with every cube in the project
select_all_of_type: type="cube"

# Add all meshes under "head" to the current selection
select_all_of_type: type="mesh", parent_group="head", add_to_selection=true
```

### Filter by Material

Find every cube or mesh that references a specific texture. For cubes, the exact face keys are returned.

```
filter_by_material: texture="skin"
# → { texture, count, matches: [{ uuid, name, type: "cube", faces: ["north", "up"] }] }
```

Useful when refactoring textures: find all users before swapping or retiring a texture.

## Common Patterns

### Minecraft Character

```
create_cubes: groups=[
    {name: "root", origin: [0, 0, 0]},
    {name: "body", parent: "root", origin: [0, 24, 0]},
    {name: "head", parent: "body", origin: [0, 24, 0]},
    {name: "arm_left", parent: "body", origin: [5, 22, 0]},
    {name: "leg_left", parent: "root", origin: [2, 12, 0]}],
  cubes=[
    {name: "head_cube", parent: "head", from: [-4, 24, -4], to: [4, 32, 4]},
    {name: "body_cube", parent: "body", from: [-4, 12, -2], to: [4, 24, 2]},
    {name: "arm_left_cube", parent: "arm_left", from: [4, 12, -2], to: [8, 24, 2]},
    {name: "leg_left_cube", parent: "leg_left", from: [0, 0, -2], to: [4, 12, 2]}]
duplicate_element: id="arm_left", mirror="x"   # arm_right: x −8..−4, pivot [−5, 22, 0]
duplicate_element: id="leg_left", mirror="x"   # leg_right
```

### Smooth Organic Shape

```
create_sphere: elements=[{name: "base", position: [0, 8, 0], diameter: 16, sides: 16}]
subdivide_mesh: mesh_id="base", cuts=1
# Select and move vertices to shape
select_mesh_elements: mesh_id="base", mode="vertex"
move_mesh_vertices: offset=[0, 4, 0], vertices=["top_verts"]
```

## Tips

- `get_scene_tree` shows the structure; narrow it with `bone_names` / `max_depth` on big models
- Place parts with `place_relative` / `move_element` instead of computing from/to by hand
- Pivots at the joints: `set_origin` with `anchor`, before rotating (rule #1)
- Build one side, then `duplicate_element mirror:"x"` the other
- Mesh editing is more flexible, but cubes are simpler for Minecraft-style models (and GeckoLib
  renders cubes only)
- Before reworking a model, call `save_checkpoint` so you can roll back with `undo`
