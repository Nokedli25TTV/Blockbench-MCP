export type ToolType =
  | "hello_world"
  | "create_cube"
  | "create_cubes"
  | "create_group"
  | "set_origin"
  | "set_rotation"
  | "get_scene_tree"
  | "register_texture"
  | "apply_texture"
  | "create_animation"
  | "manage_keyframes"
  | "animation_graph_editor"
  | "animation_timeline"
  | "batch_keyframe_operations"
  | "animation_copy_paste"
  | "list_animations"
  | "get_keyframes"
  | "get_bone_pose"
  | "modify_cube"
  | "delete_element"
  | "reparent_element"
  | "list_export_formats"
  | "export_model"
  | "export_animations"
  | "get_project_info"
  | "set_project"
  | "create_texture"
  | "list_textures"
  | "get_texture"
  | "activate_texture"
  | "add_texture_group"
  | "set_mesh_uv"
  | "auto_uv_mesh"
  | "rotate_mesh_uv"
  | "capture_screenshot"
  | "capture_app_screenshot"
  | "set_camera_angle"
  | "undo"
  | "redo"
  | "get_undo_stack"
  | "save_checkpoint"
  | "duplicate_element"
  | "rename_element"
  | "find_elements_by_criteria"
  | "select_all_of_type"
  | "filter_by_material"
  | "get_selection"
  | "create_pbr_material"
  | "configure_material"
  | "list_materials"
  | "get_material_info"
  | "import_texture_set"
  | "assign_texture_channel"
  | "save_material_config"
  | "get_face_material_instances"
  | "set_face_material_instance"
  | "list_material_instances"
  | "bulk_set_material_instances"
  | "clear_material_instances"
  | "paint_fill_tool"
  | "draw_shape_tool"
  | "gradient_tool"
  | "color_picker_tool"
  | "place_mesh"
  | "extrude_mesh"
  | "subdivide_mesh"
  | "create_sphere"
  | "select_mesh_elements"
  | "move_mesh_vertices"
  | "delete_mesh_elements"
  | "merge_mesh_vertices"
  | "create_mesh_face"
  | "create_cylinder"
  | "knife_tool"
  | "list_actions"
  | "trigger_action"
  | "risky_eval"
  | "emulate_clicks"
  | "fill_dialog"
  | "from_geo_json"
  | "list_armatures"
  | "get_armature"
  | "add_armature"
  | "remove_armature"
  | "update_armature"
  | "list_armature_bones"
  | "get_armature_bone"
  | "add_armature_bone"
  | "remove_armature_bone"
  | "update_armature_bone"
  | "update_armature_bones_batch"
  | "select_armature_bones"
  | "get_vertex_weights"
  | "set_vertex_weight"
  | "set_vertex_weights_batch"
  | "clear_vertex_weights"
  | "eraser_tool"
  | "copy_brush_tool"
  | "paint_settings"
  | "paint_with_brush"
  | "create_brush_preset"
  | "load_brush_preset"
  | "texture_selection"
  | "texture_layer_management"
  | "paint_pixel_matrix"
  | "pack_uv"
  | "validate_uv"
  | "shade_cube"
  | "list_palettes"
  | "get_palette";

export type Vec3 = [number, number, number];

// --- Tool input shapes ------------------------------------------------------

export type HelloWorldInput = {
  name?: string;
};

export type CreateCubeInput = {
  name?: string;
  from?: Vec3;
  to?: Vec3;
  size?: number;
  origin?: Vec3;
  parent?: string;
};

export type CreateGroupInput = {
  name?: string;
  parent?: string;
  origin?: Vec3;
};

export type SetOriginInput = {
  target?: string;
  origin?: Vec3;
};

export type SetRotationInput = {
  target?: string;
  rotation?: Vec3;
};

export type RegisterTextureInput = {
  name?: string;
  data_url?: string;
  path?: string;
  width?: number;
  height?: number;
};

export type ApplyTextureInput = {
  target?: string;
  texture?: string;
  faces?: string[];
};

export type ToolCommand = {
  tool: ToolType;
  input: Record<string, any>;
};

// --- Scene tree (returned by get_scene_tree, consumed by validate_model) -----

export interface SceneCube {
  type: "cube";
  uuid: string;
  name: string;
  from: Vec3;
  to: Vec3;
  origin: Vec3;
  rotation: Vec3;
  faces: Record<string, { texture: string | null }>;
}

export interface SceneGroup {
  type: "group";
  uuid: string;
  name: string;
  origin: Vec3;
  rotation: Vec3;
  children: SceneNode[];
}

export type SceneNode = SceneCube | SceneGroup;

export interface SceneTexture {
  uuid: string;
  name: string;
}

export interface SceneTree {
  roots: SceneNode[];
  textures: SceneTexture[];
}
