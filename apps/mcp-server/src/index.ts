import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server as IOServer, Socket } from "socket.io";
import { createServer } from "http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolType, SceneTree } from "../../../packages/shared/src/types";
import { validateScene, buildReport } from "../../../packages/shared/src/validation";
import { PALETTES, PALETTE_NAMES, PALETTE_INDEX_ROLES, getPalette } from "../../../packages/shared/src/palettes";
import { loadSkills, buildInstructions, getSkillContent } from "./skills";

// The Blockbench plugin connects to 9999 by default; tests override this with
// MCP_BRIDGE_PORT so they run on an isolated port and never hijack (or get
// hijacked by) a real Blockbench instance listening on 9999.
const PORT = Number(process.env.MCP_BRIDGE_PORT) || 9999;

// IMPORTANT: when running as an MCP server over stdio, stdout is reserved for
// the JSON-RPC protocol. ALL logging must go to stderr or it corrupts the stream.
const log = (...args: any[]) => console.error("[MCP]", ...args);

// ---------------------------------------------------------------------------
// Socket.IO bridge toward the Blockbench plugin
// ---------------------------------------------------------------------------
const httpServer = createServer();
const io = new IOServer(httpServer, { cors: { origin: "*" } });

let blockbench: Socket | null = null;

io.on("connection", (socket) => {
  log("Blockbench plugin connected:", socket.id);
  blockbench = socket;
  socket.on("client_ready", () => log("Blockbench plugin is ready"));
  socket.on("disconnect", () => {
    log("Blockbench plugin disconnected:", socket.id);
    if (blockbench === socket) blockbench = null;
  });
});

httpServer.listen(PORT, () => {
  log(`Socket.IO bridge listening on http://localhost:${PORT}`);
});

/** Send a command to the Blockbench plugin and await its ack (result object). */
function sendToBlockbench(tool: ToolType, input: Record<string, any>, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!blockbench || blockbench.disconnected) {
      reject(
        new Error(
          "Blockbench is not connected. Open Blockbench, enable the MCP plugin, and make sure a model is open."
        )
      );
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out waiting for a response from Blockbench."));
    }, timeoutMs);
    blockbench.emit("tool_command", { tool, input }, (response: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// Helpers to turn a plugin ack into an MCP tool result.
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
// Turn a data: URL into MCP image content (falls back to text if not a data URL).
const image = (dataUrl: string) => {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  return m
    ? { content: [{ type: "image" as const, data: m[2], mimeType: m[1] }] }
    : ok(dataUrl || "(no image data)");
};

/** Forward a tool to the plugin and format the ack with a success-message builder. */
async function forward(
  tool: ToolType,
  args: Record<string, any>,
  onSuccess: (r: any) => string
) {
  let r: any;
  try {
    r = await sendToBlockbench(tool, args);
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
  if (r && r.ok === false) return fail(`${tool} failed: ${r.error}`);
  return ok(onSuccess(r || {}));
}

/** Forward a tool that returns an image (data URL in r.data_url) and return MCP image content. */
async function forwardImage(tool: ToolType, args: Record<string, any>) {
  let r: any;
  try {
    r = await sendToBlockbench(tool, args);
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
  if (r && r.ok === false) return fail(`${tool} failed: ${r.error}`);
  return image(r.data_url);
}

/** Forward a tool that returns either an image (r.data_url) or text (onText). */
async function forwardImageOrText(tool: ToolType, args: Record<string, any>, onText: (r: any) => string) {
  let r: any;
  try {
    r = await sendToBlockbench(tool, args);
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
  if (r && r.ok === false) return fail(`${tool} failed: ${r.error}`);
  return r.data_url ? image(r.data_url) : ok(onText(r));
}

const vec3 = z.array(z.number()).length(3);

// ---------------------------------------------------------------------------
// MCP server (stdio) toward Claude
// ---------------------------------------------------------------------------
// Load bundled skill guides and inject their index into the server instructions,
// so every client sees them at startup (initialize) and is told to consult them.
const skills = loadSkills();
const instructions = buildInstructions(skills);

const server = new McpServer(
  { name: "blockbench-mcp", version: "0.2.0" },
  instructions ? { instructions } : undefined
);

server.registerTool(
  "create_cube",
  {
    title: "Create Cube",
    description:
      "Create a cuboid in the open Blockbench model. Units are model units (16 = 1 block). " +
      "CONSTRAINTS (MODELING_CONSTRAINTS.md): a cube CANNOT be rotated here — multi-axis " +
      "rotation must use nested groups/bones. Names must be UNIQUE and descriptive.",
    inputSchema: {
      name: z.string().optional().describe("Unique, descriptive outliner name, e.g. 'staff_handle'."),
      from: vec3.optional().describe("Lower corner [x,y,z]. Default [0,0,0]."),
      to: vec3.optional().describe("Upper corner [x,y,z]. If omitted, derived from 'from' + 'size'."),
      size: z.number().optional().describe("Edge length when 'to' is omitted. Default 8."),
      origin: vec3.optional().describe("Pivot [x,y,z]. Default 'from'."),
      parent: z.string().optional().describe("Name of a group/bone to nest this cube under (rule #6)."),
    },
  },
  async (args) => forward("create_cube", args, (r) => `Created cube "${r.name ?? args.name ?? "cube"}".`)
);

server.registerTool(
  "create_group",
  {
    title: "Create Group / Bone",
    description:
      "Create a named group (GeckoLib bone). Optionally nest under an existing parent group by name. " +
      "Use one group per independently-rotating part; for multi-axis rotation, nest groups (rule #1/#6). " +
      "Names must be unique.",
    inputSchema: {
      name: z.string().describe("Unique, descriptive bone name, e.g. 'crystal_x'."),
      parent: z.string().optional().describe("Name of an existing parent group to nest under."),
      origin: vec3.optional().describe("Pivot/origin [x,y,z] for this bone (define before rotating)."),
    },
  },
  async (args) =>
    forward("create_group", args, (r) =>
      `Created group "${r.name}"${r.parent ? ` under "${r.parent}"` : " at root"}.`
    )
);

server.registerTool(
  "set_origin",
  {
    title: "Set Group Origin (Pivot)",
    description:
      "Set the pivot/origin of a GROUP (bone). Define the pivot BEFORE applying rotation (rule #1). " +
      "Targets groups only.",
    inputSchema: {
      target: z.string().describe("Name of the group whose pivot to set."),
      origin: vec3.describe("Pivot point [x,y,z]."),
    },
  },
  async (args) =>
    forward("set_origin", args, (r) => `Set origin of "${r.name}" to [${(r.origin || []).join(", ")}].`)
);

server.registerTool(
  "set_rotation",
  {
    title: "Set Group Rotation",
    description:
      "Rotate a GROUP (bone). Rejects cube targets — a single cube cannot be rotated (rule #1). " +
      "Enforces ONE axis per group: nest groups for multi-axis rotation. Set the pivot first.",
    inputSchema: {
      target: z.string().describe("Name of the group to rotate."),
      rotation: vec3.describe("Euler degrees [x,y,z] with at most ONE non-zero axis."),
    },
  },
  async (args) =>
    forward("set_rotation", args, (r) =>
      `Rotated "${r.name}" to [${(r.rotation || []).join(", ")}].${r.warning ? " Note: " + r.warning : ""}`
    )
);

server.registerTool(
  "get_scene_tree",
  {
    title: "Get Scene Tree",
    description:
      "Return the current outliner hierarchy (groups + cubes, with origins, rotations, faces) and the " +
      "registered textures, as JSON. Use before acting to verify state (rule #3/#8).",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("get_scene_tree", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_scene_tree failed: ${r.error}`);
    return ok(JSON.stringify(r.tree, null, 2));
  }
);

server.registerTool(
  "register_texture",
  {
    title: "Register Texture",
    description:
      "Load/register a texture asset into the project so it can be applied later (rule #2). " +
      "Provide 'data_url' or 'path' for an image, or width/height for a blank texture. Returns its id.",
    inputSchema: {
      name: z.string().describe("Unique texture name."),
      data_url: z.string().optional().describe("data: URL of a PNG image."),
      path: z.string().optional().describe("Absolute filesystem path to an image."),
      width: z.number().optional().describe("Blank texture width (default 16)."),
      height: z.number().optional().describe("Blank texture height (default 16)."),
    },
  },
  async (args) =>
    forward("register_texture", args, (r) => `Registered texture "${r.name}" (id ${r.id}).`)
);

server.registerTool(
  "apply_texture",
  {
    title: "Apply Texture",
    description:
      "Apply an already-registered texture to an existing cube, OR to a GROUP (textures all its descendant " +
      "cubes in one call). Fails if the texture is not registered or the target doesn't exist (rule #2). " +
      "Optionally limit to specific faces.",
    inputSchema: {
      target: z.string().describe("Cube name, or a group name to texture all its descendant cubes."),
      texture: z.string().describe("Registered texture name or id."),
      faces: z
        .array(z.string())
        .optional()
        .describe("Face keys (north/south/east/west/up/down). Omit for all faces."),
    },
  },
  async (args) =>
    forward("apply_texture", args, (r) => `Applied texture "${r.texture}" to ${r.cubes ?? 1} cube(s) (${r.target}).`)
);

server.registerTool(
  "validate_model",
  {
    title: "Validate Model",
    description:
      "Validate the current model against the GeckoLib-safety rules: duplicate names, missing pivots, " +
      "invalid geometry, illegal (multi-axis) cube rotations, missing textures, and orphaned groups. " +
      "Returns a pass/fail report. Run before exporting or animating (rule #8).",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("get_scene_tree", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`validate_model could not read the scene: ${r.error}`);

    const tree = r.tree as SceneTree;
    const report = buildReport(validateScene(tree));

    const lines: string[] = [];
    lines.push(
      `Validation ${report.ok ? "PASSED ✅" : "FAILED ❌"} — ${report.errors.length} error(s), ${report.warnings.length} warning(s).`
    );
    for (const issue of report.issues) {
      const tag = issue.severity === "error" ? "ERROR" : "warn ";
      lines.push(`  [${tag}] (${issue.rule}) ${issue.message}`);
    }
    if (report.issues.length === 0) lines.push("  No issues found.");

    return {
      isError: !report.ok,
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// ---------------------------------------------------------------------------
// Animation tools (ported from upstream jasonjgardner blockbench-mcp).
// Schemas reused from their lib/zodObjects.ts; execution happens in the plugin.
// ---------------------------------------------------------------------------
const interpolationEnum = z.enum(["linear", "catmullrom", "bezier", "step"]);
const axisEnum = z.enum(["x", "y", "z"]);
const axisWithAllEnum = z.enum(["x", "y", "z", "all"]);
const animationChannelEnum = z.enum(["rotation", "position", "scale"]);
const loopModeEnum = z.enum(["once", "loop", "hold"]);
const timeRangeSchema = z.object({
  start: z.number().describe("Start time in seconds."),
  end: z.number().describe("End time in seconds."),
});
const keyframeDataSchema = z.object({
  time: z.number().describe("Time in seconds for the keyframe."),
  values: z
    .union([vec3, z.number()])
    .optional()
    .describe("Values: [x,y,z] for position/rotation, number for uniform scale."),
  interpolation: interpolationEnum.optional().describe("Interpolation type. Default linear."),
  bezier_handles: z
    .object({
      left_time: z.number().optional(),
      left_value: z.union([vec3, z.number()]).optional(),
      right_time: z.number().optional(),
      right_value: z.union([vec3, z.number()]).optional(),
    })
    .optional()
    .describe("Bezier handle positions for bezier interpolation."),
});
const animationIdOptional = z
  .string()
  .optional()
  .describe("Animation UUID or name. If not provided, uses the selected animation.");

server.registerTool(
  "create_animation",
  {
    title: "Create Animation",
    description:
      "Create a new named animation with keyframes for bones (GeckoLib/Bedrock style). " +
      "Each bone key must be an EXISTING group name (verify with get_scene_tree first — rule #3/#8). " +
      "Keyframe times are in seconds; rotation in degrees; multi-axis keyframe values are fine for " +
      "animations (the single-axis rule applies to static model rotation, not keyframes).",
    inputSchema: {
      name: z.string().describe("Animation name (without the 'animation.' prefix). Must be unique."),
      loop: z.boolean().optional().describe("Whether the animation loops. Default false."),
      animation_length: z.number().optional().describe("Length in seconds."),
      bones: z
        .record(
          z.string(),
          z.array(
            z.object({
              time: z.number().describe("Keyframe time in seconds."),
              position: vec3.optional().describe("Position offset [x,y,z]."),
              rotation: vec3.optional().describe("Rotation [x,y,z] in degrees."),
              scale: z.union([vec3, z.number()]).optional().describe("Scale [x,y,z] or uniform number."),
            })
          )
        )
        .describe("Keyframes per bone, keyed by existing group/bone name."),
      particle_effects: z
        .record(z.string(), z.string())
        .optional()
        .describe("Particle effects keyed by timestamp."),
    },
  },
  async (args) =>
    forward(
      "create_animation",
      args,
      (r) =>
        `Created animation "${r.name}" (uuid ${r.uuid}) animating ${r.bones} bone(s). ` +
        (r.selected
          ? "It is now selected and ready for animation_timeline play."
          : "WARNING: it could not be auto-selected — pass animation_id to animation_timeline.")
    )
);

server.registerTool(
  "manage_keyframes",
  {
    title: "Manage Keyframes",
    description:
      "Create, delete, edit, or select keyframes for one bone and channel in an animation. " +
      "The bone group must exist and the animation must exist (or be selected).",
    inputSchema: {
      animation_id: animationIdOptional,
      action: z.enum(["create", "delete", "edit", "select"]).describe("Action to perform."),
      bone_name: z.string().describe("Name of the bone/group."),
      channel: animationChannelEnum.describe("Animation channel."),
      keyframes: z.array(keyframeDataSchema).describe("Keyframe data for the action."),
    },
  },
  async (args) =>
    forward("manage_keyframes", args, (r) => `${r.action}: ${r.affected} keyframe(s) on ${r.bone}.${r.channel}.`)
);

server.registerTool(
  "animation_graph_editor",
  {
    title: "Animation Graph Editor",
    description:
      "Apply easing/curve changes (smooth, linear, ease_in/out, stepped, custom bezier) to existing " +
      "keyframes of one bone+channel, optionally limited to a time range.",
    inputSchema: {
      animation_id: animationIdOptional,
      bone_name: z.string().describe("Name of the bone/group."),
      channel: animationChannelEnum.describe("Animation channel."),
      axis: axisWithAllEnum.optional().describe("Axis to modify. Default all."),
      action: z
        .enum(["smooth", "linear", "ease_in", "ease_out", "ease_in_out", "stepped", "custom"])
        .describe("Curve modification to apply."),
      keyframe_range: timeRangeSchema.optional().describe("Time range; omit for all keyframes."),
      custom_curve: z
        .object({
          control_point_1: z.array(z.number()).length(2).describe("First control point [time, value]."),
          control_point_2: z.array(z.number()).length(2).describe("Second control point [time, value]."),
        })
        .optional()
        .describe("Bezier control points (required for 'custom')."),
    },
  },
  async (args) =>
    forward("animation_graph_editor", args, (r) => `Applied ${r.action} to ${r.affected} keyframe(s) on ${r.bone}.${r.channel}.`)
);

server.registerTool(
  "animation_timeline",
  {
    title: "Animation Timeline",
    description:
      "Control the animation timeline: select an animation, play/pause/stop, set time/length/fps, " +
      "loop mode, or select a keyframe range. Pass animation_id (UUID, full or short name) to select " +
      "that animation before the action; otherwise acts on the currently selected one.",
    inputSchema: {
      animation_id: animationIdOptional,
      action: z
        .enum(["select", "play", "pause", "stop", "set_time", "set_length", "set_fps", "loop", "select_range"])
        .describe("Timeline action. 'select' just selects the animation given by animation_id."),
      time: z.number().optional().describe("Seconds (for set_time)."),
      length: z.number().optional().describe("Seconds (for set_length)."),
      fps: z.number().min(1).max(120).optional().describe("Frames per second (for set_fps)."),
      loop_mode: loopModeEnum.optional().describe("Loop mode (for loop)."),
      range: timeRangeSchema.optional().describe("Time range (for select_range)."),
    },
  },
  async (args) => forward("animation_timeline", args, (r) => r.message || "Timeline updated.")
);

server.registerTool(
  "batch_keyframe_operations",
  {
    title: "Batch Keyframe Operations",
    description:
      "Perform offset/scale/reverse/mirror/smooth/bake on many keyframes of the selected animation at once.",
    inputSchema: {
      selection: z
        .enum(["all", "selected", "range", "pattern"])
        .optional()
        .describe("Which keyframes to operate on. Default selected."),
      range: timeRangeSchema.optional().describe("Time range (for range selection)."),
      pattern: z
        .object({
          interval: z.number().describe("Time interval between keyframes."),
          offset: z.number().optional().describe("Time offset for the pattern."),
        })
        .optional()
        .describe("Pattern-based selection."),
      operation: z
        .enum(["offset", "scale", "reverse", "mirror", "smooth", "bake"])
        .describe("Operation to perform."),
      parameters: z
        .object({
          offset_time: z.number().optional().describe("Time offset to apply."),
          offset_values: vec3.optional().describe("Value offset to apply."),
          scale_factor: z.number().optional().describe("Scale factor."),
          scale_pivot: z.number().optional().describe("Pivot for scaling."),
          mirror_axis: axisEnum.optional().describe("Axis to mirror across."),
          bake_interval: z.number().optional().describe("Interval for baking."),
        })
        .optional()
        .describe("Operation-specific parameters."),
    },
  },
  async (args) =>
    forward("batch_keyframe_operations", args, (r) => `Performed ${r.operation} on ${r.affected} keyframe(s).`)
);

server.registerTool(
  "animation_copy_paste",
  {
    title: "Animation Copy/Paste",
    description:
      "Copy keyframes from one bone (optionally a time range / subset of channels) and paste them to " +
      "another bone or animation, optionally mirrored (e.g. left↔right limbs).",
    inputSchema: {
      action: z.enum(["copy", "paste", "mirror_paste"]).describe("Copy or paste action."),
      source: z
        .object({
          animation: z.string().optional().describe("Source animation name/UUID. Default selected."),
          bone: z.string().describe("Source bone name."),
          channels: z.array(animationChannelEnum).optional().describe("Channels to copy. Default all."),
          time_range: timeRangeSchema.optional().describe("Time range to copy."),
        })
        .optional()
        .describe("Source data (for copy)."),
      target: z
        .object({
          animation: z.string().optional().describe("Target animation name/UUID. Default selected."),
          bone: z.string().describe("Target bone name."),
          time_offset: z.number().optional().describe("Time offset for pasted keyframes."),
          mirror_axis: axisEnum.optional().describe("Mirror axis (for mirror_paste)."),
        })
        .optional()
        .describe("Target data (for paste)."),
    },
  },
  async (args) => forward("animation_copy_paste", args, (r) => r.message || "Done.")
);

server.registerTool(
  "list_animations",
  {
    title: "List Animations",
    description:
      "List all animations in the project with loop/length and per-bone keyframe counts. " +
      "Use to verify animation state before/after edits (rule #3/#8).",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("list_animations", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`list_animations failed: ${r.error}`);
    return ok(JSON.stringify(r.animations, null, 2));
  }
);

// ---------------------------------------------------------------------------
// Editing tools (ported from upstream cubes.ts/element.ts with our guardrails).
// ---------------------------------------------------------------------------
server.registerTool(
  "modify_cube",
  {
    title: "Modify Cube",
    description:
      "Modify an existing cube (resize/move/rename/visibility/inflate/UV settings). " +
      "Rotation is NOT accepted here — rotation is group-only (rule #1); put the cube in a bone and " +
      "rotate that. Corners are normalized so the box is never inverted.",
    inputSchema: {
      id: z.string().describe("Cube name or UUID to modify."),
      name: z.string().optional().describe("New unique name."),
      from: vec3.optional().describe("New lower corner [x,y,z]."),
      to: vec3.optional().describe("New upper corner [x,y,z]."),
      origin: vec3.optional().describe("New pivot [x,y,z]."),
      inflate: z.number().optional().describe("Inflation amount."),
      visibility: z.boolean().optional().describe("Show/hide the cube."),
      shade: z.boolean().optional().describe("Apply shading."),
      autouv: z.enum(["0", "1", "2"]).optional().describe("Auto UV: 0 off, 1 on, 2 relative."),
      mirror_uv: z.boolean().optional().describe("Mirror UVs."),
      uv_offset: z.array(z.number()).length(2).optional().describe("UV offset [u,v]."),
    },
  },
  async (args) =>
    forward("modify_cube", args, (r) => `Modified cube "${r.name}" (from [${r.from}] to [${r.to}]).`)
);

server.registerTool(
  "delete_element",
  {
    title: "Delete Element",
    description:
      "Delete a cube or group (including its children) by name or UUID. Verify with get_scene_tree " +
      "first; deleting a bone removes everything inside it.",
    inputSchema: {
      id: z.string().describe("Name or UUID of the cube/group to delete."),
    },
  },
  async (args) => forward("delete_element", args, (r) => `Deleted ${r.kind} "${r.deleted}".`)
);

server.registerTool(
  "reparent_element",
  {
    title: "Reparent Element",
    description:
      "Move a cube or group under another parent group, or to 'root'. Refuses to move a group into " +
      "its own descendant. Use to restructure the bone hierarchy (rule #6).",
    inputSchema: {
      id: z.string().describe("Name or UUID of the cube/group to move."),
      parent: z.string().describe("Target parent group name, or 'root'."),
    },
  },
  async (args) => forward("reparent_element", args, (r) => `Moved "${r.name}" under "${r.parent}".`)
);

// ---------------------------------------------------------------------------
// Export tools (ported from upstream export.ts). Compile via Blockbench codecs.
// ---------------------------------------------------------------------------
server.registerTool(
  "list_export_formats",
  {
    title: "List Export Formats",
    description:
      "List registered export codecs (id, name, extension, whether they support programmatic compile, " +
      "and which one belongs to the current project format). Use before export_model to pick a codec " +
      "(for GeckoLib, the Bedrock/geo codec).",
    inputSchema: {
      only_current_format: z
        .boolean()
        .optional()
        .describe("If true, only codecs compatible with the current project format."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("list_export_formats", args);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`list_export_formats failed: ${r.error}`);
    return ok(JSON.stringify({ current_format_codec: r.current_format_codec, count: r.count, codecs: r.codecs }, null, 2));
  }
);

server.registerTool(
  "export_model",
  {
    title: "Export Model",
    description:
      "Compile the current project through a codec and return the result (and optionally write it to a " +
      "filesystem path — Blockbench may prompt for fs permission). Omit codec_id to use the format's " +
      "default. Run list_export_formats first. For very large output, set max_content_length (0 = write " +
      "to path only, no inline content). Validate the model first (validate_model).",
    inputSchema: {
      codec_id: z.string().optional().describe("Codec id (e.g. 'bedrock', 'gltf', 'project'). Default: format's codec."),
      options: z.record(z.string(), z.unknown()).optional().describe("Codec-specific export options."),
      path: z.string().optional().describe("Absolute path to write the compiled file to."),
      max_content_length: z
        .number()
        .int()
        .min(0)
        .max(2000000)
        .optional()
        .describe("Max characters of content to return inline. Default 100000; 0 = none."),
    },
  },
  async (args) =>
    forward("export_model", args, (r) => {
      const header =
        `Exported "${r.file_name}" via ${r.codec.id} (${r.byte_length} bytes, ${r.encoding})` +
        (r.wrote_to_path ? `, written to ${r.wrote_to_path}` : "") +
        (r.truncated ? " [content truncated]" : "");
      const warn = r.warning ? `\n⚠️  ${r.warning}` : "";
      return r.content != null ? `${header}${warn}\n\n${r.content}` : `${header}${warn}`;
    })
);

server.registerTool(
  "export_animations",
  {
    title: "Export Animations",
    description:
      "Compile all animations into a single GeckoLib/Bedrock .animation.json (the geometry is exported " +
      "separately with export_model). Optionally write to a filesystem path. GeckoLib needs both the " +
      ".geo.json (export_model bedrock) and this .animation.json.",
    inputSchema: {
      path: z.string().optional().describe("Absolute path to write the .animation.json to."),
      max_content_length: z
        .number()
        .int()
        .min(0)
        .max(2000000)
        .optional()
        .describe("Max characters of content to return inline. Default 100000; 0 = none."),
    },
  },
  async (args) =>
    forward("export_animations", args, (r) => {
      const header =
        `Exported ${r.count} animation(s) (${r.byte_length} bytes)` +
        (r.wrote_to_path ? `, written to ${r.wrote_to_path}` : "") +
        (r.truncated ? " [content truncated]" : "");
      return r.content != null ? `${header}\n\n${r.content}` : header;
    })
);

server.registerTool(
  "get_project_info",
  {
    title: "Get Project Info",
    description:
      "Read-only project orientation: format (id/name/animation_mode), name/uuid, geometry identifier, " +
      "texture resolution, element/animation counts, and top-level groups. Use for a first-look check.",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("get_project_info", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_project_info failed: ${r.error}`);
    return ok(JSON.stringify(r.info, null, 2));
  }
);

server.registerTool(
  "set_project",
  {
    title: "Set Project Metadata",
    description:
      "Set project metadata. model_identifier drives the exported \"geometry.<id>\" name — set it (e.g. " +
      "'staff') BEFORE export_model so GeckoLib gets a real identifier instead of 'geometry.unknown'. " +
      "Can also set the project name and texture resolution.",
    inputSchema: {
      model_identifier: z.string().optional().describe("Geometry identifier, e.g. 'staff' → geometry.staff."),
      name: z.string().optional().describe("Project name."),
      texture_width: z.number().int().min(1).optional().describe("Texture atlas width."),
      texture_height: z.number().int().min(1).optional().describe("Texture atlas height."),
    },
  },
  async (args) =>
    forward("set_project", args, (r) => `Updated ${r.changed.join(", ")}. geometry identifier: ${r.model_identifier ?? "(none)"}.`)
);

// ---------------------------------------------------------------------------
// Texture & UV tools (ported from upstream texture.ts + uv.ts).
// ---------------------------------------------------------------------------
const colorSchema = z
  .union([z.array(z.number()).min(3).max(4), z.string()])
  .describe("RGBA tuple [r,g,b,a] (0-255) or a CSS/hex color string.");

server.registerTool(
  "create_texture",
  {
    title: "Create Texture",
    description:
      "Create a texture: from a data URL or file path (data), a solid fill_color, or blank. Richer than " +
      "register_texture. After creating, apply it with apply_texture (which Box-UV maps the cube). Note: a " +
      "single textured cube's box-UV offset is legitimately [0,0] (atlas origin); use autouv:1 on cubes " +
      "(default for new ones) to auto-distribute offsets when packing many cubes into a detailed atlas.",
    inputSchema: {
      name: z.string().describe("Unique texture name."),
      width: z.number().int().min(1).max(4096).optional().describe("Width (default 16)."),
      height: z.number().int().min(1).max(4096).optional().describe("Height (default 16)."),
      data: z.string().optional().describe("Image data URL or absolute file path."),
      fill_color: colorSchema.optional().describe("Solid fill color (when no data)."),
      group: z.string().optional().describe("Texture group/material uuid."),
    },
  },
  async (args) => forward("create_texture", args, (r) => `Created texture "${r.name}" (${r.width}x${r.height}, id ${r.id}).`)
);

server.registerTool(
  "list_textures",
  {
    title: "List Textures",
    description: "List all textures in the project (name, uuid, id, group, size).",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("list_textures", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`list_textures failed: ${r.error}`);
    return ok(JSON.stringify(r.textures, null, 2));
  }
);

server.registerTool(
  "get_texture",
  {
    title: "Get Texture",
    description: "Return a texture's image (PNG). Omit 'texture' for the default texture.",
    inputSchema: {
      texture: z.string().optional().describe("Texture name/uuid/id. Default: the project's default texture."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("get_texture", args);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_texture failed: ${r.error}`);
    return image(r.data_url);
  }
);

server.registerTool(
  "activate_texture",
  {
    title: "Activate Texture",
    description:
      "Select/activate a texture in the texture panel so subsequent paint operations target it.",
    inputSchema: { texture: z.string().describe("Texture name/uuid/id to activate.") },
  },
  async (args) => forward("activate_texture", args, (r) => `Activated texture "${r.name}".`)
);

server.registerTool(
  "add_texture_group",
  {
    title: "Add Texture Group",
    description: "Create a texture group (PBR material when is_material), optionally adding textures to it.",
    inputSchema: {
      name: z.string().describe("Group name."),
      textures: z.array(z.string()).optional().describe("Texture names/uuids to add to the group."),
      is_material: z.boolean().optional().describe("Whether the group is a PBR material (default true)."),
    },
  },
  async (args) => forward("add_texture_group", args, (r) => `Added texture group "${r.name}" (uuid ${r.uuid}).`)
);

const vec2 = z.array(z.number()).length(2);
server.registerTool(
  "set_mesh_uv",
  {
    title: "Set Mesh UV",
    description: "Set UV coordinates for a mesh face's vertices (mesh elements only — see create_sphere/place_mesh).",
    inputSchema: {
      mesh_id: z.string().describe("Mesh name or uuid."),
      face_key: z.string().describe("Face key on the mesh."),
      uv_mapping: z.record(z.string(), vec2).describe("Per-vertex UV: { vertexKey: [u, v] }."),
    },
  },
  async (args) => forward("set_mesh_uv", args, (r) => `Set UV for face "${r.face}" of mesh "${r.mesh}".`)
);

server.registerTool(
  "auto_uv_mesh",
  {
    title: "Auto UV Mesh",
    description: "Auto-generate UV mapping for mesh faces (project/unwrap/cylinder/sphere).",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid. Default: selected."),
      mode: z.enum(["project", "unwrap", "cylinder", "sphere"]).optional().describe("Mapping mode. Default project."),
      faces: z.array(z.string()).optional().describe("Specific face keys; default selected faces."),
    },
  },
  async (args) => forward("auto_uv_mesh", args, (r) => `Applied ${r.mode} UV to ${r.faces} face(s) of mesh "${r.mesh}".`)
);

server.registerTool(
  "rotate_mesh_uv",
  {
    title: "Rotate Mesh UV",
    description: "Rotate the UV of selected mesh faces by 90/180/270 degrees.",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid. Default: selected."),
      angle: z.enum(["90", "180", "270"]).optional().describe("Rotation angle. Default 90."),
      faces: z.array(z.string()).optional().describe("Specific face keys; default selected faces."),
    },
  },
  async (args) => forward("rotate_mesh_uv", args, (r) => `Rotated UV by ${r.angle}° for ${r.faces} face(s) of mesh "${r.mesh}".`)
);

// ---------------------------------------------------------------------------
// Element utilities (ported from upstream element.ts; list_outline omitted —
// get_scene_tree already covers it).
// ---------------------------------------------------------------------------
const elementTypeEnum = z.enum(["any", "cube", "mesh", "group"]);

server.registerTool(
  "duplicate_element",
  {
    title: "Duplicate Element",
    description:
      "Duplicate a cube, group (recursively), or mesh, offset by a vector. Names get a unique '_copy' " +
      "suffix unless newName is given (rule #4).",
    inputSchema: {
      id: z.string().describe("Name or uuid of the element to duplicate."),
      offset: vec3.optional().describe("Position offset [x,y,z] for the copy. Default [0,0,0]."),
      newName: z.string().optional().describe("Explicit name for the copy."),
    },
  },
  async (args) => forward("duplicate_element", args, (r) => `Duplicated "${r.source}" as "${r.name}".`)
);

server.registerTool(
  "rename_element",
  {
    title: "Rename Element",
    description: "Rename a cube/group/mesh. Rejects a name already used by another element (rule #4).",
    inputSchema: {
      id: z.string().describe("Name or uuid of the element."),
      new_name: z.string().describe("New unique name."),
    },
  },
  async (args) => forward("rename_element", args, (r) => `Renamed to "${r.name}".`)
);

server.registerTool(
  "find_elements_by_criteria",
  {
    title: "Find Elements By Criteria",
    description:
      "Search cubes/meshes/groups by name regex, substring, type, parent group, cube size bounds, or " +
      "selection. Returns matches (uuid/name/type/parent).",
    inputSchema: {
      name_pattern: z.string().optional().describe("Regex matched against names."),
      name_contains: z.string().optional().describe("Case-insensitive substring of the name."),
      type: elementTypeEnum.optional().describe("Filter by element type. Default any."),
      parent_group: z.string().optional().describe("Only elements under this group (name/uuid)."),
      min_size: vec3.optional().describe("Minimum cube size [x,y,z]."),
      max_size: vec3.optional().describe("Maximum cube size [x,y,z]."),
      selected_only: z.boolean().optional().describe("Only currently-selected elements."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max matches. Default 100."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("find_elements_by_criteria", args);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`find_elements_by_criteria failed: ${r.error}`);
    return ok(JSON.stringify({ count: r.count, truncated: r.truncated, matches: r.matches }, null, 2));
  }
);

server.registerTool(
  "select_all_of_type",
  {
    title: "Select All Of Type",
    description: "Select all cubes, meshes, or groups (optionally within a parent group).",
    inputSchema: {
      type: z.enum(["cube", "mesh", "group"]).describe("Type to select."),
      add_to_selection: z.boolean().optional().describe("Add to current selection instead of replacing."),
      parent_group: z.string().optional().describe("Limit to descendants of this group (name/uuid)."),
    },
  },
  async (args) => forward("select_all_of_type", args, (r) => `Selected ${r.selected} ${r.type}(s)${r.parent_group ? ` under "${r.parent_group}"` : ""}.`)
);

server.registerTool(
  "filter_by_material",
  {
    title: "Filter By Material",
    description: "Find all cubes/meshes that use a given texture (optionally listing the matching face keys).",
    inputSchema: {
      texture: z.string().describe("Texture name/uuid/id."),
      include_face_keys: z.boolean().optional().describe("Include the matching face keys per element."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("filter_by_material", args);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`filter_by_material failed: ${r.error}`);
    return ok(JSON.stringify({ texture: r.texture, count: r.count, matches: r.matches }, null, 2));
  }
);

server.registerTool(
  "get_selection",
  {
    title: "Get Selection",
    description: "Return the currently selected cubes/meshes/groups and the active texture.",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("get_selection", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_selection failed: ${r.error}`);
    return ok(JSON.stringify({ counts: r.counts, cubes: r.cubes, meshes: r.meshes, groups: r.groups, active_texture: r.active_texture }, null, 2));
  }
);

// ---------------------------------------------------------------------------
// History tools (ported from upstream history.ts).
// ---------------------------------------------------------------------------
server.registerTool(
  "undo",
  {
    title: "Undo",
    description: "Undo the most recent edit(s) in the current project. Use 'steps' for multiple.",
    inputSchema: { steps: z.number().int().min(1).max(100).optional().describe("Steps to undo. Default 1.") },
  },
  async (args) => forward("undo", args, (r) => `Undid ${r.undone_count} edit(s): ${(r.undone || []).join(", ")}.`)
);

server.registerTool(
  "redo",
  {
    title: "Redo",
    description: "Redo the most recently undone edit(s). Use 'steps' for multiple.",
    inputSchema: { steps: z.number().int().min(1).max(100).optional().describe("Steps to redo. Default 1.") },
  },
  async (args) => forward("redo", args, (r) => `Redid ${r.redone_count} edit(s): ${(r.redone || []).join(", ")}.`)
);

server.registerTool(
  "get_undo_stack",
  {
    title: "Get Undo Stack",
    description:
      "Return the undo/redo history (entries, current index, applied vs undone). Use to find named " +
      "checkpoints and know how many undos return to a state.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max entries (most recent first). Default 50.") },
  },
  async () => {
    let r: any;
    try {
      r = await sendToBlockbench("get_undo_stack", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_undo_stack failed: ${r.error}`);
    return ok(JSON.stringify(r.stack, null, 2));
  }
);

server.registerTool(
  "save_checkpoint",
  {
    title: "Save Checkpoint",
    description:
      "Insert a named marker into the undo history so you can navigate back to this state later " +
      "(find it with get_undo_stack). Recommended before risky multi-step edits. Does not change the model.",
    inputSchema: { name: z.string().min(1).max(120).describe("Descriptive checkpoint name.") },
  },
  async (args) => forward("save_checkpoint", args, (r) => `Saved checkpoint "${r.name}" at index ${r.index}.`)
);

// ---------------------------------------------------------------------------
// Camera & screenshot tools (ported from upstream camera.ts).
// ---------------------------------------------------------------------------
server.registerTool(
  "capture_screenshot",
  {
    title: "Capture Screenshot",
    description:
      "Render the current 3D preview and return it as an image. Use this to SEE the model and verify " +
      "visual results (geometry, textures) directly instead of relying on the user's viewport.",
    inputSchema: { project: z.string().optional().describe("Project name/uuid; default the open one.") },
  },
  async (args) => forwardImage("capture_screenshot", args)
);

server.registerTool(
  "capture_app_screenshot",
  {
    title: "Capture App Screenshot",
    description: "Return a screenshot of the whole Blockbench application window (desktop only).",
    inputSchema: {},
  },
  async () => forwardImage("capture_app_screenshot", {})
);

server.registerTool(
  "set_camera_angle",
  {
    title: "Set Camera Angle",
    description:
      "Position the preview camera (position, optional target/rotation, projection) and return the " +
      "resulting screenshot. Use to frame the model before capturing.",
    inputSchema: {
      position: vec3.describe("Camera position [x,y,z]."),
      target: vec3.optional().describe("Look-at target [x,y,z]."),
      rotation: vec3.optional().describe("Camera rotation [x,y,z]."),
      projection: z.enum(["unset", "orthographic", "perspective"]).describe("Projection type."),
    },
  },
  async (args) => forwardImage("set_camera_angle", args)
);

// ---------------------------------------------------------------------------
// PBR materials + face material instances (texture.ts PBR + material-instances.ts).
// Bedrock/RTX-specific; may be unsupported by some formats (tools fail gracefully).
// ---------------------------------------------------------------------------
const rgba255 = z.array(z.number().min(0).max(255)).length(4);
const mer255 = z.array(z.number().min(0).max(255)).length(3);
const pbrChannelEnum = z.enum(["color", "normal", "height", "mer"]);
const faceEnum = z.enum(["north", "south", "east", "west", "up", "down"]);

server.registerTool(
  "create_pbr_material",
  {
    title: "Create PBR Material",
    description:
      "Create a PBR material (texture group with is_material) and optionally assign textures to the " +
      "color/normal/height/mer channels. For Bedrock RTX resource packs (not needed for plain GeckoLib).",
    inputSchema: {
      name: z.string().describe("Material name."),
      color_texture: z.string().optional().describe("Texture for the color/albedo channel."),
      normal_texture: z.string().optional().describe("Texture for the normal channel."),
      height_texture: z.string().optional().describe("Texture for the height channel."),
      mer_texture: z.string().optional().describe("Texture for the MER channel."),
      color_value: rgba255.optional().describe("Uniform RGBA when no color texture."),
      mer_value: mer255.optional().describe("Uniform [Metalness, Emissive, Roughness]."),
      subsurface_value: z.number().min(0).max(255).optional().describe("Subsurface scattering (1.21.30+)."),
    },
  },
  async (args) => forward("create_pbr_material", args, (r) => `Created PBR material "${r.name}" (uuid ${r.uuid}).`)
);

server.registerTool(
  "configure_material",
  {
    title: "Configure Material",
    description: "Reconfigure a PBR material's channel textures and uniform values ('none' removes a channel).",
    inputSchema: {
      material: z.string().describe("Material name or uuid."),
      color_texture: z.string().optional().describe("Color texture or 'none'."),
      normal_texture: z.string().optional().describe("Normal texture or 'none'."),
      height_texture: z.string().optional().describe("Height texture or 'none'."),
      mer_texture: z.string().optional().describe("MER texture or 'none'."),
      color_value: rgba255.optional(),
      mer_value: mer255.optional(),
      subsurface_value: z.number().min(0).max(255).optional(),
    },
  },
  async (args) => forward("configure_material", args, (r) => `Configured material "${r.name}".`)
);

server.registerTool(
  "list_materials",
  {
    title: "List Materials",
    description: "List PBR materials and their per-channel textures and uniform values.",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try { r = await sendToBlockbench("list_materials", {}); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`list_materials failed: ${r.error}`);
    return ok(JSON.stringify(r.materials, null, 2));
  }
);

server.registerTool(
  "get_material_info",
  {
    title: "Get Material Info",
    description: "Detailed info about a PBR material, including the compiled texture_set.json preview (Bedrock).",
    inputSchema: { material: z.string().describe("Material name or uuid.") },
  },
  async (args) => {
    let r: any;
    try { r = await sendToBlockbench("get_material_info", args); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`get_material_info failed: ${r.error}`);
    return ok(JSON.stringify(r.info, null, 2));
  }
);

server.registerTool(
  "import_texture_set",
  {
    title: "Import Texture Set",
    description: "Import a Bedrock .texture_set.json file (creates a PBR material from it).",
    inputSchema: { path: z.string().describe("Absolute path ending in .texture_set.json.") },
  },
  async (args) => forward("import_texture_set", args, (r) => `Imported texture set from ${r.path}.`)
);

server.registerTool(
  "assign_texture_channel",
  {
    title: "Assign Texture Channel",
    description: "Assign a texture to a PBR channel (color/normal/height/mer) of a material.",
    inputSchema: {
      material: z.string().describe("Material name or uuid."),
      texture: z.string().describe("Texture name or uuid."),
      channel: pbrChannelEnum.describe("Target PBR channel."),
    },
  },
  async (args) => forward("assign_texture_channel", args, (r) => `Assigned "${r.texture}" to ${r.channel} of "${r.material}".`)
);

server.registerTool(
  "save_material_config",
  {
    title: "Save Material Config",
    description: "Save a material's texture_set.json to disk (requires a color texture with a file path).",
    inputSchema: { material: z.string().describe("Material name or uuid.") },
  },
  async (args) => forward("save_material_config", args, (r) => `Saved material config to ${r.file_path}.`)
);

server.registerTool(
  "get_face_material_instances",
  {
    title: "Get Face Material Instances",
    description: "Get the material instance names per face of a cube (Bedrock Block format).",
    inputSchema: {
      cube_id: z.string().optional().describe("Cube name/uuid. Default: first selected cube."),
      faces: z.array(faceEnum).optional().describe("Faces to check; default all."),
    },
  },
  async (args) => {
    let r: any;
    try { r = await sendToBlockbench("get_face_material_instances", args); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`get_face_material_instances failed: ${r.error}`);
    return ok(JSON.stringify({ cube: r.cube, faces: r.faces }, null, 2));
  }
);

server.registerTool(
  "set_face_material_instance",
  {
    title: "Set Face Material Instance",
    description: "Set the material instance name on cube face(s) (empty string clears it).",
    inputSchema: {
      cube_id: z.string().optional().describe("Cube name/uuid. Default: all selected cubes."),
      material_name: z.string().describe("Material instance name (\"\" to clear)."),
      faces: z.array(faceEnum).optional().describe("Faces; default all."),
    },
  },
  async (args) => forward("set_face_material_instance", args, (r) => `Set "${r.material_name}" on ${r.faces} face(s) of ${r.cubes} cube(s).`)
);

server.registerTool(
  "list_material_instances",
  {
    title: "List Material Instances",
    description: "List all unique face material instance names and which cubes/faces use them.",
    inputSchema: {},
  },
  async () => {
    let r: any;
    try { r = await sendToBlockbench("list_material_instances", {}); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`list_material_instances failed: ${r.error}`);
    return ok(JSON.stringify({ total_unique_instances: r.total_unique_instances, material_instances: r.material_instances }, null, 2));
  }
);

server.registerTool(
  "bulk_set_material_instances",
  {
    title: "Bulk Set Material Instances",
    description: "Set material instance names on many cubes/faces at once.",
    inputSchema: {
      assignments: z
        .array(
          z.object({
            cube_id: z.string().describe("Cube name/uuid."),
            faces: z.array(faceEnum).describe("Faces to set."),
            material_name: z.string().describe("Material instance name."),
          })
        )
        .min(1)
        .describe("Array of assignments."),
    },
  },
  async (args) => forward("bulk_set_material_instances", args, (r) => `Applied ${r.assignments} assignment(s) on ${r.faces} face(s).`)
);

server.registerTool(
  "clear_material_instances",
  {
    title: "Clear Material Instances",
    description: "Remove material instance names from cube faces.",
    inputSchema: {
      cube_id: z.string().optional().describe("Cube name/uuid. Default: selected."),
      faces: z.array(faceEnum).optional().describe("Faces; default all."),
      all_cubes: z.boolean().optional().describe("Clear from every cube in the project."),
    },
  },
  async (args) => forward("clear_material_instances", args, (r) => `Cleared ${r.cleared} face(s) on ${r.cubes} cube(s).`)
);

// ---------------------------------------------------------------------------
// Painting tools (ported from upstream paint.ts — core subset). Paint onto a
// texture (e.g. fill atlas regions with draw_shape rectangles), then UV-map
// cubes to those regions with modify_cube uv_offset.
// ---------------------------------------------------------------------------
const blendModeEnum = z.enum(["default", "set_opacity", "color", "behind", "multiply", "add", "screen", "overlay", "difference"]);
const xy = (xd: string, yd: string) => z.object({ x: z.number().describe(xd), y: z.number().describe(yd) });

server.registerTool(
  "paint_fill_tool",
  {
    title: "Paint Fill Tool",
    description: "Flood-fill an area of a texture at (x,y) with a hex color. Texture pixel coordinates.",
    inputSchema: {
      texture_id: z.string().optional().describe("Texture name/uuid; default the active texture."),
      x: z.number().describe("X pixel."),
      y: z.number().describe("Y pixel."),
      color: z.string().describe("Hex color, e.g. '#a0522d'."),
      opacity: z.number().min(0).max(255).optional().describe("0-255."),
      tolerance: z.number().min(0).max(100).optional(),
      fill_mode: z.enum(["color", "color_connected", "face", "element", "selected_elements", "selection"]).optional(),
      blend_mode: blendModeEnum.optional(),
    },
  },
  async (args) => forward("paint_fill_tool", args, (r) => `Filled (${r.x},${r.y}) on "${r.texture}".`)
);

server.registerTool(
  "draw_shape_tool",
  {
    title: "Draw Shape Tool",
    description:
      "Draw a rectangle or ellipse on a texture from start to end (pixels). Use 'rectangle' (filled) to " +
      "paint solid atlas regions; '_h' suffix = hollow outline.",
    inputSchema: {
      texture_id: z.string().optional().describe("Texture name/uuid; default active."),
      shape: z.enum(["rectangle", "rectangle_h", "ellipse", "ellipse_h"]).describe("Shape."),
      start: xy("Start X", "Start Y"),
      end: xy("End X", "End Y"),
      color: z.string().describe("Hex color."),
      line_width: z.number().min(1).max(50).optional().describe("Outline width for hollow shapes."),
      opacity: z.number().min(0).max(255).optional(),
      blend_mode: blendModeEnum.optional(),
    },
  },
  async (args) => forward("draw_shape_tool", args, (r) => `Drew ${r.shape} on "${r.texture}".`)
);

server.registerTool(
  "gradient_tool",
  {
    title: "Gradient Tool",
    description: "Draw a linear gradient between two colors from start to end on a texture.",
    inputSchema: {
      texture_id: z.string().optional().describe("Texture name/uuid; default active."),
      start: xy("Gradient start X", "Gradient start Y"),
      end: xy("Gradient end X", "Gradient end Y"),
      start_color: z.string().describe("Start hex color."),
      end_color: z.string().describe("End hex color."),
      opacity: z.number().min(0).max(255).optional(),
      blend_mode: blendModeEnum.optional(),
    },
  },
  async (args) => forward("gradient_tool", args, (r) => `Applied gradient on "${r.texture}".`)
);

server.registerTool(
  "color_picker_tool",
  {
    title: "Color Picker Tool",
    description: "Pick the color at (x,y) of a texture and set it as the active paint color. Returns the hex.",
    inputSchema: {
      texture_id: z.string().optional().describe("Texture name/uuid; default active."),
      x: z.number().describe("X pixel."),
      y: z.number().describe("Y pixel."),
      set_as_secondary: z.boolean().optional().describe("Set as the secondary color."),
    },
  },
  async (args) => forward("color_picker_tool", args, (r) => `Picked ${r.color} at (${r.x},${r.y}).`)
);

// ---------------------------------------------------------------------------
// Pixel-art shading: hue-shifted palettes + index-matrix painting.
// ---------------------------------------------------------------------------
server.registerTool(
  "list_palettes",
  {
    title: "List Palettes",
    description:
      "List the built-in hue-shifted pixel-art palettes (each a 5-step ramp, index 0=deep shadow/AO → " +
      "4=highlight). Use a palette + indices with paint_pixel_matrix; never compute your own colors.",
    inputSchema: {},
  },
  async () =>
    ok(JSON.stringify({ index_roles: PALETTE_INDEX_ROLES, palettes: PALETTES }, null, 2))
);

server.registerTool(
  "get_palette",
  {
    title: "Get Palette",
    description: "Get one palette's 5 hex colors (index 0=shadow → 4=highlight).",
    inputSchema: { name: z.string().describe(`Palette name. One of: ${PALETTE_NAMES.join(", ")}.`) },
  },
  async (args) => {
    const p = getPalette(args.name);
    return p ? ok(JSON.stringify({ name: args.name, colors: p }, null, 2)) : fail(`Unknown palette "${args.name}". Options: ${PALETTE_NAMES.join(", ")}.`);
  }
);

server.registerTool(
  "paint_pixel_matrix",
  {
    title: "Paint Pixel Matrix",
    description:
      "Render a pixel-art matrix onto a texture using a hue-shifted palette — the proper way to texture " +
      "(not flat fills). `pixels` is an array of equal-length strings, one per row; each character is a " +
      "palette index 0-4, or '.'/' ' for transparent (skip). Colors come ONLY from the palette (index " +
      "0=deep shadow/AO, 4=highlight), so output is hue-shifted and free of anti-aliasing. Encode the " +
      "shading IN the matrix: top-left edges get 4, bottom-right/concave seams get 0-1, add per-pixel " +
      "noise/dithering for organic surfaces. See the 'blockbench-pixel-shading' skill for the rules and " +
      "mob-vs-weapon recipes. Place a cube's region with `origin` matching its box-UV offset.",
    inputSchema: {
      texture_id: z.string().optional().describe("Texture name/uuid; default the active texture."),
      palette: z.string().describe(`Palette name (list_palettes). One of: ${PALETTE_NAMES.join(", ")}.`),
      origin: z.object({ x: z.number().int(), y: z.number().int() }).optional().describe("Top-left pixel to start at. Default [0,0]."),
      pixels: z.array(z.string()).min(1).describe("Rows of palette indices '0'-'4' (or '.'/' ' = transparent)."),
    },
  },
  async (args) =>
    forward("paint_pixel_matrix", args, (r) => `Painted ${r.painted}px with "${r.palette}" at [${r.origin}] (size ${r.size?.[0]}x${r.size?.[1]}) on "${r.texture}".`)
);

// ---------------------------------------------------------------------------
// Remaining paint tools (ported from upstream paint.ts).
// ---------------------------------------------------------------------------
const brushShapeEnum = z.enum(["square", "circle"]);
server.registerTool("copy_brush_tool", { title: "Copy Brush Tool", description: "Clone-stamp from a source pixel to a target pixel on a texture.", inputSchema: { texture_id: z.string().optional(), source: xy("Source X", "Source Y"), target: xy("Target X", "Target Y"), brush_size: z.number().optional(), opacity: z.number().min(0).max(255).optional(), mode: z.enum(["copy", "sample", "pattern"]).optional() } },
  async (args) => forward("copy_brush_tool", args, (r) => `Copy-stamped on "${r.texture}".`));
server.registerTool("eraser_tool", { title: "Eraser Tool", description: "Erase along a path of pixel coordinates on a texture.", inputSchema: { texture_id: z.string().optional(), coordinates: z.array(xy("X", "Y")).describe("Points to erase."), brush_size: z.number().optional(), opacity: z.number().min(0).max(255).optional(), softness: z.number().optional(), shape: brushShapeEnum.optional(), connect_strokes: z.boolean().optional() } },
  async (args) => forward("eraser_tool", args, (r) => `Erased ${r.erased} point(s) on "${r.texture}".`));
server.registerTool("paint_settings", { title: "Paint Settings", description: "Configure painting settings (mirror, lock alpha, pixel-perfect, color-erase, modifiers).", inputSchema: { mirror_painting: z.object({ enabled: z.boolean(), axis: z.array(z.enum(["x", "y", "z"])).optional(), texture: z.boolean().optional(), texture_center: xy("X", "Y").optional() }).optional(), lock_alpha: z.boolean().optional(), pixel_perfect: z.boolean().optional(), paint_side_restrict: z.boolean().optional(), color_erase_mode: z.boolean().optional(), brush_opacity_modifier: z.string().optional(), brush_size_modifier: z.string().optional(), paint_with_stylus_only: z.boolean().optional(), pick_color_opacity: z.boolean().optional(), pick_combined_color: z.boolean().optional() } },
  async (args) => forward("paint_settings", args, (r) => `Updated: ${(r.applied || []).join(", ") || "(nothing)"}.`));
server.registerTool("paint_with_brush", { title: "Paint With Brush", description: "Paint along coordinates with explicit brush settings (size/opacity/softness/shape/color).", inputSchema: { texture_id: z.string().optional(), coordinates: z.array(xy("X", "Y")), brush_settings: z.object({ size: z.number().optional(), opacity: z.number().min(0).max(255).optional(), softness: z.number().optional(), shape: brushShapeEnum.optional(), color: z.string().optional(), blend_mode: blendModeEnum.optional() }).optional(), connect_strokes: z.boolean().optional() } },
  async (args) => forward("paint_with_brush", args, (r) => `Painted ${r.painted} point(s) on "${r.texture}".`));
server.registerTool("create_brush_preset", { title: "Create Brush Preset", description: "Save a reusable brush preset.", inputSchema: { name: z.string(), size: z.number().optional(), opacity: z.number().optional(), softness: z.number().optional(), shape: brushShapeEnum.optional(), color: z.string().optional(), blend_mode: blendModeEnum.optional(), pixel_perfect: z.boolean().optional() } },
  async (args) => forward("create_brush_preset", args, (r) => `Created brush preset "${r.name}".`));
server.registerTool("load_brush_preset", { title: "Load Brush Preset", description: "Load a saved brush preset by name.", inputSchema: { preset_name: z.string() } },
  async (args) => forward("load_brush_preset", args, (r) => `Loaded brush preset "${r.name}".`));
server.registerTool("texture_selection", { title: "Texture Selection", description: "Manage a texture's pixel selection (rectangle/ellipse/all/clear/invert/expand/contract/feather).", inputSchema: { action: z.enum(["select_rectangle", "select_ellipse", "select_all", "clear_selection", "invert_selection", "expand_selection", "contract_selection", "feather_selection"]), texture_id: z.string().optional(), coordinates: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).optional(), radius: z.number().optional(), mode: z.string().optional() } },
  async (args) => forward("texture_selection", args, (r) => `${r.action} on "${r.texture}".`));
server.registerTool("texture_layer_management", { title: "Texture Layer Management", description: "Manage texture layers (create/delete/duplicate/merge_down/set_opacity/set_blend_mode/move/rename/flatten).", inputSchema: { action: z.enum(["create_layer", "delete_layer", "duplicate_layer", "merge_down", "set_opacity", "set_blend_mode", "move_layer", "rename_layer", "flatten_layers"]), texture_id: z.string().optional(), layer_name: z.string().optional(), opacity: z.number().min(0).max(100).optional(), blend_mode: z.string().optional(), target_index: z.number().int().optional() } },
  async (args) => forward("texture_layer_management", args, (r) => r.message));

// ---------------------------------------------------------------------------
// Mesh tools (ported from upstream mesh.ts) — freeform geometry.
// ---------------------------------------------------------------------------
const meshElementSchema = z.object({
  name: z.string().describe("Mesh name."),
  position: vec3.optional().describe("Origin [x,y,z]."),
  rotation: vec3.optional().describe("Rotation [x,y,z]."),
  vertices: z.array(vec3).optional().describe("Vertex coordinates."),
});

server.registerTool(
  "place_mesh",
  {
    title: "Place Mesh",
    description: "Create freeform mesh element(s) from explicit vertices. For primitives use create_sphere/create_cylinder.",
    inputSchema: {
      elements: z.array(meshElementSchema).min(1).describe("Meshes to create."),
      texture: z.string().optional().describe("Texture to apply."),
      group: z.string().optional().describe("Parent group name, or 'root'."),
    },
  },
  async (args) => forward("place_mesh", args, (r) => `Placed ${r.meshes.length} mesh(es): ${r.meshes.map((m: any) => m.name).join(", ")}.`)
);

server.registerTool(
  "create_sphere",
  {
    title: "Create Sphere",
    description: "Create UV-sphere mesh(es) by diameter and side count.",
    inputSchema: {
      elements: z
        .array(z.object({
          name: z.string(),
          position: vec3.describe("Center [x,y,z]."),
          diameter: z.number().min(1).max(64).optional().describe("Default 16."),
          sides: z.number().min(3).max(48).optional().describe("Divisions, default 12."),
          rotation: vec3.optional(),
          align_edges: z.boolean().optional(),
        }))
        .min(1),
      texture: z.string().optional(),
      group: z.string().optional(),
    },
  },
  async (args) => forward("create_sphere", args, (r) => `Created ${r.meshes.length} sphere(s).`)
);

server.registerTool(
  "create_cylinder",
  {
    title: "Create Cylinder",
    description: "Create cylinder mesh(es) by height, diameter and side count (optionally capped).",
    inputSchema: {
      elements: z
        .array(z.object({
          name: z.string(),
          position: vec3.describe("Center [x,y,z]."),
          height: z.number().min(1).max(64).optional().describe("Default 16."),
          diameter: z.number().min(1).max(64).optional().describe("Default 16."),
          sides: z.number().min(3).max(64).optional().describe("Default 12."),
          rotation: vec3.optional(),
          capped: z.boolean().optional().describe("Add end caps (default true)."),
        }))
        .min(1),
      texture: z.string().optional(),
      group: z.string().optional(),
    },
  },
  async (args) => forward("create_cylinder", args, (r) => `Created ${r.meshes.length} cylinder(s).`)
);

server.registerTool(
  "extrude_mesh",
  {
    title: "Extrude Mesh",
    description: "Extrude the current mesh selection (faces/edges/vertices) by a distance.",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid; default selected."),
      distance: z.number().optional().describe("Extrude distance. Default 1."),
      mode: z.enum(["faces", "edges", "vertices"]).optional().describe("Default faces."),
    },
  },
  async (args) => forward("extrude_mesh", args, (r) => `Extruded ${r.mode} of "${r.mesh}" by ${r.distance}.`)
);

server.registerTool(
  "subdivide_mesh",
  {
    title: "Subdivide Mesh",
    description: "Subdivide the mesh selection with N loop cuts.",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid; default selected."),
      cuts: z.number().min(1).max(10).optional().describe("Default 1."),
    },
  },
  async (args) => forward("subdivide_mesh", args, (r) => `Subdivided "${r.mesh}" with ${r.cuts} cut(s).`)
);

server.registerTool(
  "select_mesh_elements",
  {
    title: "Select Mesh Elements",
    description: "Select vertices/edges/faces of a mesh (select/add/remove/toggle).",
    inputSchema: {
      mesh_id: z.string().describe("Mesh name/uuid."),
      mode: z.enum(["vertex", "edge", "face"]).describe("Selection mode."),
      elements: z.array(z.union([z.string(), z.number()])).optional().describe("Keys/indices; omit to select all."),
      action: z.enum(["select", "add", "remove", "toggle"]).optional().describe("Default select."),
    },
  },
  async (args) => forward("select_mesh_elements", args, (r) => `Selected v:${r.selected.vertices} e:${r.selected.edges} f:${r.selected.faces} on "${r.mesh}".`)
);

server.registerTool(
  "move_mesh_vertices",
  {
    title: "Move Mesh Vertices",
    description: "Offset specified (or selected) vertices of a mesh by [x,y,z].",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid; default selected."),
      offset: vec3.describe("Offset [x,y,z]."),
      vertices: z.array(z.string()).optional().describe("Vertex keys; default selected."),
    },
  },
  async (args) => forward("move_mesh_vertices", args, (r) => `Moved ${r.moved} vertices of "${r.mesh}".`)
);

server.registerTool(
  "delete_mesh_elements",
  {
    title: "Delete Mesh Elements",
    description: "Delete the current mesh selection (faces/edges/vertices).",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid; default selected."),
      mode: z.enum(["vertices", "edges", "faces"]).optional().describe("Default faces."),
      keep_vertices: z.boolean().optional().describe("Keep vertices when deleting faces/edges."),
    },
  },
  async (args) => forward("delete_mesh_elements", args, (r) => `Deleted ${r.mode} from "${r.mesh}".`)
);

server.registerTool(
  "merge_mesh_vertices",
  {
    title: "Merge Mesh Vertices",
    description: "Merge vertices closer than a threshold distance.",
    inputSchema: {
      mesh_id: z.string().describe("Mesh name/uuid."),
      threshold: z.number().min(0).max(10).optional().describe("Default 0.1."),
      selected_only: z.boolean().optional().describe("Default true."),
    },
  },
  async (args) => forward("merge_mesh_vertices", args, (r) => `Merged ${r.merged} vertices in "${r.mesh}".`)
);

server.registerTool(
  "create_mesh_face",
  {
    title: "Create Mesh Face",
    description: "Create a face from 3 or 4 existing vertex keys of a mesh.",
    inputSchema: {
      mesh_id: z.string().optional().describe("Mesh name/uuid; default selected."),
      vertices: z.array(z.string()).min(3).max(4).describe("3 or 4 vertex keys."),
      texture: z.string().optional().describe("Texture to apply to the face."),
    },
  },
  async (args) => forward("create_mesh_face", args, (r) => `Created face ${r.face} on "${r.mesh}".`)
);

server.registerTool(
  "knife_tool",
  {
    title: "Knife Tool",
    description: "Cut a mesh along a path of 3D points (each optionally tied to a face key).",
    inputSchema: {
      mesh_id: z.string().describe("Mesh name/uuid."),
      points: z
        .array(z.object({ position: vec3.describe("3D point."), face: z.string().optional().describe("Face key.") }))
        .min(2)
        .describe("Cut path points."),
    },
  },
  async (args) => forward("knife_tool", args, (r) => `Knife cut "${r.mesh}" with ${r.points} points.`)
);

// ---------------------------------------------------------------------------
// UI + import tools (ported from upstream ui.ts + import.ts).
// ---------------------------------------------------------------------------
server.registerTool(
  "trigger_action",
  {
    title: "Trigger Action",
    description:
      "Trigger any Blockbench action by its BarItems id (e.g. 'add_cube', 'export_over'). Returns an app " +
      "screenshot. Powerful escape hatch for actions without a dedicated MCP tool.",
    inputSchema: {
      action: z.string().describe("BarItems action id."),
      confirmDialog: z.boolean().optional().describe("Auto-confirm a resulting dialog (default true)."),
      confirmEvent: z.string().optional().describe("Stringified JSON event args."),
    },
  },
  async (args) => forwardImageOrText("trigger_action", args, (r) => r.message || `Triggered "${args.action}".`)
);

server.registerTool(
  "risky_eval",
  {
    title: "Risky Eval (escape hatch)",
    description:
      "DANGEROUS: evaluate arbitrary JavaScript inside Blockbench and return the result. Use only when no " +
      "dedicated tool exists. No 'console.' or comments allowed. Prefer the specific tools.",
    inputSchema: {
      code: z.string().describe("JavaScript to evaluate (no console./comments)."),
    },
  },
  async (args) => forward("risky_eval", args, (r) => String(r.result))
);

server.registerTool(
  "emulate_clicks",
  {
    title: "Emulate Clicks",
    description: "Dispatch a mouse click (optionally a drag) at screen coordinates, then return an app screenshot.",
    inputSchema: {
      position: z.object({
        x: z.number(),
        y: z.number(),
        button: z.enum(["left", "right"]).optional(),
      }),
      drag: z
        .object({ to: z.object({ x: z.number(), y: z.number() }), duration: z.number().optional() })
        .optional()
        .describe("If set, drag from position to 'to'."),
    },
  },
  async (args) => forwardImageOrText("emulate_clicks", args, (r) => r.message || "Clicks emulated.")
);

server.registerTool(
  "fill_dialog",
  {
    title: "Fill Dialog",
    description: "Fill the currently open Blockbench dialog with values (stringified JSON) and confirm/cancel it.",
    inputSchema: {
      values: z.string().describe("Stringified JSON of form values."),
      confirm: z.boolean().optional().describe("Confirm (true) or cancel (false). Default true."),
    },
  },
  async (args) => forward("fill_dialog", args, (r) => `Dialog handled; stack depth now ${r.stack_depth}.`)
);

server.registerTool(
  "from_geo_json",
  {
    title: "Import GeoJSON",
    description: "Import a model from a Bedrock geo JSON — inline string or an http(s) URL. Returns an app screenshot.",
    inputSchema: {
      geojson: z.string().describe("Inline geo JSON, or an http(s) URL to fetch it from."),
    },
  },
  async (args) => forwardImageOrText("from_geo_json", args, (r) => r.message || "Imported GeoJSON.")
);

// ---------------------------------------------------------------------------
// Armature tools (ported from upstream armature.ts). Skeletal rig + vertex
// weights — newer Blockbench feature; needs a format with armature_rig.
// ---------------------------------------------------------------------------
/** Forward an armature read tool that returns r.data as JSON. */
async function forwardData(tool: ToolType, args: Record<string, any>) {
  let r: any;
  try { r = await sendToBlockbench(tool, args); } catch (e: any) { return fail(e?.message || String(e)); }
  if (r && r.ok === false) return fail(`${tool} failed: ${r.error}`);
  return ok(JSON.stringify(r.data, null, 2));
}

server.registerTool("list_armatures", { title: "List Armatures", description: "List all armatures (skeletal rigs) in the project.", inputSchema: {} },
  async () => forwardData("list_armatures", {}));
server.registerTool("get_armature", { title: "Get Armature", description: "Get an armature's details (optionally its bone hierarchy).", inputSchema: { id: z.string().describe("Armature uuid/name."), include_bones: z.boolean().optional() } },
  async (args) => forwardData("get_armature", args));
server.registerTool("add_armature", { title: "Add Armature", description: "Create a new armature (requires a format with armature_rig). Optionally adds an initial bone.", inputSchema: { name: z.string().optional(), visibility: z.boolean().optional(), locked: z.boolean().optional(), add_initial_bone: z.boolean().optional() } },
  async (args) => forward("add_armature", args, (r) => r.message));
server.registerTool("remove_armature", { title: "Remove Armature", description: "Remove an armature and its bones.", inputSchema: { id: z.string().describe("Armature uuid/name.") } },
  async (args) => forward("remove_armature", args, (r) => r.message));
server.registerTool("update_armature", { title: "Update Armature", description: "Update an armature's name/visibility/locked/export.", inputSchema: { id: z.string(), name: z.string().optional(), visibility: z.boolean().optional(), locked: z.boolean().optional(), export: z.boolean().optional() } },
  async (args) => forward("update_armature", args, (r) => r.message));
server.registerTool("list_armature_bones", { title: "List Armature Bones", description: "List bones, optionally filtered to one armature.", inputSchema: { armature_id: z.string().optional() } },
  async (args) => forwardData("list_armature_bones", args));
server.registerTool("get_armature_bone", { title: "Get Armature Bone", description: "Get a bone's details (optionally its vertex weights).", inputSchema: { id: z.string().describe("Bone uuid/name."), include_weights: z.boolean().optional() } },
  async (args) => forwardData("get_armature_bone", args));
server.registerTool("add_armature_bone", { title: "Add Armature Bone", description: "Add a bone under an armature or another bone.", inputSchema: { parent_id: z.string().describe("Parent armature/bone uuid/name."), name: z.string().optional(), origin: vec3.optional(), rotation: vec3.optional(), length: z.number().optional(), width: z.number().optional(), connected: z.boolean().optional(), color: z.number().int().min(0).max(7).optional() } },
  async (args) => forward("add_armature_bone", args, (r) => r.message));
server.registerTool("remove_armature_bone", { title: "Remove Armature Bone", description: "Remove a bone (optionally keep/reparent children).", inputSchema: { id: z.string(), remove_children: z.boolean().optional() } },
  async (args) => forward("remove_armature_bone", args, (r) => r.message));
server.registerTool("update_armature_bone", { title: "Update Armature Bone", description: "Update a bone's transform/appearance.", inputSchema: { id: z.string(), name: z.string().optional(), origin: vec3.optional(), rotation: vec3.optional(), length: z.number().optional(), width: z.number().optional(), connected: z.boolean().optional(), color: z.number().int().min(0).max(7).optional(), visibility: z.boolean().optional(), locked: z.boolean().optional() } },
  async (args) => forward("update_armature_bone", args, (r) => r.message));
server.registerTool("update_armature_bones_batch", { title: "Update Armature Bones (Batch)", description: "Set visibility/locked/color on many bones at once.", inputSchema: { ids: z.array(z.string()).describe("Bone uuids/names."), visibility: z.boolean().optional(), locked: z.boolean().optional(), color: z.number().int().min(0).max(7).optional() } },
  async (args) => forward("update_armature_bones_batch", args, (r) => r.message));
server.registerTool("select_armature_bones", { title: "Select Armature Bones", description: "Select bones by ids or whole armature (optionally descendants).", inputSchema: { ids: z.array(z.string()).optional(), armature_id: z.string().optional(), include_descendants: z.boolean().optional(), clear_selection: z.boolean().optional() } },
  async (args) => forward("select_armature_bones", args, (r) => r.message));
server.registerTool("get_vertex_weights", { title: "Get Vertex Weights", description: "Get a mesh's vertex weights (optionally for one bone).", inputSchema: { mesh_id: z.string().optional(), bone_id: z.string().optional() } },
  async (args) => forwardData("get_vertex_weights", args));
server.registerTool("set_vertex_weight", { title: "Set Vertex Weight", description: "Set a single vertex's weight for a bone (0-1; 0 removes).", inputSchema: { bone_id: z.string(), mesh_id: z.string().optional(), vertex_key: z.string(), weight: z.number().min(0).max(1) } },
  async (args) => forward("set_vertex_weight", args, (r) => r.message));
server.registerTool("set_vertex_weights_batch", { title: "Set Vertex Weights (Batch)", description: "Set many vertex weights for a bone at once.", inputSchema: { bone_id: z.string(), mesh_id: z.string().optional(), weights: z.record(z.string(), z.number().min(0).max(1)).describe("vertex_key -> weight.") } },
  async (args) => forward("set_vertex_weights_batch", args, (r) => r.message));
server.registerTool("clear_vertex_weights", { title: "Clear Vertex Weights", description: "Remove all of a bone's vertex weights for a mesh.", inputSchema: { bone_id: z.string(), mesh_id: z.string().optional() } },
  async (args) => forward("clear_vertex_weights", args, (r) => r.message));

// ---------------------------------------------------------------------------
// Skill guides — exposed as tools + resources so Claude can consult them.
// ---------------------------------------------------------------------------
server.registerTool(
  "list_skills",
  {
    title: "List Blockbench Skills",
    description:
      "List the bundled Blockbench skill guides (name + description). Read one with get_skill. " +
      "Consult 'blockbench-use' first before any modeling/texturing/animation/export work.",
    inputSchema: {},
  },
  async () => {
    if (skills.skills.length === 0) return fail("No skill guides are bundled (skills directory not found).");
    return ok(skills.skills.map((s) => `### ${s.name}\n${s.description}`).join("\n\n"));
  }
);

server.registerTool(
  "get_skill",
  {
    title: "Get Blockbench Skill",
    description:
      "Return a bundled skill guide's full content. Read 'blockbench-use' first (the mandatory " +
      "orchestrator), then the relevant domain skill. Use 'file' to fetch a reference/asset listed " +
      "at the bottom of a skill (e.g. 'references/api.md').",
    inputSchema: {
      skill: z.string().describe("Skill name or directory, e.g. 'blockbench-use', 'blockbench-modeling'."),
      file: z.string().optional().describe("Optional reference/asset path within the skill, e.g. 'references/api.md'."),
    },
  },
  async (args) => {
    const r = getSkillContent(skills, args.skill, args.file);
    return r.ok ? ok(r.text) : fail(r.error);
  }
);

// Also surface each skill as a readable resource for clients that browse resources.
for (const s of skills.skills) {
  server.registerResource(
    s.name,
    `skill://${s.dir}`,
    { title: `Skill: ${s.name}`, description: s.description, mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(s.file, "utf8") }],
    })
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    "MCP server ready (stdio). Tools: create_cube, create_group, set_origin, set_rotation, " +
      "get_scene_tree, register_texture, apply_texture, validate_model, create_animation, " +
      "manage_keyframes, animation_graph_editor, animation_timeline, batch_keyframe_operations, " +
      "animation_copy_paste, list_animations, modify_cube, delete_element, reparent_element, " +
      "list_export_formats, export_model, export_animations, get_project_info, set_project, " +
      "create_texture, list_textures, get_texture, activate_texture, add_texture_group, " +
      "set_mesh_uv, auto_uv_mesh, rotate_mesh_uv, capture_screenshot, capture_app_screenshot, " +
      "set_camera_angle, undo, redo, get_undo_stack, save_checkpoint, duplicate_element, " +
      "rename_element, find_elements_by_criteria, select_all_of_type, filter_by_material, " +
      "get_selection, create_pbr_material, configure_material, list_materials, get_material_info, " +
      "import_texture_set, assign_texture_channel, save_material_config, get_face_material_instances, " +
      "set_face_material_instance, list_material_instances, bulk_set_material_instances, " +
      "clear_material_instances, paint_fill_tool, draw_shape_tool, gradient_tool, color_picker_tool, " +
      "place_mesh, create_sphere, create_cylinder, extrude_mesh, subdivide_mesh, select_mesh_elements, " +
      "move_mesh_vertices, delete_mesh_elements, merge_mesh_vertices, create_mesh_face, knife_tool, " +
      "trigger_action, risky_eval, emulate_clicks, fill_dialog, from_geo_json, list_armatures, " +
      "get_armature, add_armature, remove_armature, update_armature, list_armature_bones, " +
      "get_armature_bone, add_armature_bone, remove_armature_bone, update_armature_bone, " +
      "update_armature_bones_batch, select_armature_bones, get_vertex_weights, set_vertex_weight, " +
      "set_vertex_weights_batch, clear_vertex_weights, copy_brush_tool, eraser_tool, paint_settings, " +
      "paint_with_brush, create_brush_preset, load_brush_preset, texture_selection, " +
      "texture_layer_management, paint_pixel_matrix, list_palettes, get_palette, list_skills, get_skill"
  );
  if (skills.dir) log(`Loaded ${skills.skills.length} skill guide(s) from ${skills.dir}: ${skills.skills.map((s) => s.name).join(", ")}`);
  else log("No skills directory found — skill guides are not available.");
}

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
