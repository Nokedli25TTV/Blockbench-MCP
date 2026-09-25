# Blockbench MCP — personal fork

Lets an AI assistant (Claude Desktop, Claude Code or any other MCP client) build, texture, animate and
export models **inside Blockbench** through the [Model Context Protocol](https://modelcontextprotocol.io/).
This fork is tuned for **Minecraft / GeckoLib** cube models.

> [!IMPORTANT]
> **This is a personal, non-commercial fork — not the original project.**

## 📌 About this fork

### 🇬🇧 English

- **The original project** is **Blockbench MCP by [enfpdev](https://github.com/enfpdev)** —
  [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp).
  The foundation of this repository (the MCP server ↔ Blockbench plugin bridge) is their work;
  all credit for it goes to them.
- Many tool definitions were ported from
  [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project).
- I ([Nokedli25TTV](https://github.com/Nokedli25TTV)) only **extended it for my own use** —
  Minecraft / GeckoLib modding. It is **not sold, not monetized, and made without any intent of
  profit**. No support or updates are promised.
- The extensions were written **with AI assistance** (Claude Code, OpenAI Codex). They are covered
  by automated tests against a mock Blockbench and were partly tried in real Blockbench, but they
  **may still contain bugs**.
- **If you use it, you do so at your own risk:** back up your `.bbmodel` files, read the code before
  trusting it, and keep in mind that the `risky_eval` tool can run arbitrary JavaScript inside
  Blockbench.
- The project stays under the **MIT License**; the original copyright notice is kept in
  [LICENSE](LICENSE). What changed compared to the original: see the commit history and
  [ARCHITECTURE.md](ARCHITECTURE.md).

### 🇭🇺 Magyarul

- **Az eredeti projekt** a **Blockbench MCP, [enfpdev](https://github.com/enfpdev) munkája** —
  [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp).
  Ennek a repónak az alapja (az MCP szerver ↔ Blockbench plugin híd) az ő munkájuk, minden érdem
  az övék.
- Számos tool-definíció a
  [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project)
  projektből lett átvéve.
- Én ([Nokedli25TTV](https://github.com/Nokedli25TTV)) **csak továbbfejlesztettem saját
  felhasználásra** — Minecraft / GeckoLib modolás. **Nem árulom, nem pénzelem, semmilyen
  profitszerzési célja nincs.** Támogatást és frissítéseket nem ígérek.
- A fejlesztések **mesterséges intelligencia segítségével** készültek (Claude Code, OpenAI Codex).
  Automatikus tesztek ellenőrzik őket egy szimulált Blockbench ellen, és részben valódi
  Blockbenchben is ki lettek próbálva, de **tartalmazhatnak hibákat**.
- **Ha használod, a saját felelősségedre teszed:** készíts biztonsági mentést a `.bbmodel`
  fájljaidról, nézd át a kódot, mielőtt megbízol benne, és ne feledd, hogy a `risky_eval` tool
  tetszőleges JavaScriptet futtathat a Blockbenchben.
- A projekt továbbra is **MIT-licenc** alatt áll; az eredeti szerzői jogi közlemény a
  [LICENSE](LICENSE) fájlban megmaradt. Hogy mi változott az eredetihez képest: lásd a commit-előzményt
  és az [ARCHITECTURE.md](ARCHITECTURE.md) fájlt.

## ✨ What it can do

- **Build a model in one call** — a whole bone hierarchy plus its cubes with `create_cubes`, with
  guardrails: unique names, pivots first, and rotation rules that follow the format — GeckoLib bones
  on any axes, Java block/item models (blocks, vanilla-style items) on cubes at the angles their
  Minecraft version accepts (1.20.1: one axis, 22.5° steps).
- **Texture precisely** — `pack_uv` gives every cube its own atlas region, `validate_uv` catches
  overlaps before painting, `shade_cubes` paints every part in its exact colour in one call, and there
  are pixel-art palettes and paint tools for hand work.
- **Animate** — create animations, write many bones' keyframes at once (`set_keyframes`), read back
  exactly what was stored, measure a bone's world rotation / position numerically, and lint a whole
  animation — including "does it go through the floor?" — with `check_animation`. Every tool uses the
  values Blockbench shows; the exporter handles the GeckoLib file convention.
- **See the result** — screenshots from any camera angle, also of a specific animation frame
  (`capture_screenshot` with `time`).
- **Export for GeckoLib** — `.geo.json` via `export_model` plus `.animation.json` via `export_animations`.
- **Stay safe** — edits are normal Blockbench undo steps; `save_checkpoint` / `undo` / `redo`;
  `validate_model` checks the rules in [MODELING_CONSTRAINTS.md](MODELING_CONSTRAINTS.md) before export.
- **Guide the AI** — eight bundled skill guides (modeling, texturing, animation, pixel shading, …)
  that the server tells the assistant to read before it starts.

## 🏗️ How it works

```
AI client (Claude Desktop / Claude Code)
        │  MCP over stdio
        ▼
mcp-server  (Node — apps/mcp-server)      ── Socket.IO bridge on port 9999 ──▶
                                                        mcp-plugin (runs inside Blockbench — apps/mcp-plugin)
                                                        calls the Blockbench API, answers every call
```

- The **server** speaks MCP to the AI client and forwards each tool call to the plugin, waiting for
  its answer (each call has its own timeout).
- The **plugin** is a Socket.IO *client*: when Blockbench loads it, it connects to `127.0.0.1:9999`
  by itself and reconnects automatically when the server restarts. There is no "Connect" button.
- The bridge is **local-only**: it listens on `127.0.0.1` and refuses connections from web pages.
- **Several AI clients can share Blockbench.** The first server to start owns port 9999; any later one
  (e.g. Claude Code while the Claude app is open) joins it as a *relay* and sends its calls through
  it. If the owner quits, a relay takes over within a few seconds and the plugin reconnects to it.

More detail: [ARCHITECTURE.md](ARCHITECTURE.md).

## 📦 Requirements

- **Blockbench desktop app** (the plugin is desktop-only; a recent 5.x version is recommended)
- **Node.js 18+**
- **pnpm 10** — only to build from source (`npm install -g pnpm`)

## 🛠️ Installation

### 1. Get the files

**Option A — download a release (no build):** from
[Releases](https://github.com/Nokedli25TTV/Blockbench-MCP/releases/latest) download
`blockbench-mcp-<version>.zip` and unzip it anywhere, e.g. `C:/Tools/Blockbench-MCP`. It already
contains the built server, the plugin and the skill guides, in the same folders as below — no
`pnpm install` needed.

**Option B — clone and build:**

```bash
git clone https://github.com/Nokedli25TTV/Blockbench-MCP.git
cd Blockbench-MCP
pnpm install
pnpm build
```

Either way you get the server (`apps/mcp-server/dist/index.js`) and the plugin
(`apps/mcp-plugin/dist/mcp_socketio_plugin.js`); the paths below are relative to that folder.

### 2. Load the plugin into Blockbench

1. Open Blockbench → **File → Plugins**.
2. Choose **Load Plugin from File** and select `apps/mcp-plugin/dist/mcp_socketio_plugin.js`.
3. The **MCP Command History** panel appears on the right; it lists every command the AI sends.

### 3. Connect your AI client (pick ONE)

**Claude Desktop** — add this to `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`, macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["C:/path/to/Blockbench-MCP/apps/mcp-server/dist/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add blockbench -- node C:/path/to/Blockbench-MCP/apps/mcp-server/dist/index.js
```

> [!NOTE]
> Both can run at once: whichever server starts first owns port 9999 and the other relays through
> it (`get_project_info` shows `mcp_bridge.role`). Calls from both reach the same Blockbench, so
> avoid editing the same model from two chats at the same time.

### 4. Check that it works

Open or create a model in Blockbench, then ask the assistant to call **`get_project_info`**. The reply
contains `plugin_build` (the loaded plugin version) and `tool_count`. If you get `[NOT_CONNECTED]`,
see [Troubleshooting](#-troubleshooting).

## ⚙️ Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `BLOCKBENCH_MCP_PROFILE` | `geckolib` | `geckolib` loads 73 tools and skips 50 that don't apply to cube models (mesh editing, armatures/vertex weights, Bedrock PBR/material instances, brush emulation) — the tool list the AI reads shrinks from ~24k to ~16k tokens. `full` loads all 123. |
| `BLOCKBENCH_MCP_MC_VERSION` | `1.20.1` | Minecraft version a new Java block/item project targets (`create_project` can override it). It decides the rotation rules: up to 1.21.5 one axis at 22.5° steps, 1.21.6–1.21.10 one axis at any angle, from 1.21.11 any axes. |
| `MCP_BRIDGE_PORT` | `9999` | Bridge port. **For tests only** — the plugin always connects to 9999. |

To set the profile, add `"env": { "BLOCKBENCH_MCP_PROFILE": "full" }` next to `"args"` in the Claude
Desktop config, or pass `-e BLOCKBENCH_MCP_PROFILE=full` to `claude mcp add`.

## 🧰 Tools

| Domain | Tools |
|---|---|
| Project | `get_project_info`, `create_project` (new project in `geckolib` / `bedrock` / `java` format), `set_project` |
| Geometry | `create_cubes` (batch), `modify_cubes` (batch), `create_cube`, `create_group`, `modify_cube`, `set_origin`, `set_rotation`, `duplicate_element`, `rename_element`, `reparent_element`, `delete_element` |
| Inspect | `get_scene_tree` (filters: `bone_names`, `include_faces`, `max_depth`), `find_elements_by_criteria`, `get_selection`, `validate_model` |
| Texture / UV | `pack_uv`, `validate_uv`, `create_texture`, `replace_texture`, `apply_texture`, `list_textures`, `get_texture`, `activate_texture` |
| Paint | `shade_cubes` (batch), `shade_cube`, `paint_pixel_matrix`, `draw_shape_tool`, `paint_fill_tool`, `gradient_tool`, `color_picker_tool`, `texture_layer_management`, `list_palettes`, `get_palette` |
| Animation | `create_animation`, `set_keyframes` (batch), `check_animation` (lint + floor check), `manage_keyframes`, `get_keyframes`, `manage_animation` (delete / rename / duplicate), `get_bone_pose`, `animation_timeline`, `animation_graph_editor`, `batch_keyframe_operations`, `animation_copy_paste`, `list_animations` |
| Camera | `capture_screenshot`, `set_camera_angle`, `capture_app_screenshot` |
| History | `save_checkpoint`, `undo`, `redo`, `get_undo_stack` |
| Export | `list_export_formats`, `export_model`, `export_animations` |
| Guides | `list_skills`, `get_skill` (also readable as `skill://…` resources) |
| Escape hatches | `list_actions` + `trigger_action`, `fill_dialog`, `emulate_clicks`, `from_geo_json`, `risky_eval` |

Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`), so clients can tell reads
from edits. Failures start with a stable code: `[NOT_CONNECTED]`, `[TIMEOUT]`, `[NO_PROJECT]`,
`[DUPLICATE_NAME]`, `[NOT_FOUND]`, `[MISSING_TEXTURE]`, `[ILLEGAL_ROTATION]`, `[FORMAT_UNSUPPORTED]`,
`[UV_ERROR]`, `[INVALID_INPUT]` or `[ERROR]`. Non-fatal notes arrive as `⚠️` lines in a successful reply.

## 💬 Usage

### Example requests

- "Create a new GeckoLib project called `dagger` and build a dagger stuck in the ground at an angle."
- "Pack the UVs, then texture the blade steel `#b9c2cb` with a dark edge, the guard gold and the grip brown."
- "Add a 2-second looping idle animation where the head sways a few degrees."
- "Show me the model at 1.0 s of the `idle` animation from the front."
- "Validate the model and export the `.geo.json` and `.animation.json` to my mod's assets folder."

### Tips for fast sessions

Measured over ~1,700 real calls: a tool call takes about **40 ms**, but the pause between calls is about
**10 s** — the session speed comes from how many round-trips there are and how much the AI has to read.

1. **Batch:** `create_cubes`, `modify_cubes`, `shade_cubes`, `set_keyframes` do in one call what used
   to take dozens. They are all-or-nothing and one undo step each.
2. **Read narrowly:** use `get_scene_tree` with `bone_names` / `include_faces:false` on big models.
3. **Screenshots sparingly:** they are downscaled to 800 px (`max_size`); use
   `set_camera_angle screenshot:false` to move the camera and take one screenshot at the end.
4. **Trust the replies:** write tools echo what they stored (e.g. `set_keyframes` lists every channel).

## 🔁 After changing the code

| You changed… | Do this |
|---|---|
| the server (`apps/mcp-server`) | `pnpm --filter mcp-server build`, then **restart the AI client** |
| the plugin (`apps/mcp-plugin`) | `pnpm --filter mcp-plugin build`, then in Blockbench **File → Plugins → reload** the plugin (restarting the AI client does *not* reload it) |

Confirm with `get_project_info`: `plugin_build` is stamped at build time as
`<version>+<UTC date.time>.<git commit>` (`-dirty` = built with uncommitted changes), and
`mcp_bridge.server_version` shows the server.

## 🐛 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server exits with `FATAL: bridge port 9999 is in use by a program that is not a blockbench-mcp bridge` | Some other program holds port 9999. Close it. (Another copy of *this* server is fine — the new one relays through it.) Log (Windows): `%LOCALAPPDATA%\Claude\logs\mcp-server-blockbench.log` (older app versions: `%APPDATA%\Claude\logs`). |
| `[NOT_CONNECTED] Blockbench is not connected` | Blockbench isn't running, the plugin isn't loaded, or no model is open. The plugin reconnects on its own once the server is up. |
| A tool is missing (e.g. `create_sphere`) | It's hidden by the `geckolib` profile — set `BLOCKBENCH_MCP_PROFILE=full`. |
| A code change had no effect | See [After changing the code](#-after-changing-the-code); check `plugin_build`. |
| `[TIMEOUT]` | Blockbench was busy or a dialog was open. The edit may still have happened — check with `get_scene_tree` before retrying. |
| A screenshot shows the rest pose instead of the animation | Pass `time` (and `animation_id`) to `capture_screenshot`. |

## 🔧 Development

```
Blockbench-MCP/
├── apps/
│   ├── mcp-server/        # MCP server: tool registrations, Socket.IO bridge (src/index.ts), skill loader
│   │   ├── test/          # mock-Blockbench harness + full-model test
│   │   └── toolchain-e2e.mjs
│   └── mcp-plugin/        # Blockbench plugin: one handler per tool (src/mcp_socketio_plugin.ts)
├── packages/shared/       # tool-name types, model validation, pixel-art palettes
├── skills/                # the 8 skill guides served to the AI
├── tools/                 # usage report, version bump, release notes
├── .github/workflows/     # CI (Ubuntu + Windows) and the release workflow
├── CHANGELOG.md           # what changed in each version
├── ARCHITECTURE.md        # how it all fits together
├── MODELING_CONSTRAINTS.md
└── AGENTS.md
```

```bash
pnpm build                                  # build server + plugin
pnpm --filter mcp-server dev                # rebuild the server on change
pnpm --filter mcp-plugin dev                # rebuild the plugin on change
pnpm test                                   # model test + e2e against a mock Blockbench (build first)
pnpm typecheck                              # strict tsc for server and plugin
pnpm report                                 # usage report from Claude's logs (add --since 2026-09-01)
```

The tests start the real server on a random port with a simulated Blockbench, so they need neither
Blockbench nor port 9999. They check the server and its wiring (including the shared bridge: relay,
takeover, resend); the Blockbench API calls themselves are only exercised in real Blockbench. CI runs
build, typecheck and tests on every push to `main`.

The plugin is typechecked against `blockbench-types` 5.x (matching Blockbench 5); globals that exist at
runtime but not in the typings (`THREE`, `StateMemory`) are read from `globalThis`.

`pnpm report` reads the Claude app's `mcp-server-blockbench.log` and Claude Code's
`mcp-logs-blockbench/*.jsonl`: call counts, latency, think time between calls, error codes, per-tool
numbers, and bridge events (port conflicts, relay joins, takeovers). Nothing is sent anywhere.

**Adding a tool** touches three places: the `registerTool` call in `apps/mcp-server/src/index.ts`, a
handler plus its dispatch entry in `apps/mcp-plugin/src/mcp_socketio_plugin.ts`, and the `ToolType`
union in `packages/shared/src/types.ts` — plus a mock handler and a check in the tests.

### Versions and releases

Versions follow [Semantic Versioning](https://semver.org/) — **patch** for fixes, **minor** for new
tools or options, **major** for breaking changes (a higher part resets the lower ones: 0.3.2 → minor
→ 0.4.0). The rules with examples are at the top of [CHANGELOG.md](CHANGELOG.md). The version lives
in the four `package.json` files; the server and the plugin read it from there at build time.

1. As you change things, add a line under **Unreleased** in `CHANGELOG.md`.
2. When it's time to release, with a clean working tree:

   ```bash
   pnpm bump patch            # or minor / major / an exact x.y.z; add --dry-run to preview
   ```

   This moves the Unreleased notes under the new version, updates every `package.json`, commits
   `Release vX.Y.Z` and tags `vX.Y.Z`. Nothing is pushed.
3. Push the commit and the tag (`git push <remote> HEAD:main --follow-tags`). The **Release** workflow
   builds, tests and packages it, checks that the unzipped package starts on its own, and creates a
   **draft** GitHub Release with the zip and the plugin. Review it on GitHub and press *Publish*.

To preview a release package without releasing, run the Release workflow by hand (Actions → Release
→ Run workflow); it uploads the zip as an artifact instead.

## ⚠️ Limitations & security

- **`risky_eval` runs arbitrary JavaScript inside Blockbench**, with the app's permissions. Only allow
  it when you understand the code being run.
- **The bridge is local-only:** it listens on `127.0.0.1:9999` (not reachable from the network) and
  refuses Socket.IO connections that come from a web page (an `http`/`https` or sandboxed `null`
  Origin), so a site open in your browser can't pose as Blockbench. The relay endpoint that lets a
  second server share the bridge accepts only requests with no Origin, a custom header and a
  `127.0.0.1`/`localhost` Host. Other programs running on your own machine can still connect.
- `export_model` / `export_animations` can write files to the path you give (Blockbench asks for file
  system permission).
- GeckoLib renders cubes only — mesh elements are dropped on export (`validate_model` warns about it).
- Always save your work before large AI-driven edits; most tool edits are undoable, but a crash is not.

## 📄 License

MIT — see [LICENSE](LICENSE). The original copyright notice is kept.

## 🙏 Acknowledgments

- Original project: [enfp-dev-studio/blockbench-mcp](https://github.com/enfp-dev-studio/blockbench-mcp) by [enfpdev](https://github.com/enfpdev)
- Tool definitions ported from [jasonjgardner/blockbench-mcp-project](https://github.com/jasonjgardner/blockbench-mcp-project)
- Inspired by [BlenderMCP](https://github.com/ahujasid/blender-mcp)
- Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
- Thanks to the Blockbench community for the amazing 3D modeling tool

---

**Disclaimer:** This is a third-party integration and not officially affiliated with Blockbench,
Mojang, GeckoLib or Anthropic.
