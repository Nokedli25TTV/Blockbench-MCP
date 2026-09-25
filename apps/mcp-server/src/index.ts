import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server as IOServer, Socket } from "socket.io";
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from "http";
import { readFileSync, statSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolType, SceneTree, SceneTexture } from "../../../packages/shared/src/types";
import { validateScene, buildReport } from "../../../packages/shared/src/validation";
import { PALETTES, PALETTE_NAMES, PALETTE_INDEX_ROLES, getPalette } from "../../../packages/shared/src/palettes";
import { MATERIALS } from "../../../packages/shared/src/facePainter";
import { SIDES, ALIGNS, ANCHORS, boxCenter } from "../../../packages/shared/src/placement";
import type { Box } from "../../../packages/shared/src/placement";
import { boxRelation, relationText, boxSize } from "../../../packages/shared/src/measure";
import { VIEWS } from "../../../packages/shared/src/views";
import { outlineText } from "../../../packages/shared/src/outline";
import { planSpec, sceneBoxes } from "../../../packages/shared/src/spec";
import { findRig, planWalk, planIdle } from "../../../packages/shared/src/gaits";
import { BUNDLE_KINDS, BUNDLE_PARTS, DEFAULTED_MODEL, geckolibFor, bundlePaths, bundleName, resourceNameError, pickTexture } from "../../../packages/shared/src/modAssets";
import type { BundleKind, BundlePart } from "../../../packages/shared/src/modAssets";
import { loadSkills, buildInstructions, getSkillContent } from "./skills";

// The Blockbench plugin connects to 9999 by default; tests override this with
// MCP_BRIDGE_PORT so they run on an isolated port and never hijack (or get
// hijacked by) a real Blockbench instance listening on 9999.
const PORT = Number(process.env.MCP_BRIDGE_PORT) || 9999;
// Minecraft version a new Java block/item project targets unless the caller names one:
// it decides the rotation rules (1.20.1 → one axis at 22.5° steps). This fork's mods are 1.20.1.
const DEFAULT_MC_VERSION = process.env.BLOCKBENCH_MCP_MC_VERSION || "1.20.1";
// Single source of truth: apps/mcp-server/package.json (bundled by esbuild; the
// plugin takes its version from its own package.json; `pnpm bump` moves all in step).
import { version as SERVER_VERSION } from "../package.json";

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
  // Replies carry whole files (export_bundle) and images. Above Socket.IO's default 1 MB the
  // plugin's connection was closed and the call timed out; same cap as the relay endpoint.
  maxHttpBufferSize: 64 * 1024 * 1024,
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
  measure: 20_000,
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
  if (m.includes("multi-axis") || m.includes("cannot be rotated") || m.includes("rotated on") || m.includes("rotation not allowed") ||
      m.includes("rotation uses") || m.includes("° is not accepted")) return "ILLEGAL_ROTATION";
  if (m.includes("range this format allows")) return "OUT_OF_RANGE";
  if (m.includes("not registered") || m.includes("missing texture")) return "MISSING_TEXTURE";
  if (m.includes("not found") || m.includes("could not find")) return "NOT_FOUND";
  if (m.includes("does not support") || m.includes("not compatible") || m.includes("renders only cubes") || m.includes("unsupported")) return "FORMAT_UNSUPPORTED";
  if (m.includes(" uv") || m.includes("overlap")) return "UV_ERROR";
  if (m.includes("finite numbers") || m.includes("must be") || m.includes("required") || m.includes("inverted") || m.includes("invalid")) return "INVALID_INPUT";
  return "ERROR";
}
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text: `[${errorCode(text)}] ${text}` }] });
// A world bounding box as "[x,y,z]→[x,y,z]".
const boxText = (b: any): string => (b && b.min && b.max ? `[${b.min.join(", ")}]→[${b.max.join(", ")}]` : "(no geometry)");
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
// place_relative / create_from_spec: one alignment for both other axes, or per axis.
const alignSchema = z.union([
  z.enum(ALIGNS),
  z.object({ x: z.enum(ALIGNS).optional(), y: z.enum(ALIGNS).optional(), z: z.enum(ALIGNS).optional() }),
]);
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
  rotation: vec3.optional().describe("New rotation [x,y,z] degrees, where the format rotates cubes."),
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
  "get_bone_pose", "measure", "check_animation", "list_export_formats", "list_textures", "get_texture", "find_elements_by_criteria",
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
// simply not registered, and the rest get their annotations. Each handler is kept with its
// input shape, so run_batch can call it exactly like a direct call.
const notLoaded: string[] = [];
const toolHandlers = new Map<string, { shape: Record<string, z.ZodTypeAny>; cb: (args: any, extra: any) => Promise<any> }>();
const registerToolUnfiltered = server.registerTool.bind(server);
(server as any).registerTool = (name: string, config: any, cb: any) => {
  if (PROFILE !== "full" && GECKOLIB_HIDDEN.has(name)) { notLoaded.push(name); return undefined; }
  toolHandlers.set(name, { shape: config.inputSchema || {}, cb });
  return registerToolUnfiltered(name, { ...config, annotations: { ...toolAnnotations(name), ...config.annotations } }, cb);
};

// Where rotation may go — repeated in every tool that sets it (MODELING_CONSTRAINTS.md rule 1,
// packages/shared/src/formatRules.ts).
const ROTATION_RULES =
  "Rotation follows the open project's format (get_project_info → rules): GeckoLib/Bedrock — bones and cubes on " +
  "any axes (static cube rotation is fine; anything that animates needs its own bone); Java block/item — cubes " +
  "only (groups don't export rotation), and for Minecraft 1.9–1.21.5 one axis at -45/-22.5/0/22.5/45°, " +
  "coordinates -16..32.";

server.registerTool(
  "create_cube",
  {
    title: "Create Cube",
    description:
      "Create a cuboid in the open Blockbench model. Units are model units (16 = 1 block). " +
      ROTATION_RULES + " Names must be UNIQUE and descriptive.",
    inputSchema: {
      name: z.string().optional().describe("Unique, descriptive outliner name, e.g. 'staff_handle'."),
      from: vec3.optional().describe("Lower corner [x,y,z]. Default [0,0,0]."),
      to: vec3.optional().describe("Upper corner [x,y,z]. If omitted, derived from 'from' + 'size'."),
      size: z.number().optional().describe("Edge length when 'to' is omitted. Default 8."),
      origin: vec3.optional().describe("Pivot [x,y,z]. Default 'from' (a corner) — set the centre for a centred tilt."),
      rotation: vec3.optional().describe("Cube rotation [x,y,z] degrees, where the format allows it (see description)."),
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
      "(unique names, optional box-UV offset, rotation where the format allows it). The batch is validated up " +
      "front and is ALL-OR-NOTHING: if anything is invalid, nothing is created. " + ROTATION_RULES,
    inputSchema: {
      groups: z
        .array(
          z.object({
            name: z.string().describe("Unique, descriptive bone name."),
            parent: z.string().optional().describe("Parent group: a name from earlier in groups[] or an existing group."),
            origin: vec3.optional().describe("Pivot/origin [x,y,z] (define before rotating)."),
            rotation: vec3.optional().describe("Bone rotation [x,y,z] degrees (GeckoLib/Bedrock; not exported in Java block/item)."),
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
            origin: vec3.optional().describe("Pivot [x,y,z]. Default 'from' (a corner)."),
            rotation: vec3.optional().describe("Cube rotation [x,y,z] degrees, where the format allows it."),
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

// A whole rig from a part list: planned in the server (packages/shared/src/spec.ts) and built
// with ONE create_cubes call — one undo step, all-or-nothing.
server.registerTool(
  "create_from_spec",
  {
    title: "Create From Spec",
    description:
      "Build a whole rig from a list of parts in ONE call (one undo step, all-or-nothing). Each part becomes " +
      "a bone (group) holding one cube. Give its size and either `attach` it to an earlier part or an " +
      "existing element (side on_top / below / left / right / front / back / inside, gap, align, offset — as " +
      "place_relative) or an explicit `from` corner (default: centred on the origin, standing on y = 0). " +
      "`pivot`: an anchor of the part's own box — center (default), top (shoulder, hip, neck), bottom, left, " +
      "right, front, back — or a point. `mirror: \"x\"` also builds the left↔right twin: names swapped " +
      "(arm_left → arm_right), positions, pivots and rotations mirrored, and its children go under the twin. " +
      "Positions are computed at rest, before rotations. The model faces north: front = −Z, its own left = −X. " +
      "`dry_run` shows the plan. Afterwards run pack_uv.",
    inputSchema: {
      parts: z
        .array(z.object({
          name: z.string().describe("Bone name, e.g. 'arm_left'."),
          size: vec3.describe("The part's cube size [w, h, d]."),
          parent: z.string().optional().describe("Parent bone: an earlier part or an existing group."),
          attach: z.object({
            to: z.string().describe("An earlier part or an existing group/cube."),
            side: z.enum(SIDES).describe("on_top, below, left (−X), right (+X), front (−Z), back (+Z), inside."),
            gap: z.number().optional().describe("Space between them (default 0; negative = sunk in)."),
            align: alignSchema.optional().describe("On the other axes: center (default), min, max, keep — or per axis, e.g. { y: \"min\" }."),
            offset: vec3.optional().describe("Extra nudge [x,y,z]."),
          }).optional().describe("Rest the part against another one."),
          from: vec3.optional().describe("Or: the cube's lower corner [x,y,z]."),
          pivot: z.union([z.enum(ANCHORS), vec3]).optional().describe("Anchor of the part's box (default center) or [x,y,z]."),
          rotation: vec3.optional().describe("Bone rotation [x,y,z] degrees, where the format allows it."),
          mirror: z.enum(["x"]).optional().describe("Also build the mirrored twin (left ↔ right)."),
          cube_name: z.string().optional().describe("The cube's name (default '<name>_cube')."),
        }))
        .min(1)
        .max(64)
        .describe("Parts in order: attach targets and parents before the parts that use them."),
      dry_run: z.boolean().optional().describe("Only show the plan; create nothing."),
    },
  },
  async (args) => {
    let tree: any;
    try {
      const r: any = await sendToBlockbench("get_scene_tree", { include_faces: false });
      if (r && r.ok === false) return fail(`create_from_spec failed: ${r.error}`);
      tree = r.tree;
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    const groupNames = new Set<string>();
    const walk = (nodes: any[]) => nodes.forEach((n) => { if (n.type === "group") { groupNames.add(n.name); walk(n.children || []); } });
    walk(tree?.roots || []);
    const plan = planSpec(args.parts as any, sceneBoxes(tree || { roots: [] }), groupNames, tree?.format?.id === "java_block" ? 8 : 0);
    if ("error" in plan) return fail(`create_from_spec failed: ${plan.error}`);
    const cubeOf = new Map(plan.cubes.map((c) => [c.parent, c]));
    const lines = plan.groups.map((g) => {
      const c = cubeOf.get(g.name)!;
      return `${g.name}/${g.parent ? ` (in ${g.parent})` : ""}  pivot [${g.origin.join(", ")}]${g.rotation ? `  rot [${g.rotation.join(", ")}]` : ""}  →  ${c.name} [${c.from.join(", ")}]→[${c.to.join(", ")}]`;
    });
    if (args.dry_run) return ok(`Plan (nothing created): ${plan.groups.length} bone(s), ${plan.cubes.length} cube(s).\n${lines.join("\n")}`);
    return forward("create_cubes", { groups: plan.groups, cubes: plan.cubes }, (r) =>
      `Built ${(r.groups || []).length} bone(s) with ${(r.cubes || []).length} cube(s) in one undo step:\n${lines.join("\n")}` +
      warningLines(r) + "\nNext: pack_uv (then validate_uv) before texturing.");
  }
);

server.registerTool(
  "create_group",
  {
    title: "Create Group / Bone",
    description:
      "Create a named group (GeckoLib bone). Optionally nest under an existing parent group by name. " +
      "Use one group per independently-animating part (rule #6). Names must be unique. " + ROTATION_RULES,
    inputSchema: {
      name: z.string().describe("Unique, descriptive bone name, e.g. 'crystal_x'."),
      parent: z.string().optional().describe("Name of an existing parent group to nest under."),
      origin: vec3.optional().describe("Pivot/origin [x,y,z] for this bone (define before rotating)."),
      rotation: vec3.optional().describe("Bone rotation [x,y,z] degrees, where the format allows it."),
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
    title: "Set Origin (Pivot)",
    description:
      "Set the pivot/origin of a group (bone) — or of a cube, in formats where cubes rotate (e.g. Java " +
      "block/item, where the rotation lives on the cube). Define the pivot BEFORE rotating (rule #1). " +
      "Give `origin` [x,y,z], or `anchor` to take it from the part's own geometry: its centre, or the " +
      "centre of its top / bottom / left (−X) / right (+X) / front (−Z) / back (+Z) side — an arm's " +
      "shoulder is anchor \"top\", a door's hinge a side.",
    inputSchema: {
      target: z.string().describe("Name of the group (or cube) whose pivot to set."),
      origin: vec3.optional().describe("Pivot point [x,y,z] (or use anchor)."),
      anchor: z.enum(ANCHORS).optional().describe("Pivot from the part's own geometry: center | top | bottom | left | right | front | back."),
    },
  },
  async (args) =>
    forward("set_origin", args, (r) =>
      `Set origin of "${r.name}" to [${(r.origin || []).join(", ")}]${r.anchor ? ` (${r.anchor} of its geometry)` : ""}.` + warningLines(r))
);

server.registerTool(
  "set_rotation",
  {
    title: "Set Rotation",
    description:
      "Rotate a group (bone) or a cube. Set the pivot first (set_origin). " + ROTATION_RULES +
      " A rotation the format can't export is refused with the reason.",
    inputSchema: {
      target: z.string().describe("Name of the group or cube to rotate."),
      rotation: vec3.describe("Euler degrees [x,y,z]."),
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
      "`truncated_children` so you can re-query that subtree). With no filters it returns the FULL tree. " +
      "`format: \"outline\"` returns one line per group/cube instead (name, pivot, rotation, from→to, size, " +
      "box-UV offset) — a fraction of the JSON; use it to get oriented on a model.",
    inputSchema: {
      format: z.enum(["json", "outline"]).optional().describe("json (default) or outline: one compact line per group/cube, no face data."),
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
    const { format, ...rest } = args as any;
    if (format === "outline" && rest.include_faces === undefined) rest.include_faces = false;
    let r: any;
    try {
      r = await sendToBlockbench("get_scene_tree", rest);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`get_scene_tree failed: ${r.error}`);
    return ok(format === "outline" ? outlineText(r.tree) : JSON.stringify(r.tree, null, 2));
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

// Formats whose models ship as Bedrock geometry — what GeckoLib loads (export_bundle).
const BUNDLE_FORMATS = new Set(["geckolib_model", "animated_entity_model", "bedrock"]);

// Meshes in a cubes-only format (GeckoLib/Bedrock) don't render in-game and are silently
// dropped on export — said by validate_model, and an error in the export preflight.
const meshWarning = (tree: any): string | null => {
  const fmt = tree && tree.format;
  const count = (tree && tree.mesh_count) || 0;
  return fmt && fmt.meshes === false && count > 0
    ? `${count} mesh element(s) present, but this format ("${fmt.id}") renders ONLY cubes — meshes won't show in-game and are silently dropped on export. Convert them to cubes.`
    : null;
};

// The export preflight (validate_model for_export, export_bundle): the structure checks plus what
// an export needs — the geometry identifier, textures, the UV layout, meshes, every animation.
// `known` passes what the caller has already read, so it isn't asked for twice.
type Finding = { severity: "error" | "warning"; rule: string; message: string };
type Preflight = { findings: Finding[]; errors: number; warnings: number; formatId?: string; animations: any[] };
const findingLine = (f: Finding) => `  [${f.severity === "error" ? "ERROR" : "warn "}] (${f.rule}) ${f.message}`;
const preflightVerdict = (pre: Preflight) =>
  pre.errors === 0
    ? `Export check: READY ✅ — ${pre.warnings} warning(s). Structure, UV, textures${pre.animations.length ? `, ${pre.animations.length} animation(s)` : ""} checked.`
    : `Export check: NOT READY ❌ — fix ${pre.errors} error(s) first (${pre.warnings} warning(s)).`;

async function exportPreflight(tree: SceneTree, known: { info?: any; animations?: any[] } = {}): Promise<Preflight> {
  const ask = async (tool: ToolType, input: Record<string, any>): Promise<any> => {
    try { const a: any = await sendToBlockbench(tool, input); return a && a.ok !== false ? a : null; } catch { return null; }
  };
  const findings: Finding[] = validateScene(tree).map(({ severity, rule, message }) => ({ severity, rule, message }));
  // Meshes are dropped from a cubes-only export: an error here, not a warning.
  const meshWarn = meshWarning(tree);
  if (meshWarn) findings.push({ severity: "error", rule: "mesh-in-box-format", message: meshWarn });
  const info = known.info ?? (await ask("get_project_info", {}))?.info;
  const formatId: string | undefined = info?.format?.id || (tree as any).format?.id;
  if ((formatId === "geckolib_model" || formatId === "bedrock") && !info?.project?.model_identifier) {
    findings.push({ severity: "error", rule: "geometry-identifier", message: 'No geometry identifier — set_project model_identifier="<name>" (GeckoLib loads geometry.<name>).' });
  }
  // Textures: none at all, or faces without one.
  const cubes: any[] = [];
  const walkNodes = (nodes: any[]) => nodes.forEach((n) => { if (n.type === "cube") cubes.push(n); else walkNodes(n.children || []); });
  walkNodes(tree.roots || []);
  const bare = cubes.map((c) => ({ name: c.name, faces: Object.entries(c.faces || {}).filter(([, f]: [string, any]) => !f?.texture).map(([k]) => k) })).filter((c) => c.faces.length);
  if (cubes.length && !(tree.textures || []).length) {
    findings.push({ severity: "warning", rule: "no-texture", message: "The project has no texture, so the model exports untextured." });
  } else if (bare.length) {
    const count = bare.reduce((n, c) => n + c.faces.length, 0);
    findings.push({ severity: "warning", rule: "faces-without-texture", message: `${count} face(s) have no texture: ${bare.slice(0, 6).map((c) => `${c.name} (${c.faces.join(", ")})`).join("; ")}${bare.length > 6 ? "; …" : ""} — apply_texture.` });
  }
  // UV layout.
  if (cubes.length) {
    const uv = await ask("validate_uv", {});
    if (uv && uv.valid === false) {
      findings.push({ severity: "error", rule: "uv", message: `UV layout is not valid — overlaps ${uv.overlaps}, out of bounds ${uv.out_of_bounds}, missing ${uv.null_uv}, zero-size ${uv.zero_size_uv}. Run pack_uv, then validate_uv.` });
    }
  }
  // Every animation.
  const animations: any[] = known.animations ?? (await ask("list_animations", {}))?.animations ?? [];
  for (const a of animations) {
    const c = await ask("check_animation", { animation_id: a.name });
    for (const issue of c?.issues || []) findings.push({ severity: issue.severity === "error" ? "error" : "warning", rule: `animation ${a.name}`, message: issue.message });
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return { findings, errors, warnings: findings.length - errors, formatId, animations };
}

const nextExportStep = (formatId: string | undefined, animations: number): string =>
  formatId === "java_block"
    ? "Next: export_model (codec java_block)."
    : BUNDLE_FORMATS.has(formatId || "")
      ? `Next: export_bundle — the model${animations ? ", its animations" : ""} and texture into the mod's folders in one call (export_model${animations ? " + export_animations" : ""} for loose files).`
      : `Next: export_model (the format's codec)${animations ? " and export_animations" : ""}.`;

server.registerTool(
  "validate_model",
  {
    title: "Validate Model",
    description:
      "Validate the current model against its format's rules: duplicate names, missing pivots, invalid " +
      "geometry, rotations the format can't export (e.g. group rotation or non-22.5° steps in Java block/item " +
      "for Minecraft 1.9–1.21.5), coordinates outside the format's range, missing textures, and orphaned " +
      "groups. Returns a pass/fail report. Run before exporting or animating (rule #8). `for_export: true` " +
      "adds everything an export needs in the same report — the UV layout, faces without a texture, every " +
      "animation (check_animation), the geometry identifier, meshes a cubes-only format would drop — and ends " +
      "with a verdict: ready to export, or what to fix first.",
    inputSchema: {
      for_export: z.boolean().optional().describe("Also check what the export needs (UV, textures, animations, identifier, meshes) and give a verdict."),
    },
  },
  async (args) => {
    let r: any;
    try {
      r = await sendToBlockbench("get_scene_tree", {});
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`validate_model could not read the scene: ${r.error}`);

    const tree = r.tree as SceneTree;
    if (args.for_export) {
      const pre = await exportPreflight(tree);
      const out = [preflightVerdict(pre), ...pre.findings.map(findingLine)];
      if (pre.errors === 0) out.push(nextExportStep(pre.formatId, pre.animations.length));
      return { isError: pre.errors > 0, content: [{ type: "text" as const, text: out.join("\n") }] };
    }
    const report = buildReport(validateScene(tree));

    // EARLY mesh warning: meshes in a cubes-only format (GeckoLib/Bedrock) won't
    // render in-game and are silently dropped on export — catch it now, not at export.
    const meshWarn = meshWarning(tree);
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
      "Keyframe times are in seconds; rotation in degrees; keyframes may use any axes. " +
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

// Walk / idle loops computed from the rig (packages/shared/src/gaits.ts): one
// create_animation call (one undo step), then check_animation on the result.
server.registerTool(
  "generate_animation",
  {
    title: "Generate Animation",
    description:
      "Create a looping walk or idle animation for the rig in ONE call. The bones are found by name — " +
      "legs and arms (left = −X), body / torso / chest (else the root bone), head — or given explicitly. " +
      "walk: legs swing in opposite phase (4 legs trot: diagonal pairs together), arms swing against the " +
      "legs, the body bobs (highest as the legs pass) and leans over the stance leg, the head stays level. " +
      "idle: slow breathing, a slight arm drift and a small head nod. The last keyframe repeats the first, " +
      "so the loop has no seam. Legs and arms swing about their pivots: set them at the hips / shoulders " +
      "first (set_origin anchor \"top\"); the reply warns when they aren't. Values are what Blockbench " +
      "shows. The new animation is checked with check_animation.",
    inputSchema: {
      kind: z.enum(["walk", "idle"]).describe("walk or idle."),
      name: z.string().optional().describe("Animation name (default: the kind)."),
      length: z.number().min(0.1).max(30).optional().describe("Seconds per loop (walk 1, idle 3)."),
      legs: z.array(z.string()).min(2).max(4).optional().describe("Leg bones: [left, right], or [front-left, front-right, back-left, back-right]. Default: found by name."),
      arms: z.array(z.string()).length(2).optional().describe("Arm bones [left, right]. Default: found by name."),
      body: z.string().optional().describe("Body bone for the bob / breathing. Default: body / torso / chest, else the root bone."),
      head: z.string().optional().describe("Head bone. Default: found by name."),
      stride: z.number().min(0).max(90).optional().describe("walk: leg swing each way in degrees (default 30)."),
      arm_swing: z.number().min(0).max(90).optional().describe("walk: arm swing each way in degrees (default 25)."),
      bob: z.number().min(0).max(8).optional().describe("Body rise in units (walk 0.5, idle breathing 0.3)."),
      sway: z.number().min(0).max(30).optional().describe("walk: body lean in degrees (default 2); idle: arm drift and nod (default 2)."),
      dry_run: z.boolean().optional().describe("Only show the plan; create nothing."),
    },
  },
  async (args) => {
    let tree: any;
    try {
      const r: any = await sendToBlockbench("get_scene_tree", { include_faces: false });
      if (r && r.ok === false) return fail(`generate_animation failed: ${r.error}`);
      tree = r.tree;
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    const rig = findRig(tree || { roots: [] }, { legs: args.legs, arms: args.arms, body: args.body, head: args.head });
    if (args.kind === "walk" && !rig.legs.length) {
      return fail('generate_animation failed: no legs found — name the leg bones with "leg" (e.g. leg_left / leg_right) or pass legs: [left, right].');
    }
    const opts = { length: args.length, stride: args.stride, arm_swing: args.arm_swing, bob: args.bob, sway: args.sway };
    const bones = args.kind === "walk" ? planWalk(rig, opts) : planIdle(rig, opts);
    if (!Object.keys(bones).length) return fail("generate_animation failed: no bones to animate — pass body / arms / head.");
    const length = args.length ?? (args.kind === "walk" ? 1 : 3);
    const name = args.name || args.kind;
    // Name only the bones this animation moves (idle leaves the legs alone).
    const moved = (names: string[]) => names.filter((n) => bones[n]);
    const used = [
      moved(rig.legs).length ? `legs ${moved(rig.legs).join(" / ")}` : null,
      moved(rig.arms).length ? `arms ${moved(rig.arms).join(" / ")}` : null,
      rig.body && bones[rig.body] ? `body ${rig.body}` : null,
      rig.head && rig.head !== rig.body && bones[rig.head] ? `head ${rig.head}` : null,
    ].filter(Boolean).join(", ");
    const notes = rig.warnings.map((w) => `\n⚠️  ${w}`).join("");
    if (args.dry_run) {
      const keys = Object.values(bones).reduce((n, k) => n + k.length, 0);
      return ok(`Plan (nothing created): ${args.kind} "${name}", ${length}s loop, ${Object.keys(bones).length} bone(s), ${keys} keyframe(s) — ${used}.${notes}`);
    }
    let created: any;
    try {
      created = await sendToBlockbench("create_animation", { name, animation_length: length, loop: true, bones });
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (created && created.ok === false) return fail(`generate_animation failed: ${created.error}`);
    let lint = "";
    try {
      const c: any = await sendToBlockbench("check_animation", { animation_id: created?.name || name });
      const issues: any[] = c?.issues || [];
      lint = issues.length ? `\ncheck_animation: ${issues.length} issue(s) — ${issues.slice(0, 4).map((i) => i.message).join(" · ")}` : "\ncheck_animation: no issues.";
    } catch { /* the lint is a bonus */ }
    return ok(`Created ${created?.name || name} (${args.kind}, ${length}s loop, seamless) on ${used}.${notes}${lint}`);
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

// World boxes from the plugin (at rest, or posed at `time`); the gaps, overlaps and sides
// between them come from packages/shared/src/measure.ts.
server.registerTool(
  "measure",
  {
    title: "Measure (boxes, gaps, overlaps)",
    description:
      "Measure parts by number instead of from a screenshot: each target's world box (min→max, size, centre) and, " +
      "for every pair, where the first is relative to the second in place_relative's words (on_top, below, left = " +
      "−X, right, front = −Z, back, inside) and whether they are apart (the gap), touching or OVERLAPPING (how deep, " +
      "the shared box). Targets are cubes or groups — a group's box holds everything inside it; none = the whole " +
      "model. At rest by default; `time` measures the animated pose at that moment (does the leg pass through the " +
      "body at 0.5 s?).",
    inputSchema: {
      targets: z.array(z.string()).min(1).max(8).optional().describe("Cube or group names, 1–8. Omit for the whole model."),
      time: z.number().min(0).optional().describe("Seconds: measure the animated pose at this moment instead of the rest pose."),
      animation_id: animationIdOptional,
    },
  },
  async (args) => {
    const targets = args.targets ? [...new Set(args.targets)] : undefined;
    let r: any;
    try {
      r = await sendToBlockbench("measure", { targets, time: args.time, animation_id: args.animation_id });
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`measure failed: ${r.error}`);
    const boxes: { name: string; kind: string; box: Box | null }[] = r.boxes || [];
    const label = (b: { name: string; kind: string }) => (b.kind === "group" ? `${b.name}/` : b.name);
    const when = r.time === null || r.time === undefined ? "at rest" : `at ${r.time}s of ${r.animation ?? "the animation"}`;
    const lines = [`Measured ${when} (world units; the model faces north: front −Z, its own left −X):`];
    for (const b of boxes) {
      lines.push(`  ${label(b)}  ${b.box ? `${boxText(b.box)}  size ${boxSize(b.box).join(" × ")}  centre [${boxCenter(b.box).join(", ")}]` : "(no geometry)"}`);
    }
    const pairs: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        pairs.push(`  ${a.box && b.box ? relationText(label(a), label(b), boxRelation(a.box, b.box)) : `${label(a)} → ${label(b)}: no geometry to compare`}`);
      }
    }
    if (pairs.length) lines.push("Pairs (A → B: where A is relative to B):", ...pairs);
    return ok(lines.join("\n"));
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
      "Modify an existing cube (resize/move/rename/rotate/visibility/inflate/UV settings). " +
      "Corners are normalized so the box is never inverted. `cube_name` is accepted as a deprecated alias " +
      "for `id` for older callers. " + ROTATION_RULES,
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
      "validated first (existing cubes, unique names, valid vectors, format rules); if one is invalid nothing " +
      "changes. Rotation only where the format allows it on cubes (see create_cube).",
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
      "default — for GeckoLib that is Bedrock geometry (.geo.json), not the .bbmodel. Run list_export_formats first. For very large output, set max_content_length (0 = write " +
      "to path only, no inline content). Validate the model first (validate_model).",
    inputSchema: {
      codec_id: z.string().optional().describe("Codec id (e.g. 'bedrock', 'gltf', 'project'). Default: the format's codec (GeckoLib: bedrock)."),
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

// The mod's assets/<mod_id> folder from what the caller knows: the mod project, its resources
// folder, its assets folder, or assets/<mod_id> itself. A namespace folder is only created where
// mod_id can't be a typo — in an assets folder that holds no other mod, or a fresh resources folder.
function resolveModAssets(modDir: string, modId?: string): { dir: string; modId: string; create: boolean } | { error: string } {
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const named = (p: string, name: string) => path.basename(p).toLowerCase() === name;
  const inside = (assets: string, id: string, create: boolean) => {
    const bad = resourceNameError(id, "mod_id", false);
    return bad ? { error: bad } : { dir: path.join(assets, id), modId: id, create };
  };
  if (!path.isAbsolute(modDir)) return { error: `mod_dir must be an absolute path (got "${modDir}").` };
  const badId = modId === undefined ? null : resourceNameError(modId, "mod_id", false);
  if (badId) return { error: badId };
  const dir = path.resolve(modDir);
  if (!isDir(dir)) return { error: `mod_dir "${dir}" was not found (or is not a folder).` };
  if (named(path.dirname(dir), "assets")) {
    const id = path.basename(dir);
    if (modId !== undefined && modId !== id) return { error: `mod_dir is the assets folder of "${id}", so mod_id must be "${id}" (got "${modId}").` };
    return inside(path.dirname(dir), id, false);
  }
  const assets = [
    ...(named(dir, "assets") ? [dir] : []),
    path.join(dir, "assets"),
    path.join(dir, "src", "main", "resources", "assets"),
    path.join(dir, "common", "src", "main", "resources", "assets"),
  ].find(isDir);
  if (!assets) {
    const resources = [
      ...(named(dir, "resources") ? [dir] : []),
      path.join(dir, "src", "main", "resources"),
      path.join(dir, "common", "src", "main", "resources"),
    ].find(isDir);
    if (!resources) return { error: `could not find an assets or src/main/resources folder in "${dir}" — pass the mod project, its resources folder or its assets/<mod_id> folder.` };
    if (modId === undefined) return { error: `mod_id is required: "${resources}" has no assets folder yet to read it from.` };
    return inside(path.join(resources, "assets"), modId, true);
  }
  const mods = readdirSync(assets, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "minecraft")
    .map((e) => e.name);
  if (modId !== undefined) {
    if (mods.includes(modId)) return inside(assets, modId, false);
    if (mods.length) return { error: `assets/${modId} was not found in "${assets}" — it holds ${mods.join(", ")}. Check mod_id.` };
    return inside(assets, modId, true);
  }
  if (mods.length === 1) return inside(assets, mods[0], false);
  return { error: `mod_id is required: "${assets}" holds ${mods.length ? `several mods' assets (${mods.join(", ")})` : "no mod folder yet"}.` };
}

// A GeckoLib model into a mod in ONE call. The plugin compiles, with the calls export_model /
// export_animations / get_texture make; the server writes the files where GeckoLib's defaulted
// models look (packages/shared/src/modAssets.ts) — so Blockbench asks for no file permission, and
// nothing is written unless the whole bundle can be.
server.registerTool(
  "export_bundle",
  {
    title: "Export Bundle (into a mod)",
    description:
      "Export a GeckoLib model into a mod in ONE call: the geometry (.geo.json), the animations (.animation.json) " +
      "and the texture (.png), each where GeckoLib's defaulted models (DefaultedEntityGeoModel …) load it, under " +
      "assets/<mod_id>/ — GeckoLib 4 (Minecraft up to 1.21.4): geo/<kind>/, animations/<kind>/, textures/<kind>/; " +
      "GeckoLib 5 (1.21.5+): geckolib/models/<kind>/, geckolib/animations/<kind>/, textures/<kind>/. Runs the " +
      "export check first (as validate_model for_export) and writes NOTHING when it finds an error, or when a " +
      "file already there would change — ask the user, then pass overwrite: true. Identical files count as " +
      "unchanged. dry_run shows the plan. GeckoLib and Bedrock projects.",
    inputSchema: {
      mod_dir: z.string().describe("Absolute path: the mod project, its src/main/resources, or its assets/<mod_id> folder."),
      mod_id: z.string().optional().describe("The mod's namespace. Default: from mod_dir, or the only mod folder in its assets."),
      name: z.string().optional().describe("File name without extension; may include folders ('boss/goblin'). Default: the geometry identifier."),
      kind: z.enum(BUNDLE_KINDS).optional().describe("GeckoLib's sub-folder: entity (default), item or block."),
      minecraft_version: z.string().optional().describe(`The mod's Minecraft version; decides GeckoLib 4 or 5 folders (default ${DEFAULT_MC_VERSION}).`),
      geckolib: z.enum(["4", "5"]).optional().describe("Use GeckoLib 4 or 5 folders whatever the Minecraft version."),
      texture: z.string().optional().describe("Which texture, when the project has several (default: the one on the most faces)."),
      include: z.array(z.enum(BUNDLE_PARTS)).min(1).optional().describe("Only these parts: model, animations, texture (default: all the project has)."),
      overwrite: z.boolean().optional().describe("Replace existing files that differ (default false: write nothing and list them)."),
      force: z.boolean().optional().describe("Write although the export check found errors — only when the user accepts them."),
      dry_run: z.boolean().optional().describe("Only show what would be written."),
    },
  },
  async (args) => {
    const ask = async (tool: ToolType, input: Record<string, any>): Promise<any> => {
      const r: any = await sendToBlockbench(tool, input);
      if (r && r.ok === false) throw new Error(`${tool} failed: ${r.error}`);
      return r || {};
    };
    const refuse = (why: string) => fail(`export_bundle failed: ${why}`);
    try {
      // The project, the file names and the folder — before anything is compiled.
      const info = (await ask("get_project_info", {})).info || {};
      const formatId = info.format?.id;
      if (!BUNDLE_FORMATS.has(formatId)) return refuse(`the "${formatId}" format is unsupported — it writes GeckoLib models (a GeckoLib or Bedrock project); use export_model.`);
      const name = bundleName(args.name, info.project?.model_identifier);
      if (!name) return refuse("a name is required — pass name, or set_project model_identifier (it names the geometry too).");
      const badName = resourceNameError(name, "name");
      if (badName) return refuse(badName);
      const mcVersion = args.minecraft_version ?? DEFAULT_MC_VERSION;
      const geckolib = args.geckolib ? (Number(args.geckolib) as 4 | 5) : geckolibFor(mcVersion);
      if (!geckolib) return refuse(`minecraft_version must be a version like 1.20.1 or 26.1 (got "${mcVersion}").`);
      const target = resolveModAssets(args.mod_dir, args.mod_id);
      if ("error" in target) return refuse(target.error);
      const kind: BundleKind = args.kind ?? "entity";
      const rel = bundlePaths(geckolib, kind, name);

      // What there is to ship, and the export check.
      const tree = (await ask("get_scene_tree", {})).tree as SceneTree;
      const animations: any[] = (await ask("list_animations", {})).animations || [];
      const include = new Set<BundlePart>(args.include ?? BUNDLE_PARTS);
      const notes: string[] = [];
      let texture: SceneTexture | null = null;
      if (include.has("texture")) {
        const pick = pickTexture(tree, args.texture);
        if ("error" in pick) return refuse(pick.error);
        texture = pick.texture;
        if (!texture) notes.push("The project has no texture — no .png.");
        else if (pick.others.length && args.texture === undefined) notes.push(`GeckoLib draws a model with one texture: exported "${texture.name}" (on ${pick.faces} face(s)), not ${pick.others.map((t) => `"${t.name}"`).join(", ")} — pass texture to pick another.`);
      }
      if (include.has("animations") && !animations.length) notes.push("The project has no animation — no .animation.json.");
      const pre = await exportPreflight(tree, { info, animations });

      // Compile in Blockbench — whole, since the result is written, not shown.
      type Planned = { rel: string; file: string; data: Buffer; status: "new" | "unchanged" | "changed" };
      const planned: Planned[] = [];
      const add = (part: BundlePart, data: Buffer) => {
        const file = path.join(target.dir, ...rel[part].split("/"));
        let old: Buffer | null = null;
        try { old = readFileSync(file); } catch { /* not there yet */ }
        planned.push({ rel: rel[part], file, data, status: !old ? "new" : old.equals(data) ? "unchanged" : "changed" });
      };
      const whole = { max_content_length: Number.MAX_SAFE_INTEGER };
      if (include.has("model")) {
        const m = await ask("export_model", whole);
        let geo: any = null;
        try { geo = m.encoding === "utf-8" && !m.truncated ? JSON.parse(m.content) : null; } catch { /* checked below */ }
        if (!geo || !geo["minecraft:geometry"]) return refuse(`the ${m.codec?.id ?? "format's"} codec did not produce Bedrock geometry (.geo.json) — nothing was written.`);
        add("model", Buffer.from(m.content, "utf8"));
      }
      if (include.has("animations") && animations.length) {
        const a = await ask("export_animations", whole);
        if (a.truncated || typeof a.content !== "string") return refuse("the animations came back incomplete — nothing was written.");
        add("animations", Buffer.from(a.content, "utf8"));
      }
      if (texture) {
        const t = await ask("get_texture", { texture: texture.uuid });
        const prefix = "data:image/png;base64,";
        if (typeof t.data_url !== "string" || !t.data_url.startsWith(prefix)) return refuse(`texture "${texture.name}" did not come back as a PNG — nothing was written.`);
        add("texture", Buffer.from(t.data_url.slice(prefix.length), "base64"));
      }
      if (!planned.length) return refuse(`there is nothing to export. ${notes.join(" ")}`);

      const changed = planned.filter((p) => p.status === "changed");
      const layout = `GeckoLib ${geckolib} (${args.geckolib ? "as asked" : `for Minecraft ${mcVersion}`})`;
      const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
      const report = [preflightVerdict(pre), ...pre.findings.map(findingLine)].join("\n");
      const noteLines = notes.map((n) => `\n⚠️  ${n}`).join("");
      if (args.dry_run) {
        const blockers = [
          pre.errors && !args.force ? "the export check's errors" : null,
          changed.length && !args.overwrite ? `${changed.length} existing file(s) that would change (overwrite: true replaces them)` : null,
        ].filter(Boolean);
        const state = (p: Planned) => (p.status === "changed" ? (args.overwrite ? "replaces the existing file" : "EXISTS and differs") : p.status);
        return ok(
          `Plan (nothing written): "${name}" for ${layout} into ${target.dir}${target.create ? " (to be created)" : ""}:\n` +
            planned.map((p) => `  ${p.rel}  — ${state(p)}, ${size(p.data.length)}`).join("\n") +
            `\n${report}${noteLines}\n` +
            (blockers.length ? `The real call would write nothing: ${blockers.join("; ")}.` : "The real call would write these files.")
        );
      }
      if (pre.errors && !args.force) {
        const alsoChanged = changed.length && !args.overwrite ? ` Then ${changed.length} existing file(s) would change: overwrite: true replaces them.` : "";
        return { isError: true, content: [{ type: "text" as const, text: `${report}\nNothing was written. Fix the errors first, or pass force: true if the user accepts them.${alsoChanged}` }] };
      }
      if (changed.length && !args.overwrite) {
        return refuse(`nothing was written — each of these already exists with different content:\n${changed.map((p) => `  ${p.file}`).join("\n")}\nAsk the user, then pass overwrite: true to replace them (or choose another name).`);
      }

      // Every file to a temp file first, then all moved into place: a write that fails (disk full,
      // no permission) replaces nothing, and a failed move names what was already moved.
      const toWrite = planned.filter((p) => p.status !== "unchanged");
      const temps: Array<[string, string]> = [];
      let moved = 0;
      try {
        for (const p of toWrite) {
          mkdirSync(path.dirname(p.file), { recursive: true });
          const tmp = `${p.file}.${process.pid}.tmp`;
          writeFileSync(tmp, p.data);
          temps.push([tmp, p.file]);
        }
        for (const [tmp, file] of temps) { renameSync(tmp, file); moved++; }
      } catch (e: any) {
        for (const [tmp] of temps.slice(moved)) { try { unlinkSync(tmp); } catch { /* already gone */ } }
        return refuse(`writing into "${target.dir}" failed: ${e?.message || e}${moved ? ` — already written: ${toWrite.slice(0, moved).map((p) => p.rel).join(", ")}` : " — nothing was written"}.`);
      }
      const forced = pre.errors ? `\n⚠️  Written although the export check found ${pre.errors} error(s) (force).` : "";
      return ok(
        `Exported "${name}" for ${layout} into ${target.dir}${target.create ? " (created)" : ""}:\n` +
          planned.map((p) => `  ${p.rel}  (${size(p.data.length)}, ${p.status === "changed" ? "replaced" : p.status})`).join("\n") +
          `\n${report}${forced}${noteLines}\nIn the mod, ${DEFAULTED_MODEL[kind]} finds these files from "${target.modId}:${name}".`
      );
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
  }
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
      "Can also set the project name, texture resolution and — for Java block/item — the target Minecraft version.",
    inputSchema: {
      model_identifier: z.string().optional().describe("Geometry identifier, e.g. 'staff' → geometry.staff."),
      name: z.string().optional().describe("Project name."),
      texture_width: z.number().int().min(1).optional().describe("Texture atlas width."),
      texture_height: z.number().int().min(1).optional().describe("Texture atlas height."),
      minecraft_version: z.string().optional().describe("Java block/item only: target Minecraft version, e.g. '1.20.1'."),
    },
  },
  async (args) =>
    forward("set_project", args, (r) =>
      `Updated ${r.changed.join(", ")}. geometry identifier: ${r.model_identifier ?? "(none)"}.` + (r.rules ? `\nRules: ${r.rules}` : "")
    )
);

server.registerTool(
  "create_project",
  {
    title: "Create Project",
    description:
      "Create a NEW Blockbench project in a given format (opens a new tab; the current project stays open). " +
      "Use it when the open project has the wrong format — e.g. 'free' or Java instead of GeckoLib/Bedrock — " +
      "instead of risky_eval. Aliases: 'geckolib', 'bedrock', 'java'; an unknown id returns the available list. " +
      "Optionally set name, model_identifier (geometry.<id>) and texture size in the same call. A Java " +
      `block/item project targets minecraft_version (default ${DEFAULT_MC_VERSION}), which decides its rotation rules.`,
    inputSchema: {
      format: z.string().describe("Format id or alias: 'geckolib', 'bedrock', 'java', 'free', or any Blockbench format id."),
      name: z.string().optional().describe("Project name."),
      model_identifier: z.string().optional().describe("Geometry identifier, e.g. 'dagger' → geometry.dagger."),
      texture_width: z.number().int().min(1).optional().describe("Texture atlas width."),
      texture_height: z.number().int().min(1).optional().describe("Texture atlas height."),
      minecraft_version: z.string().optional().describe(`Java block/item only: target Minecraft version, e.g. '1.20.1' (default ${DEFAULT_MC_VERSION}).`),
    },
  },
  async (args) =>
    forward("create_project", { ...args, default_minecraft_version: DEFAULT_MC_VERSION }, (r) =>
      `Created ${r.format} project "${r.name ?? ""}" (animations: ${r.animation_mode ? "yes" : "no"}, ` +
      `geometry identifier: ${r.model_identifier ?? "(none)"}, texture ${r.texture?.[0] ?? "?"}x${r.texture?.[1] ?? "?"}).` +
      (r.rules ? `\nRules: ${r.rules}` : "") + warningLines(r)
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
      "Duplicate a cube, mesh, locator or a whole group (with everything inside), offset by a vector. " +
      "Keeps all data (per-face UV, textures). The copy is named newName, or '<name>_copy'; everything " +
      "inside a copied group gets a unique '<name>_copy' name (rule #4). One undo step. " +
      "`mirror` makes the copy the mirror image across a plane (default the model's centre, x = 0): " +
      "positions, pivots, rotations and box UV are mirrored and side names swap (left_arm → right_arm, " +
      "arm_L → arm_R) — build one side, mirror the other. `count` makes a row of copies, each " +
      "`offset` further on (spikes, teeth, fence posts); newName then needs '{i}' (e.g. 'spike_{i}').",
    inputSchema: {
      id: z.string().describe("Name or uuid of the element to duplicate."),
      offset: vec3.optional().describe("Position offset [x,y,z] for the copy (with count: between copies). Default [0,0,0]."),
      newName: z.string().optional().describe("Name for the top-level copy (must be unused; with count use '{i}')."),
      mirror: z.enum(["x", "y", "z"]).optional().describe("Mirror the copy across this axis' plane: x = left↔right (the usual), y = up↔down, z = front↔back."),
      mirror_center: z.number().optional().describe("Where the mirror plane sits on that axis (default 0; 8 in Java block/item)."),
      count: z.number().int().min(1).max(64).optional().describe("How many copies (default 1)."),
    },
  },
  async (args) =>
    forward("duplicate_element", args, (r) => {
      const copies = Array.isArray(r.copies) && r.copies.length > 1 ? `${r.copies.length} copies: ${r.copies.join(", ")}` : `"${r.name}"`;
      const total = Array.isArray(r.names) && r.names.length > (r.copies?.length || 1)
        ? ` (${r.names.length} element(s) in all: ${r.names.slice(0, 24).join(", ")}${r.names.length > 24 ? ", …" : ""})` : "";
      const mirrored = r.mirrored ? `, mirrored across ${r.mirrored.axis} = ${r.mirrored.center}` : "";
      return `Duplicated "${r.source}" as ${copies}${mirrored}${total}.`;
    })
);

server.registerTool(
  "move_element",
  {
    title: "Move Element or Part",
    description:
      "Move a cube, mesh or a whole group — everything inside it, pivots included — in one undo step. " +
      "`offset` moves by [x,y,z] in world space (rotated parents are taken into account); `to` puts the " +
      "part's pivot (origin) at a world point. `dry_run` only reports where it would go. To put a part " +
      "against another one (on top, beside, …) use place_relative.",
    inputSchema: {
      target: z.string().describe("Name or uuid of the element or group to move."),
      offset: vec3.optional().describe("Move by [x,y,z] (world units)."),
      to: vec3.optional().describe("Or: the world point [x,y,z] its pivot/origin should end up at."),
      dry_run: z.boolean().optional().describe("Only report the move; change nothing."),
    },
  },
  async (args) =>
    forward("move_element", args, (r) =>
      `${r.dry_run ? "Would move" : "Moved"} "${r.name}" by [${(r.delta || []).join(", ")}] (${r.moved} node(s)); it ${r.dry_run ? "would span" : "now spans"} ${boxText(r.box)}.` + warningLines(r))
);

server.registerTool(
  "place_relative",
  {
    title: "Place Relative",
    description:
      "Put a part against another one without computing coordinates (\"the head on top of the body, " +
      "centred\"): `side` on_top | below | left | right | front | back | inside, `gap` between them " +
      "(negative sinks it in), `align` on the other two axes center (default) | min | max | keep. Works " +
      "on cubes and whole groups — moved with everything inside, pivots included — using their world " +
      "bounds, rotations included. The model faces north (−Z): front = −Z, left = −X (its own left). " +
      "One undo step; `dry_run` only reports.",
    inputSchema: {
      target: z.string().describe("The element or group to move."),
      ref: z.string().describe("The element or group to place it against (stays where it is)."),
      side: z.enum(SIDES).describe("on_top (+Y), below (−Y), left (−X), right (+X), front (−Z), back (+Z), inside (centred in ref)."),
      gap: z.number().optional().describe("Space between them in units (default 0 = touching; negative = overlap)."),
      align: alignSchema.optional().describe("On the other axes: center (default), min / max (flush with ref's lower / upper side), keep (don't move) — or per axis, e.g. { y: \"min\" } (unnamed axes centred)."),
      offset: vec3.optional().describe("Extra nudge [x,y,z] after placing."),
      dry_run: z.boolean().optional().describe("Only report the move; change nothing."),
    },
  },
  async (args) =>
    forward("place_relative", args, (r) =>
      `${r.dry_run ? "Would place" : "Placed"} "${r.name}" ${String(r.side).replace("_", " ")} "${r.ref}" (moved by [${(r.delta || []).join(", ")}]); ` +
      `it ${r.dry_run ? "would span" : "now spans"} ${boxText(r.box)}, "${r.ref}" spans ${boxText(r.ref_box)}.` + warningLines(r))
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
      "Images are downscaled to `max_size` px (default 800) — ask for more only when you need fine detail. " +
      "CONTACT SHEET: `views` renders several angles framed on the whole model and/or `times` several " +
      "animation frames into ONE labelled image — one read instead of a screenshot each (views × times, up " +
      "to 16 pictures). The model faces north: front = −Z side, left = its own left (−X). The camera and " +
      "the timeline are restored afterwards.",
    inputSchema: {
      project: z.string().optional().describe("Project name/uuid; default the open one."),
      time: z.number().optional().describe("Seconds — evaluate the animation at this moment before rendering (for posed/animation frames)."),
      animation_id: z.string().optional().describe("Animation UUID or name to evaluate at `time`. Default: the selected animation."),
      views: z.array(z.enum(VIEWS)).min(1).max(8).optional().describe("Contact sheet angles: front, back, left, right, top, bottom, iso (front-left-top), iso_back."),
      times: z.array(z.number().min(0)).min(1).max(12).optional().describe("Contact sheet of an animation: one frame per time (seconds), from the current camera or from each of `views`."),
      max_size: screenshotMaxSize,
    },
  },
  async (args) => {
    if (!args.views && !args.times) return forwardImage("capture_screenshot", args);
    let r: any;
    try {
      r = await sendToBlockbench("capture_screenshot", args);
    } catch (e: any) {
      return fail(e?.message || String(e));
    }
    if (r && r.ok === false) return fail(`capture_screenshot failed: ${r.error}`);
    const picture = image(r.data_url);
    const cells = Array.isArray(r.cells) ? r.cells : [];
    return {
      content: [
        ...picture.content,
        { type: "text" as const, text: `Contact sheet, ${r.cols}×${r.rows}, left to right, top to bottom: ${cells.join(" | ")}.` },
      ],
    };
  }
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
      "Texture a cube from ONE exact colour as shaded pixel art: an even, hue-shifted palette built around your " +
      "colour, light from above (top bright, sides a soft top→bottom gradient, bottom in shade, lit rim, contact " +
      "shadow) and a material that paints real structure — generic, fur, skin, leather (padded, stitched " +
      "seams), cloth, wood, planks, stone, metal, gem, plant, dungeon_stone (blocks, soft mortar, worn bevels, " +
      "cracks), crystal (cut facets around a glowing core), monster_fur (hanging V-shaped locks), ancient_metal " +
      "(sharp highlight, rust at the rims), wavy_wood (flowing grain, rings), magma (hot glowing middle, flow " +
      "streaks, crust plates), moss, water (depth gradient, waves), ice (glassy streaks, a straight fracture, " +
      "deep-blue depth). `smoothing` 0–1 goes from strong clustered texture to a calm surface, never dotted (each " +
      "material has a sensible default). Give `cube_id` or " +
      "`target` (a group) plus `color` (one hex) or `colors` (3–9 hex, dark → light). Run pack_uv + " +
      "validate_uv FIRST so each cube has its own UV region.",
    inputSchema: {
      cube_id: z.string().optional().describe("One cube name/uuid to shade."),
      target: z.string().optional().describe("Group name → shade all its descendant cubes the same colour (use instead of cube_id)."),
      color: z.string().optional().describe("⭐ One hex (e.g. '#cc2233') → hue-shifted 9-shade palette, your colour in the middle. The normal way to hit a reference colour."),
      colors: z.array(z.string()).min(3).max(9).optional().describe("Full control: 3–9 hex, dark → light (the middle one is the base). Overrides color."),
      material: z.enum(MATERIALS).optional().describe("Surface material (default generic) — see the description for what each paints."),
      detail: z.number().min(0).max(2).optional().describe("Pattern strength 0–2 (default 1; 0 = smooth shading only)."),
      lighting: z.number().min(0).max(2).optional().describe("Light/shadow strength 0–2 (default 1)."),
      smoothing: z.number().min(0).max(1).optional().describe("0 = strong texture of small colour clusters … 1 = calm surface with soft gradients; no level leaves lone dots. Default depends on the material (0.35–0.6)."),
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
      "Texture a whole model in ONE call: a list of parts, each with its own exact colour and material, painted " +
      "as shaded pixel art like shade_cube (materials and smoothing as described there) in a single texture " +
      "edit and undo step. Each item: `cube_id` or `target` (group) + `color` (one hex) or `colors` (3–9 hex), " +
      "optional `material` / `detail` / `lighting` / `smoothing` / `edge_color` / `sheen`. Items are validated " +
      "first (nothing is painted if one is invalid) and painted in order. Run pack_uv + validate_uv first.",
    inputSchema: {
      items: z
        .array(
          z.object({
            cube_id: z.string().optional().describe("One cube name/uuid."),
            target: z.string().optional().describe("Group name → all its descendant cubes."),
            color: z.string().optional().describe("One hex → hue-shifted 9-shade palette."),
            colors: z.array(z.string()).min(3).max(9).optional().describe("3–9 hex, dark → light; overrides color."),
            material: z.enum(MATERIALS).optional().describe("Surface material (default generic) — see shade_cube."),
            detail: z.number().min(0).max(2).optional().describe("Pattern strength 0–2 (default 1)."),
            lighting: z.number().min(0).max(2).optional().describe("Light/shadow strength 0–2 (default 1)."),
            smoothing: z.number().min(0).max(1).optional().describe("0 strong clustered texture … 1 calm (default per material)."),
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

// Several tool calls in ONE round trip (round trips, not the tools, are what a session spends
// its time on). Each step goes through the same schema check and handler as a direct call.
const BATCH_TEXT_MAX = 700;
server.registerTool(
  "run_batch",
  {
    title: "Run Batch",
    description:
      "Run several tool calls in ONE round trip, in order: steps = [{ tool, args }, …] (up to 50). Each " +
      "step is checked and run exactly like a direct call; the reply lists every step's result (and any " +
      "images). on_error: stop (default) — stop at the first failure; continue — run the rest anyway; " +
      "rollback — stop and undo everything this batch changed. Use it when you already know the next " +
      "steps; for many edits of one kind prefer the batch tools (create_cubes, modify_cubes, shade_cubes, " +
      "set_keyframes). Steps can't nest run_batch.",
    inputSchema: {
      steps: z
        .array(z.object({
          tool: z.string().describe("Tool name, e.g. 'place_relative'."),
          args: z.record(z.string(), z.any()).optional().describe("That tool's arguments."),
        }))
        .min(1)
        .max(50)
        .describe("The calls, in order."),
      on_error: z.enum(["stop", "continue", "rollback"]).optional().describe("stop (default), continue, or rollback (undo this batch's changes)."),
    },
  },
  async (args, extra) => {
    const onError = args.on_error ?? "stop";
    const undoIndex = async (): Promise<number | null> => {
      try {
        const r: any = await sendToBlockbench("get_undo_stack", { limit: 1 });
        return typeof r?.stack?.index === "number" ? r.stack.index : null;
      } catch { return null; }
    };
    const start = onError === "rollback" ? await undoIndex() : null;
    const lines: string[] = [];
    const images: any[] = [];
    let failed = -1, done = 0;
    for (let i = 0; i < args.steps.length; i++) {
      const step = args.steps[i];
      const entry = toolHandlers.get(step.tool);
      let result: any;
      if (step.tool === "run_batch") result = fail("run_batch cannot run inside run_batch.");
      else if (!entry) result = fail(`Unknown tool "${step.tool}"${notLoaded.includes(step.tool) ? " (not loaded in this profile)" : ""}.`);
      else {
        const parsed = z.object(entry.shape).safeParse(step.args ?? {});
        if (!parsed.success) {
          result = fail(`Invalid arguments for ${step.tool}: ${parsed.error.issues.map((iss) => `${iss.path.join(".") || "(args)"}: ${iss.message}`).join("; ")}`);
        } else {
          try { result = await entry.cb(parsed.data, extra); } catch (e: any) { result = fail(e?.message || String(e)); }
        }
      }
      const content: any[] = result?.content || [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      images.push(...content.filter((c) => c.type === "image"));
      lines.push(`${i + 1}. ${step.tool} ${result?.isError ? "✗" : "✓"} ${text.length > BATCH_TEXT_MAX ? text.slice(0, BATCH_TEXT_MAX) + "…" : text}`);
      if (result?.isError) {
        if (failed < 0) failed = i;
        if (onError !== "continue") break;
      } else done++;
    }
    let tail = "";
    if (failed >= 0 && onError === "rollback") {
      const end = await undoIndex();
      const n = start !== null && end !== null ? end - start : 0;
      if (n > 0) {
        try {
          await sendToBlockbench("undo", { steps: n });
          tail = `\nRolled back: undid ${n} step(s); the project is as it was before the batch.`;
        } catch (e: any) { tail = `\n⚠️  Rollback failed: ${e?.message || e}`; }
      } else tail = "\nNothing to roll back.";
    }
    const head = failed < 0
      ? `Batch done: ${done}/${args.steps.length} step(s).`
      : `Batch ${onError === "continue" ? "finished with errors" : "stopped"}: step ${failed + 1} (${args.steps[failed].tool}) failed, ${done} step(s) succeeded.`;
    const out = { content: [{ type: "text" as const, text: `${head}\n${lines.join("\n")}${tail}` }, ...images] };
    return failed >= 0 && onError !== "continue" ? { ...out, isError: true } : out;
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
