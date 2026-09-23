import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server as IOServer, Socket } from "socket.io";
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolType, SceneTree } from "../../../packages/shared/src/types";
import { validateScene, buildReport } from "../../../packages/shared/src/validation";
import { PALETTES, PALETTE_NAMES, PALETTE_INDEX_ROLES, getPalette } from "../../../packages/shared/src/palettes";
import { loadSkills, buildInstructions, getSkillContent } from "./skills";

// The Blockbench plugin connects to 9999 by default; tests override this with
// MCP_BRIDGE_PORT so they run on an isolated port and never hijack (or get
// hijacked by) a real Blockbench instance listening on 9999.
const PORT = Number(process.env.MCP_BRIDGE_PORT) || 9999;
// Keep in step with apps/*/package.json (the plugin takes its version from there).
const SERVER_VERSION = "0.3.0";

// IMPORTANT: when running as an MCP server over stdio, stdout is reserved for
// the JSON-RPC protocol. ALL logging must go to stderr or it corrupts the stream.
const log = (...args: any[]) => console.error("[MCP]", ...args);

// ---------------------------------------------------------------------------
// Socket.IO bridge toward the Blockbench plugin
// ---------------------------------------------------------------------------
// The bridge is local-only: it binds to the loopback interface, so nothing on the
// network can reach it, and it refuses connections that come from a web page — any
// site open in a browser could otherwise open a WebSocket to 127.0.0.1:9999, pose
// as Blockbench and read the tool calls. Web pages always send an Origin: http(s)
// for normal pages, "null" for sandboxed iframes. The Blockbench plugin sends none
// (verified live 2026-09-23), and neither do Node clients (tests).
const BRIDGE_HOST = "127.0.0.1";
const isWebOrigin = (origin: string | undefined): boolean =>
  !!origin && (/^https?:\/\//i.test(origin) || origin.trim().toLowerCase() === "null");

// ---------------------------------------------------------------------------
// Shared bridge. Only one process can own the port, but several MCP clients (the
// Claude app, Claude Code sessions, …) may each start this server. The first one
// becomes the OWNER — the plugin connects to it. Later ones become RELAYS: they send
// their tool calls through the owner over a small local HTTP endpoint instead of
// exiting. If the owner goes away, a relay takes the port over and the plugin
// (which reconnects on its own) connects to it. The endpoint is as locked down as
// the socket: loopback only, no Origin allowed (browsers always send one), a custom
// header (forces a CORS preflight that is never granted) and a Host check
// (defeats DNS rebinding).
// ---------------------------------------------------------------------------
const RELAY_PATH = "/mcp-bridge/call";
const PING_PATH = "/mcp-bridge/ping";
const RELAY_HEADER = "x-blockbench-mcp-relay";
let role: "owner" | "relay" = "owner";
let ownerSince = Date.now();
const pluginWaiters: Array<() => void> = []; // calls waiting for the plugin to (re)connect
const relaysSeen = new Map<string, number>(); // owner side: relay id -> last seen (ms)

const isTrustedLocalRequest = (req: IncomingMessage): boolean =>
  !req.headers.origin &&
  req.headers[RELAY_HEADER] === "1" &&
  /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || ""));

// Handles the relay endpoint; Socket.IO serves its own path on the same server.
function bridgeHttpHandler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: any) => {
    // No keep-alive: every relay call opens a fresh connection, so a dead owner shows
    // up as "connection refused" (never delivered, safe to resend after taking over)
    // rather than a reused socket dying at an ambiguous moment.
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };
  if (req.url !== RELAY_PATH && req.url !== PING_PATH) return send(404, { error: "not found" });
  if (!isTrustedLocalRequest(req)) {
    log(`Refused a bridge HTTP request (origin: ${req.headers.origin ?? "none"}, host: ${req.headers.host ?? "none"}).`);
    return send(403, { error: "forbidden" });
  }
  relaysSeen.set(String(req.headers["x-blockbench-mcp-client"] || "relay"), Date.now());
  if (req.url === PING_PATH) return send(200, { bridge: "blockbench-mcp", version: SERVER_VERSION, plugin_connected: !!(blockbench && blockbench.connected) });
  if (req.method !== "POST") return send(405, { error: "POST only" });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 64 * 1024 * 1024) req.destroy(); // a data URL can be big, but not this big
    else chunks.push(c);
  });
  req.on("end", async () => {
    let cmd: any;
    try { cmd = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "bad json" }); }
    if (!cmd || typeof cmd.tool !== "string") return send(400, { error: "tool required" });
    const callId = typeof cmd.callId === "string" ? cmd.callId.slice(0, 64) : undefined;
    try { send(200, { response: await sendLocal(cmd.tool, cmd.input || {}, cmd.timeoutMs, callId) }); }
    catch (e: any) { send(200, { transportError: e?.message || String(e) }); }
  });
}

const httpServer = createServer(bridgeHttpHandler);
const io = new IOServer(httpServer, {
  cors: { origin: "*" },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (isWebOrigin(origin)) {
      log(`Rejected a bridge connection from web origin ${origin} (only the Blockbench plugin may connect).`);
      callback("web origins are not allowed", false);
      return;
    }
    callback(null, true);
  },
});

let blockbench: Socket | null = null;

// A connected socket is usable immediately: the plugin registers its
// tool_command handler synchronously on load, before the (async) connection
// completes, and every call is confirmed by its own ack under a per-tool
// timeout — so no separate "ready" gate is needed. client_ready is only logged.
io.on("connection", (socket) => {
  log("Blockbench plugin connected:", socket.id, `(origin: ${socket.handshake.headers.origin ?? "none"})`);
  blockbench = socket;
  pluginWaiters.splice(0).forEach((wake) => wake());
  socket.on("client_ready", () => log("Blockbench plugin is ready"));
  socket.on("disconnect", () => {
    log("Blockbench plugin disconnected:", socket.id);
    if (blockbench === socket) {
      // Fall back to a client that is still connected (e.g. the real plugin after a
      // short-lived extra connection), instead of dropping the bridge altogether.
      const others = [...io.of("/").sockets.values()].filter((s) => s.id !== socket.id && s.connected);
      blockbench = others.length ? others[others.length - 1] : null;
      if (blockbench) log("Bridge fell back to still-connected client:", blockbench.id);
    }
  });
});

const relayHeaders = () => ({
  [RELAY_HEADER]: "1",
  "x-blockbench-mcp-client": String(process.pid),
  "content-type": "application/json",
});

// One request to the bridge on this machine. Plain node:http with no keep-alive
// (agent: false) instead of fetch(): fetch pools sockets, and on Windows exiting
// while a pooled socket is open aborts Node (libuv UV_HANDLE_CLOSING assertion).
// A fresh connection per call also makes "owner gone" an unambiguous refusal.
function localRequest(pathname: string, body: any, timeoutMs: number): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: BRIDGE_HOST,
        port: PORT,
        path: pathname,
        method: data ? "POST" : "GET",
        agent: false,
        headers: { ...relayHeaders(), ...(data ? { "content-length": data.length } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("aborted", () => req.destroy(Object.assign(new Error("response aborted"), { code: "ECONNRESET" })));
        res.on("end", () => {
          clearTimeout(timer);
          let json: any = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timed out"), { code: "LOCAL_TIMEOUT" })), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(data ?? undefined);
  });
}

// Try to own the port once; "in-use" means another process has it.
let listenAttempt: ((err: any) => void) | null = null;
httpServer.on("error", (err: any) => {
  if (listenAttempt) return listenAttempt(err);
  log("FATAL: bridge HTTP server error:", err);
  process.exit(1);
});
const listenOnce = (): Promise<"listening" | "in-use"> =>
  new Promise((resolve) => {
    listenAttempt = (err: any) => {
      listenAttempt = null;
      httpServer.off("listening", onListening);
      if (err && err.code === "EADDRINUSE") return resolve("in-use");
      log("FATAL: bridge HTTP server error:", err);
      process.exit(1);
    };
    const onListening = () => {
      listenAttempt = null;
      resolve("listening");
    };
    httpServer.once("listening", onListening);
    httpServer.listen(PORT, BRIDGE_HOST);
  });

// Is the port owned by a blockbench-mcp bridge (as opposed to another program)?
// Returns the owner's ping reply, or null if nothing answers like a blockbench-mcp bridge.
const pingOwner = async (): Promise<{ bridge: string; version?: string } | null> => {
  try {
    const { status, json } = await localRequest(PING_PATH, null, 2000);
    return status === 200 && json?.bridge === "blockbench-mcp" ? json : null;
  } catch {
    return null;
  }
};

// Become the owner if the port is free, otherwise a relay of the bridge that owns it.
// A few attempts, in case the owner exits between our listen and our ping.
async function establishBridge(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500));
    if ((await listenOnce()) === "listening") {
      const tookOver = role === "relay";
      role = "owner";
      ownerSince = Date.now();
      log(`Socket.IO bridge listening on http://${BRIDGE_HOST}:${PORT} (local only)${tookOver ? " — took over from the previous owner" : ""}.`);
      return;
    }
    const owner = await pingOwner();
    if (owner) {
      if (role !== "relay") {
        log(
          `Port ${PORT} is owned by another blockbench-mcp server — joined it as a relay (shared bridge).` +
            (owner.version !== SERVER_VERSION
              ? ` Note: the owner runs v${owner.version}, this server v${SERVER_VERSION}; restart the owner's client to use this version's tools.`
              : "")
        );
      }
      role = "relay";
      return;
    }
  }
  log(
    `FATAL: bridge port ${PORT} is in use by a program that is not a blockbench-mcp bridge (or by a blockbench-mcp ` +
      `server older than 0.3.0, which cannot share it — restart the client that runs it). Free the port or set MCP_BRIDGE_PORT.`
  );
  process.exit(1);
}

let takingOver: Promise<void> | null = null;
const takeOverIfOwnerGone = (): Promise<void> => {
  if (!takingOver) {
    takingOver = (async () => {
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400)); // stagger competing relays
      if (!(await pingOwner())) await establishBridge();
    })().finally(() => { takingOver = null; });
  }
  return takingOver;
};

// For get_project_info: which role this server has and who else shares the bridge.
const bridgeInfo = () => {
  const recent = [...relaysSeen.values()].filter((t) => Date.now() - t < 10_000).length;
  return role === "owner"
    ? { role, port: PORT, server_version: SERVER_VERSION, relays_connected: recent }
    : { role, port: PORT, server_version: SERVER_VERSION, note: "calls go through the server that owns the port" };
};

const bridgeReady = establishBridge();
// Relays watch the owner, so one takes over (and the plugin reconnects to it)
// before the next tool call needs it.
setInterval(() => {
  if (role === "relay") void pingOwner().then((alive) => { if (!alive) void takeOverIfOwnerGone(); });
}, 3000).unref();

// Per-tool timeout tiers. A timeout never slows a normal call — it only decides
// how long a FAILURE takes to surface — so keep it as short as each tool safely
// allows. Measured over 1659 real calls (2026-06/07): p99 320 ms, slowest ~1 s.
// Too short is worse than slow, though: the plugin may STILL apply an edit after
// the server gave up (a retry then duplicates it), so heavy tools get headroom.
// Keyed by string so any runtime tool name can be tuned here.
const DEFAULT_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUTS: Record<string, number> = {
  // Render + PNG encode, or drive the UI then screenshot.
  capture_screenshot: 30_000,
  capture_app_screenshot: 30_000,
  set_camera_angle: 30_000,
  trigger_action: 30_000,
  emulate_clicks: 30_000,
  // Entering Animation mode (ensureAnimationMode) can take a few seconds on a big
  // rig or right after a plugin reload — 20 s is ~20x the slowest measured call.
  get_bone_pose: 20_000,
  get_keyframes: 20_000,
  create_animation: 20_000,
  manage_keyframes: 20_000,
  animation_timeline: 20_000,
  animation_graph_editor: 20_000,
  list_animations: 20_000,
  // Codec compile of the whole project / all animations.
  export_model: 60_000,
  export_animations: 60_000,
  // Whole-scene reads / validation that pull the full tree.
  get_scene_tree: 20_000,
  validate_model: 20_000,
  validate_uv: 20_000,
  find_elements_by_criteria: 20_000,
  // Batch geometry creation can build a whole model in one call.
  create_cubes: 30_000,
  // Opening a new project tab / importing or decoding a whole image.
  create_project: 20_000,
  manage_animation: 20_000,
  replace_texture: 20_000,
  // Batches: many edits in one call.
  set_keyframes: 20_000,
  // Samples the whole model across the animation when floor_y is given.
  check_animation: 30_000,
  modify_cubes: 20_000,
  shade_cubes: 30_000,
  // Geometry/UV packing and large canvas paints.
  pack_uv: 30_000,
  paint_pixel_matrix: 20_000,
  shade_cube: 20_000,
  draw_shape_tool: 20_000,
  gradient_tool: 20_000,
  paint_fill_tool: 20_000,
  // Fetches a remote URL, or runs arbitrary user code.
  from_geo_json: 30_000,
  risky_eval: 30_000,
};
const timeoutFor = (tool: ToolType): number => TOOL_TIMEOUTS[tool] ?? DEFAULT_TIMEOUT_MS;

/** Send a command to the Blockbench plugin and await its ack (result object). */
async function sendToBlockbench(tool: ToolType, input: Record<string, any>, timeoutMs?: number): Promise<any> {
  const ms = timeoutMs ?? timeoutFor(tool);
  await bridgeReady;
  if (role === "owner") return sendLocal(tool, input, ms);
  // The id lets the plugin recognise a resend: if the owner dies mid-call we cannot
  // know whether the call got through, so it is sent once more and the plugin returns
  // the first result instead of applying the edit twice.
  const callId = randomUUID();
  try {
    return await sendViaOwner(tool, input, ms, callId);
  } catch (e: any) {
    if (!(e instanceof OwnerUnreachable)) throw e;
    await takeOverIfOwnerGone();
    if ((role as string) === "owner") return sendLocal(tool, input, ms, callId);
    try {
      return await sendViaOwner(tool, input, ms, callId); // another relay took over
    } catch (e2: any) {
      throw e2 instanceof OwnerUnreachable ? new Error(`The shared bridge is unavailable (tool: ${tool}): ${e2.message}`) : e2;
    }
  }
}

class OwnerUnreachable extends Error {}

async function sendViaOwner(tool: string, input: Record<string, any>, ms: number, callId: string): Promise<any> {
  let r: { status: number; json: any };
  try {
    // The owner answers within its own plugin-wait grace + ms.
    r = await localRequest(RELAY_PATH, { tool, input, timeoutMs: ms, callId }, ms + 12_000);
  } catch (e: any) {
    if (e?.code === "LOCAL_TIMEOUT") throw new Error(`Timed out waiting for a response from Blockbench after ${ms}ms (tool: ${tool}, via the shared bridge).`);
    // Refused, reset or closed before an answer: the owner is (probably) gone.
    throw new OwnerUnreachable(e?.code || e?.message || String(e));
  }
  if (r.status !== 200) throw new Error(`The shared bridge refused the call (HTTP ${r.status}: ${r.json?.error ?? "unknown"}).`);
  if (r.json?.transportError) throw new Error(r.json.transportError);
  return r.json?.response;
}

// Right after this process became the owner the plugin is still in its reconnect
// back-off (up to ~7.5 s), so a call made then waits for it instead of failing.
const waitForPlugin = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { const i = pluginWaiters.indexOf(done); if (i >= 0) pluginWaiters.splice(i, 1); resolve(); }, ms);
    pluginWaiters.push(done);
  });

async function sendLocal(tool: string, input: Record<string, any>, timeoutMs?: number, callId?: string): Promise<any> {
  const ms = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 120_000);
  const graceLeft = ownerSince + 10_000 - Date.now();
  if ((!blockbench || blockbench.disconnected) && graceLeft > 0) await waitForPlugin(graceLeft);
  return new Promise((resolve, reject) => {
    if (!blockbench || blockbench.disconnected) {
      reject(
        new Error(
          "Blockbench is not connected. Open Blockbench, enable the MCP plugin, and make sure a model is open."
        )
      );
      return;
    }
    const socket = blockbench;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for a response from Blockbench after ${ms}ms (tool: ${tool}).`));
    }, ms);
    socket.emit("tool_command", callId ? { tool, input, call_id: callId } : { tool, input }, (response: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// Helpers to turn a plugin ack into an MCP tool result.
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
// Classify a failure message into a stable, machine-readable code so the AI can
// branch on the KIND of error instead of parsing prose. Derived from the message
// (plugin handlers already return descriptive strings) and prepended as `[CODE] ` —
// additive: the full human-readable text is preserved after the code.
function errorCode(text: string): string {
  const m = (text || "").toLowerCase();
  if (m.includes("not connected")) return "NOT_CONNECTED";
  if (m.includes("timed out") || m.includes("timeout")) return "TIMEOUT";
  if (m.includes("no project")) return "NO_PROJECT";
  if (m.includes("already exists") || /used \d+ times/.test(m)) return "DUPLICATE_NAME";
  if (m.includes("multi-axis") || m.includes("cannot be rotated") || m.includes("rotated on")) return "ILLEGAL_ROTATION";
  if (m.includes("not registered") || m.includes("missing texture")) return "MISSING_TEXTURE";
  if (m.includes("not found") || m.includes("could not find")) return "NOT_FOUND";
  if (m.includes("does not support") || m.includes("not compatible") || m.includes("renders only cubes") || m.includes("unsupported")) return "FORMAT_UNSUPPORTED";
  if (m.includes(" uv") || m.includes("overlap")) return "UV_ERROR";
  if (m.includes("finite numbers") || m.includes("must be") || m.includes("required") || m.includes("inverted") || m.includes("invalid")) return "INVALID_INPUT";
  return "ERROR";
}
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text: `[${errorCode(text)}] ${text}` }] });
// Non-fatal plugin warnings (`warning` or `warnings[]` on the ack) as trailing lines.
const warningLines = (r: any): string =>
  [r?.warning, ...(r?.warnings || [])].filter(Boolean).map((w: string) => `\n⚠️  ${w}`).join("");
// Blockbench grows an animation when a keyframe lands past its end; say so.
const lengthNote = (r: any): string =>
  r?.length_changed
    ? `\n⚠️  The animation grew from ${r.length_changed.from}s to ${r.length_changed.to}s because a keyframe is past the old end — use animation_timeline set_length to change it back if that wasn't intended.`
    : "";
// One channel's stored keyframes as "t=0 [0, 0, 0] · t=1 [4, 0, 0]", capped.
const formatKeyframes = (kfs: any[], max = 12): string => {
  const list = kfs || [];
  const shown = list.slice(0, max).map((k) => `t=${k.time} [${(k.values || []).join(", ")}]`).join(" · ");
  return shown ? shown + (list.length > max ? ` … (+${list.length - max} more)` : "") : "(no keyframes)";
};
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
// Longest edge of a returned screenshot. Smaller images cost the model far fewer
// tokens to read; 800 px keeps a model clearly legible.
const screenshotMaxSize = z
  .number()
  .int()
  .min(0)
  .max(4096)
  .optional()
  .describe("Longest image edge in px (default 800; 0 = native size). Raise only when you need fine detail.");
const modifyCubeInputSchema = {
  id: z.string().optional().describe("Cube name or UUID to modify."),
  cube_name: z.string().optional().describe("Deprecated alias for id; accepted for compatibility."),
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
};

// ---------------------------------------------------------------------------
// MCP server (stdio) toward Claude
// ---------------------------------------------------------------------------
// Load bundled skill guides and inject their index into the server instructions,
// so every client sees them at startup (initialize) and is told to consult them.
const skills = loadSkills();

// ---------------------------------------------------------------------------
// Tool profile. Every loaded tool's schema is sent to the model, and 50 tools —
// mesh editing, armatures/vertex weights, Bedrock PBR/material instances, brush
// emulation — don't apply to GeckoLib/Bedrock cube models (8 of 1659 measured
// calls). The default "geckolib" profile doesn't load them (~30% shorter tool
// list); BLOCKBENCH_MCP_PROFILE=full loads everything.
// ---------------------------------------------------------------------------
const PROFILE = (process.env.BLOCKBENCH_MCP_PROFILE || "geckolib").toLowerCase() === "full" ? "full" : "geckolib";
const GECKOLIB_HIDDEN = new Set([
  // Mesh editing (GeckoLib renders cubes only).
  "place_mesh", "create_sphere", "create_cylinder", "extrude_mesh", "subdivide_mesh", "select_mesh_elements",
  "move_mesh_vertices", "delete_mesh_elements", "merge_mesh_vertices", "create_mesh_face", "knife_tool",
  "set_mesh_uv", "auto_uv_mesh", "rotate_mesh_uv",
  // Armatures + vertex weights (mesh skinning; GeckoLib bones are groups).
  "list_armatures", "get_armature", "add_armature", "remove_armature", "update_armature", "list_armature_bones",
  "get_armature_bone", "add_armature_bone", "remove_armature_bone", "update_armature_bone",
  "update_armature_bones_batch", "select_armature_bones", "get_vertex_weights", "set_vertex_weight",
  "set_vertex_weights_batch", "clear_vertex_weights",
  // Bedrock RTX PBR materials + block material instances.
  "create_pbr_material", "configure_material", "list_materials", "get_material_info", "import_texture_set",
  "assign_texture_channel", "save_material_config", "get_face_material_instances", "set_face_material_instance",
  "list_material_instances", "bulk_set_material_instances", "clear_material_instances", "add_texture_group",
  // Brush emulation (the canvas-direct paint tools cover these).
  "copy_brush_tool", "eraser_tool", "paint_settings", "paint_with_brush", "create_brush_preset",
  "load_brush_preset", "texture_selection",
]);
const profileNote = PROFILE === "full" ? "" :
  "\n\nTool profile \"geckolib\": mesh-editing, armature/vertex-weight, Bedrock PBR/material-instance and " +
  "brush-emulation tools are not loaded (GeckoLib renders cubes only). If a task truly needs them, ask the " +
  "user to set BLOCKBENCH_MCP_PROFILE=full in the MCP server config and restart the client.";
const instructions = (buildInstructions(skills) || "") + profileNote;

// MCP tool annotations so clients can tell reads from edits (per the spec,
// readOnlyHint defaults to false and destructiveHint to true, so both are set
// explicitly). "Read-only" = changes no project data or undo history; camera or
// timeline view state may still move (e.g. capture_screenshot with a `time`).
const READ_ONLY_TOOLS = new Set([
  "get_scene_tree", "get_project_info", "validate_model", "validate_uv", "list_animations", "get_keyframes",
  "get_bone_pose", "check_animation", "list_export_formats", "list_textures", "get_texture", "find_elements_by_criteria",
  "filter_by_material", "get_selection", "get_undo_stack", "capture_screenshot", "capture_app_screenshot",
  "list_materials", "get_material_info", "get_face_material_instances", "list_material_instances",
  "list_palettes", "get_palette", "list_actions", "list_armatures", "get_armature", "list_armature_bones",
  "get_armature_bone", "get_vertex_weights", "list_skills", "get_skill",
]);
const DESTRUCTIVE_TOOLS = new Set([
  "delete_element", "delete_mesh_elements", "remove_armature", "remove_armature_bone", "clear_vertex_weights",
  "clear_material_instances", "undo", "redo", "risky_eval", "manage_animation", "replace_texture",
  "eraser_tool", "knife_tool", "merge_mesh_vertices",
]);
const toolAnnotations = (name: string) =>
  READ_ONLY_TOOLS.has(name)
    ? { readOnlyHint: true, openWorldHint: false }
    : {
        readOnlyHint: false,
        destructiveHint: DESTRUCTIVE_TOOLS.has(name) || !/^(create_|add_|register_|place_|duplicate_|save_checkpoint$)/.test(name),
        openWorldHint: name === "from_geo_json", // the only tool that can reach the network
      };

const server = new McpServer(
  { name: "blockbench-mcp", version: SERVER_VERSION },
  instructions ? { instructions } : undefined
);

// Every registerTool below goes through here: tools hidden by the profile are
// simply not registered, and the rest get their annotations.
const notLoaded: string[] = [];
const registerToolUnfiltered = server.registerTool.bind(server);
(server as any).registerTool = (name: string, config: any, cb: any) => {
  if (PROFILE !== "full" && GECKOLIB_HIDDEN.has(name)) { notLoaded.push(name); return undefined; }
  return registerToolUnfiltered(name, { ...config, annotations: { ...toolAnnotations(name), ...config.annotations } }, cb);
};

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
      uv_offset: z
        .array(z.number())
        .length(2)
        .optional()
        .describe("Box-UV offset [u,v] on the atlas. Setting it locks the cube to autouv:0 so it sticks (avoids the 'everything one colour' collapse) — saves a follow-up modify_cube call."),
      autouv: z.enum(["0", "1", "2"]).optional().describe("Auto UV: 0 off (manual box-UV), 1 on (default), 2 relative."),
    },
  },
  async (args) => forward("create_cube", args, (r) => `Created cube "${r.name ?? args.name ?? "cube"}".${warningLines(r)}`)
);

server.registerTool(
  "create_cubes",
  {
    title: "Create Cubes (batch)",
    description:
      "Create a whole sub-hierarchy — many groups/bones AND cubes — in ONE call and ONE undo step. " +
      "This is the efficient way to build geometry: a 25-cube model goes from ~50 tool calls to 1. " +
      "Groups are created first (in array order), then cubes; a parent may reference a group declared " +
      "EARLIER in groups[] or one that already exists. Same per-element rules as create_cube/create_group " +
      "(unique names, single-axis via nesting, optional box-UV offset). The batch is validated up front and " +
      "is ALL-OR-NOTHING: if anything is invalid, nothing is created.",
    inputSchema: {
      groups: z
        .array(
          z.object({
            name: z.string().describe("Unique, descriptive bone name."),
            parent: z.string().optional().describe("Parent group: a name from earlier in groups[] or an existing group."),
            origin: vec3.optional().describe("Pivot/origin [x,y,z] (define before rotating)."),
          })
        )
        .optional()
        .describe("Groups/bones to create, in dependency order (parents before children)."),
      cubes: z
        .array(
          z.object({
            name: z.string().optional().describe("Unique, descriptive name. Auto-generated if omitted."),
            from: vec3.optional().describe("Lower corner [x,y,z]. Default [0,0,0]."),
            to: vec3.optional().describe("Upper corner [x,y,z]. If omitted, derived from 'from' + 'size'."),
            size: z.number().optional().describe("Edge length when 'to' is omitted. Default 8."),
            origin: vec3.optional().describe("Pivot [x,y,z]. Default 'from'."),
            parent: z.string().optional().describe("Group to nest under: a name from groups[] or an existing group."),
            uv_offset: z.array(z.number()).length(2).optional().describe("Box-UV offset [u,v] (locks autouv:0 so it sticks)."),
            autouv: z.enum(["0", "1", "2"]).optional().describe("Auto UV: 0 off, 1 on (default), 2 relative."),
          })
        )
        .optional()
        .describe("Cubes to create. Each may nest under a group from groups[] or an existing one."),
    },
  },
  async (args) =>
    forward("create_cubes", args, (r) =>
      `Created ${(r.groups || []).length} group(s) + ${(r.cubes || []).length} cube(s).` +
      ((r.groups || []).length ? ` Groups: ${(r.groups || []).join(", ")}.` : "") +
      ((r.cubes || []).length ? ` Cubes: ${(r.cubes || []).join(", ")}.` : "") +
      warningLines(r)
    )
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
      "registered textures, as JSON. Use before acting to verify state (rule #3/#8). On big models, narrow " +
      "the payload with the optional filters: `bone_names` returns ONLY those bones' subtrees, " +
      "`include_faces:false` drops per-cube face data, and `max_depth` caps nesting (a capped group reports " +
      "`truncated_children` so you can re-query that subtree). With no filters it returns the FULL tree.",
    inputSchema: {
      bone_names: z
        .array(z.string())
        .optional()
        .describe("Only return the subtrees rooted at these bone/group names. Omit for the whole tree."),
      include_faces: z
        .boolean()
        .optional()
        .describe("Include per-cube face/texture data. Default true; set false to shrink the payload when you only need geometry."),
      max_depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Max nesting depth below each returned root (0 = roots only). Capped groups report `truncated_children`. Omit for unlimited."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("get_scene_tree", args);
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
      "Apply a registered texture to a cube, a MESH, or a GROUP (all its descendant cubes+meshes in one " +
      "call). Uses Blockbench's native Texture.apply with proper selection-scoping and a face-level render " +
      "refresh. Fails if the texture is not registered or the target doesn't exist (rule #2). Note: cubes " +
      "with a manual box-UV offset (autouv:0, set via modify_cube) keep their atlas region; only auto-UV " +
      "cubes get repacked.",
    inputSchema: {
      target: z.string().describe("Cube/mesh name, or a group name to texture all its descendant cubes+meshes."),
      texture: z.string().describe("Registered texture name or id."),
      apply_mode: z
        .enum(["blank", "all", "none"])
        .optional()
        .describe("blank = only faces with no texture yet (default); all = every face; none = clear the texture."),
      faces: z
        .array(z.string())
        .optional()
        .describe("Limit to these face keys (north/south/east/west/up/down). Omit for the whole element."),
    },
  },
  async (args) =>
    forward("apply_texture", args, (r) =>
      `Applied texture "${r.texture}" to ${r.cubes ?? 1} cube(s)${r.meshes ? ` + ${r.meshes} mesh(es)` : ""} (${r.target}, mode: ${r.mode ?? "blank"}).`
    )
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

    // EARLY mesh warning: meshes in a cubes-only format (GeckoLib/Bedrock) won't
    // render in-game and are silently dropped on export — catch it now, not at export.
    const meshCount = ((r.tree as any) && (r.tree as any).mesh_count) || 0;
    const fmt = (r.tree as any) && (r.tree as any).format;
    const meshWarn = fmt && fmt.meshes === false && meshCount > 0
      ? `${meshCount} mesh element(s) present, but this format ("${fmt.id}") renders ONLY cubes — meshes won't show in-game and are silently dropped on export. Convert them to cubes.`
      : null;
    const totalWarnings = report.warnings.length + (meshWarn ? 1 : 0);

    const lines: string[] = [];
    lines.push(
      `Validation ${report.ok ? "PASSED ✅" : "FAILED ❌"} — ${report.errors.length} error(s), ${totalWarnings} warning(s).`
    );
    if (meshWarn) lines.push(`  [warn ] (mesh-in-box-format) ${meshWarn}`);
    for (const issue of report.issues) {
      const tag = issue.severity === "error" ? "ERROR" : "warn ";
      lines.push(`  [${tag}] (${issue.rule}) ${issue.message}`);
    }
    if (report.issues.length === 0 && !meshWarn) lines.push("  No issues found.");

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
      "animations (the single-axis rule applies to static model rotation, not keyframes). " +
      "Values are stored exactly as given — the same convention as set_keyframes / manage_keyframes / " +
      "get_keyframes and the Blockbench UI; the exporter converts to the GeckoLib/Bedrock file convention. " +
      "Rotations ADD to each bone's rest rotation.",
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
        // Spelled out: some clients flatten record schemas to a bare object, so the
        // shape must also be in the text (seen live 2026-09-23).
        .describe(
          "Keyframes per bone, keyed by existing group/bone name. Each bone maps to an ARRAY of " +
            "{ time, rotation?, position?, scale? }, e.g. { \"arm\": [{ \"time\": 0, \"rotation\": [0,0,0] }, " +
            "{ \"time\": 1, \"rotation\": [0,0,45] }] }."
        ),
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
      "The bone group must exist and the animation must exist (or be selected). The reply lists the " +
      "channel's stored keyframes, so no separate get_keyframes is needed. For several bones/channels at " +
      "once use set_keyframes. Values are stored as given (the Blockbench UI convention, shared by every " +
      "animation tool); the exporter converts to the GeckoLib file convention.",
    inputSchema: {
      animation_id: animationIdOptional,
      action: z.enum(["create", "delete", "edit", "select"]).describe("Action to perform."),
      bone_name: z.string().describe("Name of the bone/group."),
      channel: animationChannelEnum.describe("Animation channel."),
      keyframes: z.array(keyframeDataSchema).describe("Keyframe data for the action."),
    },
  },
  async (args) =>
    forward("manage_keyframes", args, (r) => {
      // The plugin reads the channel back after every write; show it, so a no-op
      // or wrong value is visible now instead of several rounds later.
      const miss = r.affected === 0
        ? (r.action === "create"
          ? `\n⚠️  No keyframe was created on ${r.bone}.${r.channel}.`
          : `\n⚠️  No keyframe matched the given time(s) on ${r.bone}.${r.channel} (±0.001 s) — nothing changed.`)
        : "";
      return `${r.action}: ${r.affected} keyframe(s) on ${r.bone}.${r.channel}.${miss}\nStored now: ${formatKeyframes(r.stored)}${lengthNote(r)}`;
    })
);

server.registerTool(
  "set_keyframes",
  {
    title: "Set Keyframes (batch)",
    description:
      "Write keyframes for MANY bones, channels and times in ONE call and ONE undo step — the fast way to key " +
      "or fix a whole pose or animation. Upsert: a keyframe already at that time (±0.001 s) is overwritten, " +
      "otherwise it is created. All entries are validated first; nothing is written if one is invalid. " +
      "`clear_first:true` empties each listed bone/channel before writing (rewrite a curve). Values are stored " +
      "as given — the same convention as every other animation tool and the Blockbench UI — and rotations ADD " +
      "to the bone's rest rotation. The reply lists every touched channel as stored.",
    inputSchema: {
      animation_id: animationIdOptional,
      keyframes: z
        .array(
          z.object({
            bone: z.string().describe("Bone/group name."),
            channel: animationChannelEnum.describe("rotation / position / scale."),
            time: z.number().min(0).describe("Seconds."),
            values: z.union([vec3, z.number()]).describe("[x,y,z] (degrees for rotation), or one number for uniform scale."),
            interpolation: interpolationEnum.optional().describe("Default linear."),
          })
        )
        .min(1)
        .describe("Keyframes to write, any order, any mix of bones and channels."),
      clear_first: z.boolean().optional().describe("Remove the existing keyframes of each listed bone/channel first."),
    },
  },
  async (args) =>
    forward("set_keyframes", args, (r) => {
      const channels = Object.entries(r.stored || {});
      const lines = channels.slice(0, 40).map(([key, kfs]) => `  ${key}: ${formatKeyframes(kfs as any[])}`);
      if (channels.length > 40) lines.push(`  … (+${channels.length - 40} more channels)`);
      return (
        `Set ${r.created + r.updated} keyframe(s) on ${r.animation}: ${r.created} created, ${r.updated} updated` +
        `${r.cleared ? `, ${r.cleared} cleared first` : ""}.\nStored now:\n${lines.join("\n")}${lengthNote(r)}`
      );
    })
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

server.registerTool(
  "manage_animation",
  {
    title: "Manage Animation (delete / rename / duplicate)",
    description:
      "Delete, rename or duplicate a WHOLE animation. A bare new_name gets the 'animation.' prefix. " +
      "duplicate copies every keyframe (e.g. make walk_fast from walk, then edit the copy).",
    inputSchema: {
      action: z.enum(["delete", "rename", "duplicate"]).describe("What to do with the animation."),
      animation_id: z.string().describe("Animation UUID, full name ('animation.walk') or short name ('walk')."),
      new_name: z.string().optional().describe("New name — required for rename and duplicate."),
    },
  },
  async (args) =>
    forward("manage_animation", args, (r) =>
      r.action === "delete"
        ? `Deleted animation "${r.name}" (${r.remaining} left).`
        : r.action === "rename"
          ? `Renamed "${r.previous_name}" to "${r.name}".`
          : `Duplicated "${r.source}" as "${r.name}" (uuid ${r.uuid}).`
    )
);

server.registerTool(
  "get_keyframes",
  {
    title: "Get Keyframes (read-back)",
    description:
      "Read back the ACTUALLY-STORED keyframe values — the values, not what you intended. One bone " +
      "(`bone_name`), several (`bone_names`), or omit both for EVERY animated bone in one call. Use it after " +
      "animation_copy_paste / create_animation, or to inspect an existing animation before editing it " +
      "(manage_keyframes and set_keyframes already echo what they stored). Returns per-channel " +
      "[{time, values:[x,y,z], interpolation}].",
    inputSchema: {
      bone_name: z.string().optional().describe("One bone/group name."),
      bone_names: z.array(z.string()).optional().describe("Several bone names; omit both for every animated bone."),
      animation_id: z.string().optional().describe("Animation UUID or name. Default: the selected animation."),
      channel: z.enum(["rotation", "position", "scale"]).optional().describe("One channel, or omit for all three."),
    },
  },
  async (args) => {
    let r: any;
    try { r = await sendToBlockbench("get_keyframes", args); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`get_keyframes failed: ${r.error}`);
    return ok(
      r.bones
        ? JSON.stringify({ animation: r.animation, bones: r.bones, ...(r.not_found ? { not_found: r.not_found } : {}) }, null, 2)
        : JSON.stringify({ animation: r.animation, bone: r.bone, has_animator: r.has_animator, channels: r.channels }, null, 2)
    );
  }
);

server.registerTool(
  "check_animation",
  {
    title: "Check Animation (lint)",
    description:
      "Check an animation in ONE call for the mistakes that otherwise take screenshot rounds: keyframes after " +
      "the end, rotation jumps above `max_jump` degrees (default 90) between neighbouring keyframes, looping " +
      "channels whose start and end differ (the loop pops), and keyframes on bones that no longer exist. With " +
      "`floor_y` (usually 0 for entities) it also samples the whole model over the animation and reports the " +
      "lowest point, when it happens, and how much to raise the model if it goes below the floor. Run it after " +
      "creating or editing an animation, before screenshots or export.",
    inputSchema: {
      animation_id: animationIdOptional,
      floor_y: z.number().optional().describe("Floor height to check against (e.g. 0). Omit to skip the floor check."),
      samples: z.number().int().min(2).max(200).optional().describe("Evenly spaced sample times for the floor check (default 24; keyframe times are always added)."),
      max_jump: z.number().min(1).optional().describe("Degrees between neighbouring rotation keyframes that count as suspicious (default 90)."),
    },
  },
  async (args) =>
    forward("check_animation", args, (r) => {
      const issues: any[] = r.issues || [];
      const head =
        `${r.animation} (${r.length}s, ${r.loop}): ${r.bones} animated bone(s), ${r.keyframes} keyframe(s) — ` +
        (issues.length ? `${issues.length} issue(s):` : "no issues found.");
      const lines = issues.slice(0, 40).map((i) => `  [${i.severity}] (${i.rule}) ${i.message}`);
      if (issues.length > 40) lines.push(`  … (+${issues.length - 40} more)`);
      const low = r.lowest ? `\nLowest point: y=${r.lowest.y} at ${r.lowest.time}s.` : "";
      return [head, ...lines].join("\n") + low;
    })
);

server.registerTool(
  "get_bone_pose",
  {
    title: "Get Bone Pose (measure rotation + world position)",
    description:
      "Measure a bone by NUMBER instead of guessing from a camera angle. Returns its local rotation/origin, " +
      "its world-space rotation (degrees), its world-space pivot POSITION, and `world_bbox` — the world-space " +
      "bounding box of the bone + all its descendant cubes, with `lowest_y`. Pass `time` to evaluate the " +
      "selected animation at that moment FIRST, so all values are for that animated frame. Two key uses: " +
      "(1) CALIBRATE rotation direction once (set a known +X, read world_rotation, note which way it tilts); " +
      "(2) GROUND-CLIPPING — `world_bbox.lowest_y` at a `time` tells numerically whether that bone dips below " +
      "the floor. For the WHOLE model over the WHOLE animation use check_animation with `floor_y` instead. " +
      "Coordinates are Blockbench scene/world space (entity models usually stand on y=0).",
    inputSchema: {
      bone_name: z.string().describe("Bone/group name."),
      time: z.number().optional().describe("Seconds — evaluate the selected animation at this time before measuring."),
    },
  },
  async (args) => {
    let r: any;
    try { r = await sendToBlockbench("get_bone_pose", args); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`get_bone_pose failed: ${r.error}`);
    return ok(JSON.stringify({ bone: r.bone, time: r.time, local_rotation: r.local_rotation, world_rotation: r.world_rotation, world_position: r.world_position, world_bbox: r.world_bbox, origin: r.origin }, null, 2));
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
      "rotate that. Corners are normalized so the box is never inverted. `cube_name` is accepted as a " +
      "deprecated alias for `id` for older callers.",
    inputSchema: modifyCubeInputSchema,
  },
  async (args) =>
    forward("modify_cube", { ...args, id: args.id ?? args.cube_name }, (r) => `Modified cube "${r.name}" (from [${r.from}] to [${r.to}]).${warningLines(r)}`)
);

server.registerTool(
  "modify_cubes",
  {
    title: "Modify Cubes (batch)",
    description:
      "Edit MANY cubes in ONE call and ONE undo step — e.g. give every cube its own uv_offset, or resize a set " +
      "of parts. Each entry takes the same fields as modify_cube (`id` plus what to change). All entries are " +
      "validated first (existing cubes, unique names, valid vectors); if one is invalid nothing changes. " +
      "Rotation is not accepted (group-only).",
    inputSchema: {
      cubes: z
        .array(z.object(modifyCubeInputSchema))
        .min(1)
        .describe("One entry per cube: id + the fields to change (from/to/origin/name/uv_offset/autouv/…)."),
    },
  },
  async (args) =>
    forward("modify_cubes", { cubes: (args.cubes || []).map((c: any) => ({ ...c, id: c.id ?? c.cube_name })) }, (r) => {
      const names = (r.cubes || []).map((c: any) => c.name);
      return `Modified ${names.length} cube(s): ${names.slice(0, 30).join(", ")}${names.length > 30 ? ", …" : ""}.${warningLines(r)}`;
    })
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
    return ok(JSON.stringify({ ...r.info, mcp_bridge: bridgeInfo() }, null, 2));
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

server.registerTool(
  "create_project",
  {
    title: "Create Project",
    description:
      "Create a NEW Blockbench project in a given format (opens a new tab; the current project stays open). " +
      "Use it when the open project has the wrong format — e.g. 'free' or Java instead of GeckoLib/Bedrock — " +
      "instead of risky_eval. Aliases: 'geckolib', 'bedrock', 'java'; an unknown id returns the available list. " +
      "Optionally set name, model_identifier (geometry.<id>) and texture size in the same call.",
    inputSchema: {
      format: z.string().describe("Format id or alias: 'geckolib', 'bedrock', 'java', 'free', or any Blockbench format id."),
      name: z.string().optional().describe("Project name."),
      model_identifier: z.string().optional().describe("Geometry identifier, e.g. 'dagger' → geometry.dagger."),
      texture_width: z.number().int().min(1).optional().describe("Texture atlas width."),
      texture_height: z.number().int().min(1).optional().describe("Texture atlas height."),
    },
  },
  async (args) =>
    forward("create_project", args, (r) =>
      `Created ${r.format} project "${r.name ?? ""}" (animations: ${r.animation_mode ? "yes" : "no"}, ` +
      `geometry identifier: ${r.model_identifier ?? "(none)"}, texture ${r.texture?.[0] ?? "?"}x${r.texture?.[1] ?? "?"}).`
    )
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
      layers: z.boolean().optional().describe("Enable texture layers so paint passes can be non-destructive (target them with the paint tools' `layer` arg)."),
    },
  },
  async (args) => forward("create_texture", args, (r) => `Created texture "${r.name}" (${r.width}x${r.height}, id ${r.id}).`)
);

server.registerTool(
  "replace_texture",
  {
    title: "Replace Texture Image",
    description:
      "Replace the IMAGE of an existing texture from a PNG data URL or an absolute file path, keeping the " +
      "texture itself (name, uuid, every face mapped to it). Use it to restore a lost/broken atlas or swap in " +
      "an externally painted one — one undoable step. The texture size follows the new image.",
    inputSchema: {
      texture: z.string().describe("Existing texture name/uuid/id (see list_textures)."),
      data: z.string().describe("PNG data URL ('data:image/png;base64,…') or absolute file path."),
    },
  },
  async (args) => forward("replace_texture", args, (r) => `Replaced the image of texture "${r.name}" (from ${r.source === "path" ? "file" : "data URL"}).`)
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
      "visual results (geometry, textures) directly instead of relying on the user's viewport. To verify an " +
      "ANIMATION frame, pass `time` (seconds) — the tool evaluates the animation at that moment right before " +
      "rendering, so you get the posed frame, NOT the rest pose (without it, a screenshot after animation_timeline " +
      "set_time can race the timeline and show the bind pose). Pass `animation_id` to pick which animation. " +
      "Images are downscaled to `max_size` px (default 800) — ask for more only when you need fine detail.",
    inputSchema: {
      project: z.string().optional().describe("Project name/uuid; default the open one."),
      time: z.number().optional().describe("Seconds — evaluate the animation at this moment before rendering (for posed/animation frames)."),
      animation_id: z.string().optional().describe("Animation UUID or name to evaluate at `time`. Default: the selected animation."),
      max_size: screenshotMaxSize,
    },
  },
  async (args) => forwardImage("capture_screenshot", args)
);

server.registerTool(
  "capture_app_screenshot",
  {
    title: "Capture App Screenshot",
    description: "Return a screenshot of the whole Blockbench application window (desktop only), downscaled to `max_size` px (default 800).",
    inputSchema: { max_size: screenshotMaxSize },
  },
  async (args) => forwardImage("capture_app_screenshot", args)
);

server.registerTool(
  "set_camera_angle",
  {
    title: "Set Camera Angle",
    description:
      "Position the preview camera (position, optional target/rotation, projection). Returns the resulting " +
      "screenshot unless `screenshot:false` — use false when you only move the camera, to skip reading an " +
      "extra image. Pass `time` (and optionally `animation_id`) to render that ANIMATION frame instead of the " +
      "current pose — one call for 'this angle, this frame'.",
    inputSchema: {
      position: vec3.describe("Camera position [x,y,z]."),
      target: vec3.optional().describe("Look-at target [x,y,z]."),
      rotation: vec3.optional().describe("Camera rotation [x,y,z]."),
      projection: z.enum(["unset", "orthographic", "perspective"]).describe("Projection type."),
      screenshot: z.boolean().optional().describe("Return a screenshot after moving the camera (default true)."),
      time: z.number().optional().describe("Seconds — evaluate the animation at this moment before rendering."),
      animation_id: z.string().optional().describe("Animation UUID or name for `time`. Default: the selected (or only) animation."),
      max_size: screenshotMaxSize,
    },
  },
  async (args) => forwardImageOrText("set_camera_angle", args, (r) => r.message || "Camera set.")
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
      layer: z.string().optional().describe("TextureLayer name to paint into (non-destructive; created if missing). Omit to paint the flat texture."),
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
      layer: z.string().optional().describe("TextureLayer name to draw into (non-destructive; created if missing). Omit to draw on the flat texture."),
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
      layer: z.string().optional().describe("TextureLayer name to draw the gradient into (non-destructive; created if missing). Omit for the flat texture."),
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
      layer: z.string().optional().describe("TextureLayer name to paint this matrix into (non-destructive; created if missing). Great for separate shade/highlight passes. Omit for the flat texture."),
    },
  },
  async (args) =>
    forward("paint_pixel_matrix", args, (r) => `Painted ${r.painted}px with "${r.palette}" at [${r.origin}] (size ${r.size?.[0]}x${r.size?.[1]}) on "${r.texture}".`)
);

// auto_shade was REMOVED 2026-06-16 (user request): it was a procedural
// palette/ramp shader that applied the same formulaic gradient+AO+noise to every
// cube, so it always looked the same and could never match a reference. Texture
// instead with exact colours via the paint tools (paint_fill_tool / draw_shape_tool
// / gradient_tool / paint_pixel_matrix — all take real hex), after pack_uv + validate_uv.

server.registerTool(
  "pack_uv",
  {
    title: "Pack UV / Fit Texture to Model",
    description:
      "Give EVERY cube its own non-overlapping atlas region and resize the texture to fit the model. This is " +
      "the fix for the #1 texturing failure: by default all cubes' UVs sit at [0,0] and overlap, so every " +
      "paint pass overwrites the others → a garbled texture, and the atlas is far bigger than the " +
      "model actually uses. pack_uv shelf-packs each cube's box-UV net into its own spot (setting uv_offset+" +
      "autouv:0 AND the explicit per-face UV rects, so it works in box-UV and per-face/GeckoLib formats alike) " +
      "and shrinks the texture to the packed size. **Run this right after building geometry and BEFORE " +
      "create_texture / apply_texture / painting.** Then create_texture (no size = uses the fitted size), " +
      "apply_texture, and paint each cube's region (paint tools take real hex) — now each lands in its own region with no bleed.",
    inputSchema: {
      target: z.string().optional().describe("Group name (packs its descendant cubes) or a single cube. Omit to pack ALL cubes."),
      padding: z.number().int().min(0).max(8).optional().describe("Pixel gap between nets (default 1)."),
      power_of_two: z.boolean().optional().describe("Round the fitted texture size up to a power of two (default false = exact fit)."),
      resize_texture: z.boolean().optional().describe("Resize the project texture to the packed bounds (default true)."),
    },
  },
  async (args) =>
    forward("pack_uv", args, (r) =>
      `Packed ${r.cubes} cube(s) into a ${r.texture_width}x${r.texture_height} atlas (content ${r.packed_width}x${r.packed_height}, box_uv: ${r.box_uv}).` +
      (r.warning ? `\n⚠️  ${r.warning}` : ` Now create_texture (no size), apply_texture, then paint each cube's region with the paint tools.`)
    )
);

server.registerTool(
  "validate_uv",
  {
    title: "Validate UV Layout",
    description:
      "Check the UV layout BEFORE painting. Detects the #1 texturing failure — multiple cubes " +
      "sharing the same atlas area (overlapping UVs), so paint passes overwrite each other and the texture " +
      "comes out smeared/blotchy — plus out-of-bounds, null, and zero-size UVs. Reports the UV mode " +
      "(box_uv / per_face / mixed), cube & face counts, texture size, and a `valid` verdict. If not valid, run " +
      "pack_uv and re-validate. Works for box-UV and per-face/GeckoLib models. ALWAYS validate before texturing.",
    inputSchema: {
      target: z.string().optional().describe("Group name (its descendant cubes) or a single cube. Omit to validate ALL cubes."),
    },
  },
  async (args) =>
    forward("validate_uv", args, (r) =>
      `UV ${r.valid ? "VALID ✅" : "INVALID ❌"} — ${r.cubes} cube(s) / ${r.faces} face(s), mode: ${r.uv_mode}, atlas ${r.texture?.[0]}x${r.texture?.[1]}. ` +
      `overlaps:${r.overlaps} out_of_bounds:${r.out_of_bounds} null:${r.null_uv} zero_size:${r.zero_size_uv}.` +
      (r.overlaps ? `\nOverlapping cubes: ${(r.overlapping_pairs || []).join(", ")}` : "") +
      `\n${r.recommendation}`
    )
);

server.registerTool(
  "shade_cube",
  {
    title: "Shade Cube (exact colour)",
    description:
      "Paint a cube's faces with CLEAN directional shading from ONE exact colour — top face lit, sides a " +
      "top→bottom gradient, bottom in shadow — with NO palette lock and NO procedural noise. This is the " +
      "reliable way to texture to a reference colour (the per-cube logic behind a good hand-made skin, as a " +
      "tool). Give `cube_id` (one cube) or `target` (a group → all its cubes, same colour) plus `color` (one " +
      "hex → auto hue-shifted ramp) or `colors` (5 hex shadow→highlight). Run pack_uv + validate_uv FIRST so " +
      "each cube has its own UV region (otherwise cubes overwrite each other).",
    inputSchema: {
      cube_id: z.string().optional().describe("One cube name/uuid to shade."),
      target: z.string().optional().describe("Group name → shade all its descendant cubes the same colour (use instead of cube_id)."),
      color: z.string().optional().describe("⭐ One hex (e.g. '#cc2233') → clean hue-shifted ramp, your colour at the mid. The normal way to hit a reference colour."),
      colors: z.array(z.string()).min(5).max(5).optional().describe("Full control: 5 hex [shadow → highlight]. Overrides color."),
      edge_color: z.string().optional().describe("Optional hex for the thin east/west faces (e.g. a dark blade outline / cutting edge)."),
      sheen: z.boolean().optional().describe("Add a brighter centre stripe on the broad north/south faces (blade sheen / blood-groove look)."),
      texture_id: z.string().optional().describe("Texture name/uuid; default the active texture."),
      layer: z.string().optional().describe("TextureLayer name to paint into (non-destructive; created if missing)."),
    },
  },
  async (args) =>
    forward("shade_cube", args, (r) =>
      `Shaded ${r.cubes} cube(s) (${r.painted}px) on "${r.texture}"${r.layer ? ` (layer ${r.layer})` : ""}. Ramp: ${(r.ramp || []).join(" ")}`
    )
);

server.registerTool(
  "shade_cubes",
  {
    title: "Shade Cubes (batch, exact colours)",
    description:
      "Texture a whole model in ONE call: a list of parts, each with its own exact colour, painted with the same " +
      "clean directional shading as shade_cube, in a single texture edit and undo step. Each item: `cube_id` or " +
      "`target` (group) + `color` (one hex) or `colors` (5 hex), optional `edge_color` / `sheen`. Items are " +
      "validated first (nothing is painted if one is invalid) and painted in order. Run pack_uv + validate_uv first.",
    inputSchema: {
      items: z
        .array(
          z.object({
            cube_id: z.string().optional().describe("One cube name/uuid."),
            target: z.string().optional().describe("Group name → all its descendant cubes."),
            color: z.string().optional().describe("One hex → clean hue-shifted ramp."),
            colors: z.array(z.string()).min(5).max(5).optional().describe("5 hex [shadow → highlight]; overrides color."),
            edge_color: z.string().optional().describe("Hex for the thin east/west faces (e.g. a blade edge)."),
            sheen: z.boolean().optional().describe("Brighter centre stripe on the broad north/south faces."),
          })
        )
        .min(1)
        .describe("Parts to shade, in paint order."),
      texture_id: z.string().optional().describe("Texture name/uuid; default the active texture."),
      layer: z.string().optional().describe("TextureLayer name to paint into (non-destructive; created if missing)."),
    },
  },
  async (args) =>
    forward("shade_cubes", args, (r) =>
      `Shaded ${r.items} part(s) / ${r.cubes} cube(s) (${r.painted}px) on "${r.texture}"${r.layer ? ` (layer ${r.layer})` : ""}:\n` +
      (r.results || []).map((x: any) => `  ${x.target}: ${x.cubes} cube(s), ${x.painted}px${x.painted ? "" : "  ⚠️ nothing painted — no UV region?"}`).join("\n")
    )
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
  "list_actions",
  {
    title: "List Actions",
    description:
      "List the Blockbench BarItems action ids you can pass to trigger_action — the discovery companion so " +
      "you don't have to guess action strings. Filter with `search` (matches id / name / description; e.g. " +
      "'export', 'cube'). Each entry has id, name, description, type, keybind, and a `triggerable` flag.",
    inputSchema: {
      search: z.string().optional().describe("Case-insensitive substring matched against id/name/description."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max actions to return. Default 200."),
    },
  },
  async (args) => {
    let r: any;
    try { r = await sendToBlockbench("list_actions", args); } catch (e: any) { return fail(e?.message || String(e)); }
    if (r && r.ok === false) return fail(`list_actions failed: ${r.error}`);
    return ok(JSON.stringify({ count: r.count, truncated: r.truncated, actions: r.actions }, null, 2));
  }
);

server.registerTool(
  "trigger_action",
  {
    title: "Trigger Action",
    description:
      "Trigger any Blockbench action by its BarItems id (e.g. 'add_cube', 'export_over'). Returns an app " +
      "screenshot. Powerful escape hatch for actions without a dedicated MCP tool. Discover valid ids with " +
      "list_actions (it won't guess for you).",
    inputSchema: {
      action: z.string().describe("BarItems action id (find it with list_actions)."),
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
  // The listening bridge would keep the process alive after its client quits, holding
  // the port as an orphan. Exit instead, so a relay can take over right away.
  process.stdin.once("end", () => {
    log("Client closed the connection — shutting down.");
    process.exit(0);
  });
  // The full tool list is what the client receives via tools/list; don't keep a
  // hand-maintained copy here (it went stale as tools were added).
  log(
    `MCP server ready (stdio). Tool profile: ${PROFILE}` +
      (notLoaded.length ? ` — ${notLoaded.length} tools not loaded (set BLOCKBENCH_MCP_PROFILE=full to load all).` : ".")
  );
  if (skills.dir) log(`Loaded ${skills.skills.length} skill guide(s) from ${skills.dir}: ${skills.skills.map((s) => s.name).join(", ")}`);
  else log("No skills directory found — skill guides are not available.");
}

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
