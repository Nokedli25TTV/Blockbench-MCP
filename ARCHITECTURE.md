# Architecture — blockbench-mcp

How this project is built and where everything lives. Companion to `MODELING_CONSTRAINTS.md`
(the hard modeling rules) and the higher-level `../PROJECT.md` handoff.

## 1. What it is

A custom integration that lets **Claude (Claude Desktop)** do 3D modeling in **Blockbench**
over the **Model Context Protocol (MCP)**. 119 MCP tools cover modeling, animation, export,
texturing/UV, painting, camera, history, PBR, mesh, armature and UI.

## 2. The three processes + data flow

```
 Claude Desktop ──stdio (MCP / JSON-RPC)──▶  mcp-server (node dist/index.js)
                                                  │   also runs a Socket.IO server on :9999
                                                  ▼
                                             Socket.IO  ◀──── mcp-plugin (Socket.IO *client*)
                                              (:9999)         runs INSIDE Blockbench, calls the
                                                              Blockbench API, returns an ack {ok,...}
```

- The **server** owns the MCP protocol (stdout = JSON-RPC; **all logging goes to stderr**) and
  bridges each tool call to the plugin over Socket.IO, awaiting the plugin's ack.
- The **plugin** runs in Blockbench, executes the real Blockbench API calls, and acks `{ ok, ... }`.
- The bridge is **local-only**: it binds to `127.0.0.1` and refuses Socket.IO handshakes whose Origin is a web page (`http`/`https`, or `null` from a sandboxed iframe) — the plugin sends no Origin — so a browser tab can't pose as Blockbench. If the active client disconnects, the bridge falls back to another still-connected one.
- **Shared bridge.** Only one process can own port 9999 (the plugin connects to `127.0.0.1:9999`
  only), but several clients may each start this server (the Claude app, Claude Code sessions). The
  first becomes the **owner**; a later one finds the port taken, pings `GET /mcp-bridge/ping` and joins
  as a **relay**: its tool calls go to the owner as `POST /mcp-bridge/call` on the same port, and the
  owner forwards them to the plugin. Relays ping the owner every 3 s; when it is gone, one takes the port
  over and the plugin (which reconnects by itself) connects to it — 0.6–1.5 s in the e2e test.
  Relay traffic uses plain `node:http` with `agent: false`, not `fetch()`: pooled keep-alive sockets
  made Node abort on exit on Windows (libuv `UV_HANDLE_CLOSING` assertion).
  A relayed call carries a `call_id`; if the owner dies mid-call it is resent once and the plugin
  answers the resend with the first result instead of applying the edit twice. The HTTP endpoint is
  locked down like the socket: no `Origin` allowed, a custom `x-blockbench-mcp-relay` header required,
  `Host` must be `127.0.0.1`/`localhost` (DNS rebinding). A port held by some *other* program is still
  fatal. The server exits when its client closes stdin, so an orphan never holds the port.
  `get_project_info` reports `mcp_bridge: { role, relays_connected }`.
- Every tool call carries its own Socket.IO ack and a per-tool timeout (`TOOL_TIMEOUTS` in
  `index.ts`: 10 s default, 20 s reads/animation, 30 s render/pack, 60 s export). A connected
  plugin is usable immediately — there is no separate "ready" gate.
- **Tool profile** (`BLOCKBENCH_MCP_PROFILE`, default `geckolib`): skips 50 mesh / armature /
  Bedrock-PBR / brush-emulation tools that don't apply to cube models — the tools/list sent to the
  model shrinks from ~24k to ~16k tokens. `full` loads all 119. Set it in the client's MCP server
  config (`"env": { "BLOCKBENCH_MCP_PROFILE": "full" }`). Every tool also carries MCP annotations
  (`readOnlyHint` / `destructiveHint`).
- Screenshots (`capture_screenshot`, `set_camera_angle`, app captures) are downscaled to 800 px on
  the longest edge by default (`max_size`; 0 = native) — images are the costliest thing the model
  reads. Measured: tool execution is ~0.1% of session time; round-trips and reading dominate.

## 3. Repository layout (what's where)

```
blockbench-mcp/
├─ apps/
│  ├─ mcp-server/                 # the external MCP server (Node, stdio + Socket.IO bridge)
│  │  ├─ src/
│  │  │  ├─ index.ts              # ★ registers ALL 119 MCP tools (profile-filtered); the :9999 bridge; forward() helpers
│  │  │  └─ skills.ts             # loads skills/*, builds the MCP `instructions` index, get_skill content
│  │  ├─ test/
│  │  │  ├─ harness.mjs           # spawns real server + a MOCK Blockbench scene + an MCP stdio client
│  │  │  └─ full-model.test.mjs   # builds a model exercising every tool against the mock (test:model)
│  │  ├─ toolchain-e2e.mjs        # nested-group / multi-axis / validation / rejection e2e (test:e2e)
│  │  └─ dist/index.js            # esbuild CJS bundle Claude Desktop runs (gitignored)
│  └─ mcp-plugin/                 # the in-Blockbench plugin (Socket.IO client)
│     ├─ src/mcp_socketio_plugin.ts  # ★ one handler per tool + the dispatch map + the panel + socket
│     └─ dist/mcp_socketio_plugin.js # vite bundle loaded via Blockbench → File → Plugins (gitignored)
├─ packages/shared/src/
│  ├─ validation.ts               # validateScene() / buildReport() — pure, unit-testable guardrails
│  ├─ palettes.ts                 # 13 hue-shifted 5-step pixel-art ramps + getPalette()
│  └─ types.ts                    # ToolType + SceneTree shared types
├─ skills/                        # 8 Markdown guides (use / mcp-overview / modeling / texturing /
│                                 #   pbr-materials / pixel-shading / animation / development)
├─ tools/
│  ├─ usage-report.mjs            # `pnpm report`: calls/latency/errors/bridge events from Claude's logs
│  ├─ bump-version.mjs            # `pnpm bump patch|minor|major`: versions + CHANGELOG + commit + tag
│  ├─ release-notes.mjs           # release notes for a version, from CHANGELOG.md
│  └─ changelog.mjs               # CHANGELOG.md section helpers shared by the two above
├─ .github/workflows/
│  ├─ ci.yml                      # build + typecheck + tests, Ubuntu and Windows
│  └─ release.yml                 # on a vX.Y.Z tag: build, test, package, smoke-test, DRAFT release
├─ CHANGELOG.md                   # Unreleased + one section per version (source of the release notes)
├─ ARCHITECTURE.md  MODELING_CONSTRAINTS.md  AGENTS.md  README.md
└─ package.json  pnpm-workspace.yaml  tsconfig.base.json
```

★ = the two files that hold almost everything. Every tool exists in **both**: a server
registration (schema + forward) in `index.ts`, and a handler (Blockbench API) in the plugin.

## 4. How one tool call flows

1. Claude calls e.g. `create_cube` → MCP server `index.ts`.
2. The registration validates args with its **zod schema**, then `forward("create_cube", args, …)`.
3. `forward()` emits a `tool_command` over Socket.IO and awaits the plugin ack (`sendToBlockbench`).
4. The plugin's dispatch map routes `create_cube` → `createCube(input)`, which runs the Blockbench
   API inside an `Undo.initEdit/finishEdit` pair and returns `{ ok: true, … }`.
5. The server formats the ack into an MCP result. Helper variants in `index.ts`:
   `ok/fail`, `forward` (text), `forwardImage` (data-URL → MCP image), `forwardImageOrText`,
   `forwardData` (returns `r.data` as JSON). `validate_model` is special: it pulls the scene tree
   and runs the **pure** `validateScene` from `packages/shared` server-side.

`get_project_info` returns `plugin_build` + `tool_count` — the canonical check that the **plugin**
(not just the server) was reloaded after a rebuild. `plugin_build` is stamped by `vite.config.ts`
(`<version>+<UTC yyyymmdd.hhmm>.<git sha>[-dirty]`); the version comes from
`apps/mcp-plugin/package.json`. The server takes its version from `apps/mcp-server/package.json` (bundled by esbuild); it is in
`mcp_bridge.server_version`, and a relay logs a note when the owner runs a different version.

## 5. Build & run

```powershell
# from blockbench-mcp/ (use the PowerShell tool for pnpm/node in this sandbox)
pnpm -C . --filter mcp-plugin build     # vite  → apps/mcp-plugin/dist/mcp_socketio_plugin.js
pnpm -C . --filter mcp-server build     # esbuild → apps/mcp-server/dist/index.js
pnpm -C . test          # test:model + test:e2e — local mock tests (free, no Blockbench)
pnpm -C . typecheck     # strict tsc, server + plugin (blockbench-types 5.x)
pnpm -C . report        # usage report from the Claude app + Claude Code logs
```

Reload rules after a rebuild (the #1 source of "my fix didn't work"):
- **Server** rebuilt → fully **restart Claude Desktop** (it re-spawns `node dist/index.js`).
- **Plugin** rebuilt → **reload the plugin in Blockbench** (File → Plugins, toggle off/on). Restarting
  Desktop does NOT reload the plugin. Confirm via `get_project_info` → `plugin_build`.

Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json`) has a `blockbench` entry:
`node <repo>\apps\mcp-server\dist\index.js`.

## 6. Texturing pipeline (the part that bites)

Minecraft/GeckoLib uses **ONE atlas per model** with **box-UV**: every cube stores a single
`uv_offset [u,v]` that positions its unwrapped net on the atlas. The exported `.geo.json` carries
only that `uv` offset — NOT per-face texture assignments.

- A cube of size `(w,h,d)` occupies a box-UV footprint of **`2·(w+d)` wide × `(h+d)` tall**, anchored
  at `uv_offset`. Size each atlas region ≥ the largest net that uses it.
- **CRITICAL:** `uv_offset` only sticks when the cube's **`autouv` = 0**. With `autouv = 1` Blockbench
  re-derives box-UV automatically and every cube collapses toward `[0,0]` → the whole model samples
  one corner (the recurring "everything is one colour / grey" bug). In a `.bbmodel` the field is
  `uv_offset` on the element; per-face `faces[].uv` rects are derived from it, not the source of truth.
- Painting tools (`draw_shape_tool`, `gradient_tool`, `paint_fill_tool`) write **directly to the
  texture canvas** via `texture.edit(canvas => ctx…)`. (Earlier they used the Blockbench Painter UI
  API — `Painter.startPaintTool/useShapeTool` — which **no-ops when driven headlessly**; the
  canvas-direct rewrite is the reliable path. Upstream still uses the UI-API version.)
- For real pixel art use **`paint_pixel_matrix`** + a palette from `palettes.ts` (index `0`=shadow →
  `4`=highlight). It renders an index-matrix 1px/cell → crisp, anti-aliasing-free, palette-locked.

Recommended order: `set_project` (texture size) → `create_texture` (atlas) → paint the atlas regions
→ `apply_texture` (cube or whole group) → `modify_cube { uv_offset, autouv:"0" }` per cube.

## 7. Conventions & guardrails

- **Single-axis rule:** a cube is never multi-axis rotated; `create_cube` accepts no rotation,
  `set_rotation` is group-only and rejects >1 non-zero axis. Multi-axis = nested bones.
- **Pivot-first, unique names, validate before export** — enforced in code + `validateScene`.
- Plugin element creation: `new Cube(...).init()` BEFORE `addTo`; always attach to a parent;
  guarantee `Undo.finishEdit()` runs (else an orphan with no undo entry).
- Plugin imports `packages/shared` by **relative path** for runtime (vite can't resolve the
  `@blockbench-mcp/shared/*` alias at runtime; only type-only imports of it are erased).
- Animations only select/play in Animation mode — `ensureAnimationMode()` calls `Animator.join()`.
- **One animation value convention.** Every animation tool reads/writes the values Blockbench stores
  and shows. The Bedrock/GeckoLib `.animation.json` flips rotation X and Y and position X (scale is
  unchanged) — measured live 2026-09-23. `create_animation` imports through that codec, so it
  pre-flips its input (`toBedrockRotation` / `toBedrockPosition`); export flips back.
- **World bounding boxes** come from element geometry only (`elementsWorldBox`): `Box3.setFromObject`
  on a bone also picks up editor helpers such as a selected bone's `pivot_marker` (±5.5 units).
