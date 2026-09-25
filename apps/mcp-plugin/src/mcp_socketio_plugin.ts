// Register the plugin and define what it adds

import { io } from "socket.io-client";
import { ToolType } from "@blockbench-mcp/shared/types";
import { getPalette } from "../../../packages/shared/src/palettes";
import { rulesFor, checkRotation, checkBounds, javaBlockVersionFor, javaVersionLabel } from "../../../packages/shared/src/formatRules";
import type { FormatInfo, FormatRules } from "../../../packages/shared/src/formatRules";
import { paintFace, rampFromBase, seedFrom, MATERIALS } from "../../../packages/shared/src/facePainter";
import type { FaceKey, Material } from "../../../packages/shared/src/facePainter";
import { worldPoints, boxOf, throughChain, toModelDelta, placementDelta, anchorPoint, mirroredName, mirrorCoord, shiftBox, roundVec, SIDES, ALIGNS, ANCHORS } from "../../../packages/shared/src/placement";
import type { GeoNode, Frame, Box, Side, Align, Anchor } from "../../../packages/shared/src/placement";
import type { Vec3 } from "../../../packages/shared/src/types";
import { VIEWS, viewDirection, fitDistance, sheetLayout, sheetCell } from "../../../packages/shared/src/views";
import type { View } from "../../../packages/shared/src/views";

// Global variable declarations
let mcpPanel: Panel;
let mcpSocket: ReturnType<typeof io> | null = null;
let mcpInterval: ReturnType<typeof setInterval> | null = null;
let commandListElement: HTMLElement;
const commandHistory: Array<{ timestamp: Date; type: 'sent' | 'received'; command: string; data?: any }> = [];
// Reported by get_project_info so you can confirm Blockbench loaded THIS build
// after a rebuild (File → Plugins → reload). Stamped by vite.config.ts at build time.
declare const __PLUGIN_VERSION__: string;
declare const __PLUGIN_BUILD__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0';
const PLUGIN_BUILD = typeof __PLUGIN_BUILD__ !== 'undefined' ? __PLUGIN_BUILD__ : 'dev';
let pluginToolCount = 0; // set from the dispatch map on every tool call

// blockbench-types 5 keeps PluginOptions module-private; take it from register().
const options: Parameters<typeof BBPlugin.register>[1] = {
  title: "MCP Plugin",
  // Original plugin by enfpdev; this is a personal fork.
  author: "enfpdev (fork: Nokedli25TTV)",
  description: "A plugin for interacting with MCP using Socket.IO.",
  about:
    "This plugin allows you to connect to the MCP server using Socket.IO and provides various utilities for interacting with it.",
  version: PLUGIN_VERSION,
  icon: "icon.png",
  tags: ["mcp", "ai", "agent"],
  variant: "desktop",
  await_loading: true,
  new_repository_format: true,
  website: "https://github.com/Nokedli25TTV/Blockbench-MCP",
  repository: "https://github.com/Nokedli25TTV/Blockbench-MCP",
  onload: () => {
    // 127.0.0.1, not "localhost": the server binds to IPv4 loopback only, and
    // "localhost" may resolve to IPv6 ::1 first on Windows.
    const socket = io("http://127.0.0.1:9999");
    mcpSocket = socket;

    // Function to update the command history HTML
    const updateCommandDisplay = () => {
      if (!commandListElement) return;

      if (commandHistory.length === 0) {
        commandListElement.innerHTML = '<div class="mcp-empty">No command history yet.</div>';
        return;
      }

      const commandsHtml = commandHistory.map(entry => {
        const timeStr = entry.timestamp.toLocaleTimeString();
        const typeIcon = entry.type === 'sent' ? '↗️' : '↙️';
        const typeClass = entry.type === 'sent' ? 'mcp-sent' : 'mcp-received';
        const dataHtml = entry.data ? 
          `<div class="mcp-data">${JSON.stringify(entry.data, null, 2)}</div>` : '';
        
        return `
          <div class="mcp-command-item ${typeClass}">
            <div class="mcp-time">${timeStr}</div>
            <div class="mcp-command">
              <span class="mcp-icon">${typeIcon}</span>
              <span class="mcp-name">${entry.command}</span>
            </div>
            ${dataHtml}
          </div>
        `;
      }).join('');

      commandListElement.innerHTML = commandsHtml;
      
      // Scroll to the bottom
      commandListElement.scrollTop = commandListElement.scrollHeight;
    };

    // Create the MCP command history panel
    mcpPanel = new Panel('mcp_command_history', {
      id: 'mcp_command_history',
      name: 'MCP Command History',
      icon: 'history',
      growable: true,
      resizable: true,
      expand_button: true,
      default_side: 'right',
      default_position: {
        slot: 'right_bar',
        float_position: [100, 100],
        float_size: [400, 500],
        height: 400,
        folded: false
      },
      component: {
        name: 'mcp-command-history',
        template: `
          <div class="mcp-command-history">
            <div class="mcp-header">
              <h3>MCP Command History</h3>
              <div class="mcp-stats">${commandHistory.length} commands total</div>
            </div>
            <div class="mcp-content" ref="commandList">
              <div class="mcp-empty">No command history yet.</div>
            </div>
          </div>
        `,
        mounted() {
          const refs = (this as any).$refs;
          if (refs && refs.commandList) {
            commandListElement = refs.commandList;
            updateCommandDisplay();
          }
        }
      }
    });

    // Add panel styles
    const style = document.createElement('style');
    style.textContent = `
      .mcp-command-history {
        height: 100%;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      }
      .mcp-header {
        padding: 10px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-ui);
      }
      .mcp-header h3 {
        margin: 0 0 5px 0;
        font-size: 14px;
        font-weight: 600;
      }
      .mcp-stats {
        font-size: 11px;
        color: var(--color-subtle_text);
      }
      .mcp-content {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
      }
      .mcp-empty {
        text-align: center;
        color: var(--color-subtle_text);
        font-style: italic;
        padding: 20px;
      }
      .mcp-command-item {
        margin-bottom: 12px;
        padding: 8px;
        border-radius: 4px;
        border-left: 3px solid transparent;
        background: var(--color-ui);
      }
      .mcp-command-item.mcp-sent {
        border-left-color: #4CAF50;
        background: rgba(76, 175, 80, 0.1);
      }
      .mcp-command-item.mcp-received {
        border-left-color: #2196F3;
        background: rgba(33, 150, 243, 0.1);
      }
      .mcp-time {
        font-size: 10px;
        color: var(--color-subtle_text);
        margin-bottom: 4px;
      }
      .mcp-command {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .mcp-icon {
        font-size: 12px;
      }
      .mcp-name {
        font-weight: 600;
        font-size: 12px;
      }
      .mcp-data {
        margin-top: 4px;
        font-family: 'Monaco', 'Menlo', monospace;
        font-size: 10px;
        background: rgba(0, 0, 0, 0.1);
        padding: 4px 6px;
        border-radius: 2px;
        white-space: pre-wrap;
        max-height: 100px;
        overflow-y: auto;
      }
    `;
    document.head.appendChild(style);

    // Add a panel toggle button to the toolbar
    new Action('mcp_toggle_panel', {
      name: 'Toggle MCP Command Panel',
      icon: 'history',
      click: () => {
        // Toggle panel visibility
        const panelElement = document.getElementById('panel_mcp_command_history');
        if (panelElement) {
          const isVisible = panelElement.style.display !== 'none';
          panelElement.style.display = isVisible ? 'none' : 'block';
        }
      }
    });

    // Function to refresh the command history
    const updateCommandHistory = () => {
      updateCommandDisplay();
      // Update the stats in the header
      const statsElement = document.querySelector('.mcp-stats');
      if (statsElement) {
        statsElement.textContent = `${commandHistory.length} commands total`;
      }
    };

    // Push a diagnostic line into the history panel so errors are visible in-UI too.
    const logToHistory = (message: string, data?: any) => {
      commandHistory.push({
        timestamp: new Date(),
        type: 'received',
        command: message,
        data,
      });
      updateCommandHistory();
    };

    // --- Shared Blockbench helpers (used by all tool handlers) -------------
    const isVec3 = (v: any): v is [number, number, number] =>
      Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));

    const isVec2 = (v: any): v is [number, number] =>
      Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && isFinite(n));

    // Resolve the {autouv, uv_offset} a cube should be built/extended with. A manual
    // uv_offset implies box-UV lock (autouv:0) unless the caller overrides it —
    // otherwise Blockbench re-derives box-UV and the offset collapses to [0,0] (the
    // recurring "everything one colour" bug). Mirrors modify_cube's rule.
    const resolveCubeUv = (input: { uv_offset?: any; autouv?: any }): { autouv: 0 | 1 | 2; uv_offset?: [number, number] } => {
      const autouv = input.autouv !== undefined
        ? (Number(input.autouv) as 0 | 1 | 2)
        : (input.uv_offset !== undefined ? 0 : 1);
      return input.uv_offset !== undefined ? { autouv, uv_offset: input.uv_offset } : { autouv };
    };

    const nonZeroAxes = (v: number[]): number => v.filter((n) => Math.abs(n) > 1e-6).length;
    const MIN_TEXTURED_CUBE_SIZE = 1;

    // Thin/flat cubes are legitimate (wings, ears, capes, 0.5-unit trims), so this
    // WARNS instead of rejecting: faces under 1 texel get zero-size or fractional
    // box-UV rects, which pack_uv cannot fix and GeckoLib may render oddly.
    const thinCubeWarning = (from: number[], to: number[], context: string): string | null => {
      const dims = [Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]), Math.abs(to[2] - from[2])];
      const tooSmall = dims.findIndex((n) => n < MIN_TEXTURED_CUBE_SIZE);
      return tooSmall >= 0
        ? `${context} is thinner than ${MIN_TEXTURED_CUBE_SIZE} unit on an axis [${dims.join(', ')}]: fine for flat/detail parts, but its thin faces get zero-size or fractional UVs — check the texture there.`
        : null;
    };

    const allCubes = (): any[] => (typeof Cube !== 'undefined' && (Cube as any).all) ? (Cube as any).all : [];
    const allGroups = (): any[] => (typeof Group !== 'undefined' && (Group as any).all) ? (Group as any).all : [];

    const nameTaken = (n: string): boolean =>
      allCubes().some((c: any) => c.name === n) || allGroups().some((g: any) => g.name === n);

    const findGroupByName = (n: string): any => allGroups().find((g: any) => g.name === n);
    const findCubeByName = (n: string): any => allCubes().find((c: any) => c.name === n);

    const hasProject = (): boolean => !(typeof Project === 'undefined' || !Project);
    // The open project's format flags → where rotation may go and within which
    // limits (packages/shared/src/formatRules.ts; MODELING_CONSTRAINTS.md rule 1).
    const currentFormatInfo = (): FormatInfo => {
      const f: any = typeof Format !== 'undefined' ? Format : null;
      if (!f) return {};
      return {
        id: f.id,
        bone_rig: !!f.bone_rig,
        rotate_cubes: !!f.rotate_cubes,
        java_block_version: f.id === 'java_block' ? ((Project as any)?.java_block_version ?? null) : null,
        coordinate_limits: f.cube_size_limiter?.coordinate_limits ?? null,
      };
    };
    const currentRules = (): FormatRules => rulesFor(currentFormatInfo());
    const rulesInfo = (rules: FormatRules) => ({
      summary: rules.summary,
      bone_rotation: rules.bone.allowed ? { axes: rules.bone.maxAxes, ...(rules.bone.angles ? { angles: rules.bone.angles } : {}) } : false,
      cube_rotation: rules.cube.allowed ? { axes: rules.cube.maxAxes, ...(rules.cube.angles ? { angles: rules.cube.angles } : {}) } : false,
      coordinate_limits: rules.coordinateLimits,
    });
    // Blockbench 5 has no setProjectResolution(): set the size, then let Blockbench
    // refresh the UV editor and UV density (checked live on 5.2.1).
    const setTextureResolution = (width?: number, height?: number) => {
      if (typeof width === 'number' && width > 0) (Project as any).texture_width = width;
      if (typeof height === 'number' && height > 0) (Project as any).texture_height = height;
      if (typeof updateProjectResolution === 'function') updateProjectResolution();
    };

    // Create a real cube in the current Blockbench project using the Blockbench API.
    // Returns a result object that is sent back to the MCP server as an ack.
    const createCube = (input: {
      name?: string;
      from?: [number, number, number];
      to?: [number, number, number];
      size?: number;
      origin?: [number, number, number];
      rotation?: [number, number, number];
      parent?: string;
      uv_offset?: [number, number];
      autouv?: 0 | 1 | 2 | "0" | "1" | "2";
    }): { ok: boolean; name?: string; from?: number[]; to?: number[]; error?: string; warning?: string } => {
      try {
        console.log('[MCP Plugin] createCube called with', input);

        // A project (and a loaded format) must exist before we can add elements.
        if (typeof Project === 'undefined' || !Project) {
          const msg = 'No project open — create or open a model first.';
          console.warn('[MCP] ' + msg);
          Blockbench.showStatusMessage('[MCP] ' + msg, 5000);
          logToHistory('error: no project open');
          return { ok: false, error: msg };
        }

        // --- Validation (see MODELING_CONSTRAINTS.md) ---------------------
        if (input.from !== undefined && !isVec3(input.from)) {
          return { ok: false, error: "'from' must be 3 finite numbers [x,y,z] (rule #5)." };
        }
        if (input.to !== undefined && !isVec3(input.to)) {
          return { ok: false, error: "'to' must be 3 finite numbers [x,y,z] (rule #5)." };
        }
        if (input.origin !== undefined && !isVec3(input.origin)) {
          return { ok: false, error: "'origin' must be 3 finite numbers [x,y,z] (rule #1: define pivot explicitly)." };
        }
        if (input.size !== undefined && (typeof input.size !== 'number' || !isFinite(input.size) || input.size <= 0)) {
          return { ok: false, error: "'size' must be a positive finite number (rule #5)." };
        }
        if (input.uv_offset !== undefined && !isVec2(input.uv_offset)) {
          return { ok: false, error: "'uv_offset' must be 2 finite numbers [u,v]." };
        }

        const rawFrom: [number, number, number] = input.from || [0, 0, 0];
        const size = typeof input.size === 'number' ? input.size : 8;
        const rawTo: [number, number, number] = input.to || [rawFrom[0] + size, rawFrom[1] + size, rawFrom[2] + size];
        // Normalize corners to min/max so the box is never inverted/degenerate (rule #5).
        const from: [number, number, number] = [Math.min(rawFrom[0], rawTo[0]), Math.min(rawFrom[1], rawTo[1]), Math.min(rawFrom[2], rawTo[2])];
        const to: [number, number, number] = [Math.max(rawFrom[0], rawTo[0]), Math.max(rawFrom[1], rawTo[1]), Math.max(rawFrom[2], rawTo[2])];
        const sizeWarning = thinCubeWarning(from, to, `Cube "${input.name || 'new cube'}"`);
        const rules = currentRules();
        const boundsError = checkBounds(rules, from, to, `Cube "${input.name || 'new cube'}"`);
        if (boundsError) return { ok: false, error: `${boundsError} (rule #5)` };
        if (input.rotation !== undefined) {
          if (!isVec3(input.rotation)) return { ok: false, error: "'rotation' must be 3 finite numbers [x,y,z] degrees." };
          const rotationError = checkRotation(rules.cube, input.rotation, `Cube "${input.name || 'new cube'}"`);
          if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };
        }

        // Unique, stable name across all cubes and groups (rule #4).
        let name: string;
        if (input.name) {
          if (nameTaken(input.name)) {
            return {
              ok: false,
              error: `Name "${input.name}" already exists. Names must be unique (rule #4) — pick a descriptive, unique name like "staff_handle".`,
            };
          }
          name = input.name;
        } else {
          // No name supplied: generate a unique, non-colliding fallback.
          let i = 1;
          while (nameTaken(`element_${i}`)) i++;
          name = `element_${i}`;
        }

        // Resolve an explicit parent group up front so we fail before creating anything.
        let parentGroup: any = null;
        if (input.parent) {
          parentGroup = findGroupByName(input.parent);
          if (!parentGroup) return { ok: false, error: `Parent group "${input.parent}" not found.` };
        }

        Undo.initEdit({ elements: [], outliner: true, selection: true });

        // Mirror Blockbench's own "add_cube": init() registers the element (and
        // places it at root); only call addTo() when nesting under a group.
        // select() is wrapped and finishEdit() is GUARANTEED to run, so a throw
        // from select()/addTo never (a) propagates, (b) skips the undo entry, or
        // (c) leaves an orphan that undo can't remove (live bug 2026-06-13).
        let cube: any = null;
        let createError: any = null;
        try {
          // autouv:1 = Box UV auto-mapping so faces aren't left at [0,0] on export;
          // a manual uv_offset flips it to autouv:0 (box-UV lock) so the offset sticks.
          cube = new Cube({
            name,
            from,
            to,
            origin: input.origin || from,
            ...(input.rotation ? { rotation: [...input.rotation] as [number, number, number] } : {}),
            ...resolveCubeUv(input),
          }).init();

          if (parentGroup) {
            cube.addTo(parentGroup);
          } else if (typeof Group !== 'undefined' && Group.selected) {
            cube.addTo(Group.selected);
          }
          // else: init() already placed it at root — do NOT addTo (matches core).

          try {
            cube.select();
          } catch (selErr) {
            console.warn('[MCP Plugin] cube.select() failed (non-fatal):', selErr);
          }
        } catch (e: any) {
          createError = e;
        }

        // Always close the edit so the create is a single undoable step.
        Undo.finishEdit('Create cube via MCP', { elements: cube ? [cube] : [], outliner: true, selection: true });

        if (typeof Canvas !== 'undefined' && Canvas.updateAll) {
          Canvas.updateAll();
        }

        if (!cube) {
          return { ok: false, error: createError?.message || String(createError) };
        }

        console.log('[MCP Plugin] Cube created:', cube);
        Blockbench.showStatusMessage(`[MCP] Created cube "${name}".`, 4000);
        logToHistory(`created cube "${name}"`);
        return { ok: true, name, from, to, ...(sizeWarning ? { warning: sizeWarning } : {}) };
      } catch (err: any) {
        console.error('[MCP Plugin] createCube failed:', err);
        Blockbench.showStatusMessage(`[MCP] Cube failed: ${err?.message || err}`, 6000);
        logToHistory('error: ' + (err?.message || String(err)), { stack: err?.stack });
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Create a named group / GeckoLib bone, optionally nested under a parent (rule #4/#6).
    const createGroup = (input: { name?: string; parent?: string; origin?: [number, number, number]; rotation?: [number, number, number] }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open — create or open a model first.' };
        if (!input.name) return { ok: false, error: 'A unique, descriptive group name is required (rule #4).' };
        if (nameTaken(input.name)) return { ok: false, error: `Name "${input.name}" already exists. Names must be unique (rule #4).` };
        if (input.origin !== undefined && !isVec3(input.origin)) {
          return { ok: false, error: "'origin' must be 3 finite numbers [x,y,z] (rule #1)." };
        }
        if (input.rotation !== undefined) {
          if (!isVec3(input.rotation)) return { ok: false, error: "'rotation' must be 3 finite numbers [x,y,z] degrees." };
          const rotationError = checkRotation(currentRules().bone, input.rotation, `Group "${input.name}"`);
          if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };
        }

        let parentGroup: any = null;
        if (input.parent) {
          parentGroup = findGroupByName(input.parent);
          if (!parentGroup) return { ok: false, error: `Parent group "${input.parent}" not found.` };
        }

        Undo.initEdit({ outliner: true, elements: [], selection: true });
        // Mirror Blockbench core: init() places it at root; addTo only when nesting.
        // select() wrapped + finishEdit guaranteed (same robustness as create_cube).
        let group: any = null;
        let createError: any = null;
        try {
          group = new Group({ name: input.name, origin: input.origin || [0, 0, 0], ...(input.rotation ? { rotation: [...input.rotation] } : {}) }).init();
          if (parentGroup) group.addTo(parentGroup);
          try {
            if (typeof group.select === 'function') group.select();
          } catch (selErr) {
            console.warn('[MCP Plugin] group.select() failed (non-fatal):', selErr);
          }
        } catch (e: any) {
          createError = e;
        }
        Undo.finishEdit('Create group via MCP', { outliner: true, selection: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        if (!group) return { ok: false, error: createError?.message || String(createError) };
        logToHistory(`created group "${group.name}"`);
        return { ok: true, name: group.name, uuid: group.uuid, parent: parentGroup ? parentGroup.name : null };
      } catch (err: any) {
        console.error('[MCP Plugin] createGroup failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Batch-create a whole sub-hierarchy (groups + cubes) in ONE call and ONE undo
    // step — the single biggest tool-call reducer (a 25-cube model drops from ~50
    // calls to 1). Everything is validated UP FRONT (names, vecs, parent refs) so the
    // batch either fully applies or fails cleanly with nothing created. A parent may
    // reference a group created EARLIER in this batch's groups[] or one that already
    // exists. Groups are created first (in array order), then cubes.
    const createCubes = (input: {
      groups?: Array<{ name?: string; parent?: string; origin?: [number, number, number]; rotation?: [number, number, number] }>;
      cubes?: Array<{ name?: string; from?: [number, number, number]; to?: [number, number, number]; size?: number; origin?: [number, number, number]; rotation?: [number, number, number]; parent?: string; uv_offset?: [number, number]; autouv?: 0 | 1 | 2 | "0" | "1" | "2" }>;
    }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open — create or open a model first.' };
        const groups = Array.isArray(input.groups) ? input.groups : [];
        const cubes = Array.isArray(input.cubes) ? input.cubes : [];
        if (groups.length === 0 && cubes.length === 0) {
          return { ok: false, error: 'Provide at least one group or cube to create (groups[] and/or cubes[]).' };
        }

        // ---- Pre-validation: no side effects, so a bad batch creates nothing ----
        const pending = new Set<string>();        // names that WILL exist after this batch
        const batchGroupNames = new Set<string>(); // group names declared in-batch, for parent refs
        const reserve = (n: string): string | null => {
          if (nameTaken(n)) return `Name "${n}" already exists (rule #4) — names must be unique.`;
          if (pending.has(n)) return `Name "${n}" is used twice within the batch (rule #4).`;
          pending.add(n);
          return null;
        };

        const rules = currentRules();
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          if (!g || !g.name) return { ok: false, error: `groups[${i}]: a unique, descriptive name is required (rule #4).` };
          if (g.origin !== undefined && !isVec3(g.origin)) return { ok: false, error: `groups[${i}] ("${g.name}"): 'origin' must be 3 finite numbers [x,y,z] (rule #1).` };
          if (g.rotation !== undefined) {
            if (!isVec3(g.rotation)) return { ok: false, error: `groups[${i}] ("${g.name}"): 'rotation' must be 3 finite numbers [x,y,z] degrees.` };
            const rotationError = checkRotation(rules.bone, g.rotation, `groups[${i}] ("${g.name}")`);
            if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };
          }
          if (g.parent && !batchGroupNames.has(g.parent) && !findGroupByName(g.parent)) {
            return { ok: false, error: `groups[${i}] ("${g.name}"): parent "${g.parent}" not found. Declare it earlier in groups[] or create it first.` };
          }
          const err = reserve(g.name); if (err) return { ok: false, error: `groups[${i}]: ${err}` };
          batchGroupNames.add(g.name);
        }
        for (let i = 0; i < cubes.length; i++) {
          const c = cubes[i];
          if (!c) return { ok: false, error: `cubes[${i}]: missing entry.` };
          for (const key of ['from', 'to', 'origin'] as const) {
            if (c[key] !== undefined && !isVec3(c[key])) return { ok: false, error: `cubes[${i}]: '${key}' must be 3 finite numbers [x,y,z] (rule #5).` };
          }
          if (c.size !== undefined && (typeof c.size !== 'number' || !isFinite(c.size) || c.size <= 0)) {
            return { ok: false, error: `cubes[${i}]: 'size' must be a positive finite number (rule #5).` };
          }
          if (c.uv_offset !== undefined && !isVec2(c.uv_offset)) return { ok: false, error: `cubes[${i}]: 'uv_offset' must be 2 finite numbers [u,v].` };
          if (c.rotation !== undefined) {
            if (!isVec3(c.rotation)) return { ok: false, error: `cubes[${i}]: 'rotation' must be 3 finite numbers [x,y,z] degrees.` };
            const rotationError = checkRotation(rules.cube, c.rotation, `cubes[${i}]${c.name ? ` ("${c.name}")` : ''}`);
            if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };
          }
          {
            const f0: [number, number, number] = c.from || [0, 0, 0];
            const s0 = typeof c.size === 'number' ? c.size : 8;
            const t0: [number, number, number] = c.to || [f0[0] + s0, f0[1] + s0, f0[2] + s0];
            const lo: [number, number, number] = [Math.min(f0[0], t0[0]), Math.min(f0[1], t0[1]), Math.min(f0[2], t0[2])];
            const hi: [number, number, number] = [Math.max(f0[0], t0[0]), Math.max(f0[1], t0[1]), Math.max(f0[2], t0[2])];
            const boundsError = checkBounds(rules, lo, hi, `cubes[${i}]${c.name ? ` ("${c.name}")` : ''}`);
            if (boundsError) return { ok: false, error: `${boundsError} (rule #5)` };
          }
          if (c.parent && !batchGroupNames.has(c.parent) && !findGroupByName(c.parent)) {
            return { ok: false, error: `cubes[${i}]: parent "${c.parent}" not found. Declare it in groups[] or create it first.` };
          }
          if (c.name) { const err = reserve(c.name); if (err) return { ok: false, error: `cubes[${i}]: ${err}` }; }
        }

        // ---- Apply in a single undo transaction --------------------------------
        const createdGroupsByName = new Map<string, any>();
        const createdGroups: any[] = [];
        const createdCubes: any[] = [];
        const warnings: string[] = [];
        // A parent resolves to a group made in THIS batch first, else an existing one.
        // Note: unlike create_cube, the batch never falls back to Group.selected —
        // parents are always explicit, so the result is deterministic.
        const resolveParent = (name?: string): any =>
          name ? (createdGroupsByName.get(name) || findGroupByName(name)) : null;

        Undo.initEdit({ elements: [], outliner: true, selection: true });
        let failure: string | null = null;
        try {
          for (const g of groups) {
            const group = new Group({ name: g.name!, origin: g.origin || [0, 0, 0], ...(g.rotation ? { rotation: [...g.rotation] } : {}) }).init();
            const parent = resolveParent(g.parent);
            if (parent) group.addTo(parent);
            createdGroupsByName.set(g.name!, group);
            createdGroups.push(group);
          }
          let autoIdx = 1;
          for (const c of cubes) {
            let name = c.name;
            if (!name) { while (nameTaken(`element_${autoIdx}`) || pending.has(`element_${autoIdx}`)) autoIdx++; name = `element_${autoIdx}`; pending.add(name); }
            const rawFrom: [number, number, number] = c.from || [0, 0, 0];
            const size = typeof c.size === 'number' ? c.size : 8;
            const rawTo: [number, number, number] = c.to || [rawFrom[0] + size, rawFrom[1] + size, rawFrom[2] + size];
            const from: [number, number, number] = [Math.min(rawFrom[0], rawTo[0]), Math.min(rawFrom[1], rawTo[1]), Math.min(rawFrom[2], rawTo[2])];
            const to: [number, number, number] = [Math.max(rawFrom[0], rawTo[0]), Math.max(rawFrom[1], rawTo[1]), Math.max(rawFrom[2], rawTo[2])];
            const sizeWarning = thinCubeWarning(from, to, `Cube "${name}"`);
            if (sizeWarning) warnings.push(sizeWarning);
            const cube = new Cube({ name, from, to, origin: c.origin || from, ...(c.rotation ? { rotation: [...c.rotation] as [number, number, number] } : {}), ...resolveCubeUv(c) }).init();
            const parent = resolveParent(c.parent);
            if (parent) cube.addTo(parent);
            createdCubes.push(cube);
          }
        } catch (e: any) {
          failure = e?.message || String(e);
        }

        if (failure) {
          // Never leave a half-built tree: roll the whole batch back.
          if (typeof (Undo as any).cancelEdit === 'function') {
            (Undo as any).cancelEdit();
          } else {
            for (const el of [...createdCubes, ...createdGroups]) { try { el.remove(); } catch { /* */ } }
            Undo.finishEdit('Create cubes via MCP (rolled back)', { elements: [], outliner: true, selection: true });
          }
          if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
          return { ok: false, error: `Batch failed and was rolled back (nothing created): ${failure}` };
        }

        Undo.finishEdit('Create cubes via MCP', { elements: createdCubes, outliner: true, selection: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        const groupNames = createdGroups.map((g) => g.name);
        const cubeNames = createdCubes.map((c) => c.name);
        Blockbench.showStatusMessage(`[MCP] Created ${groupNames.length} group(s) + ${cubeNames.length} cube(s).`, 4000);
        logToHistory(`batch created ${groupNames.length} group(s) + ${cubeNames.length} cube(s)`);
        return { ok: true, groups: groupNames, cubes: cubeNames, ...(warnings.length ? { warnings } : {}) };
      } catch (err: any) {
        console.error('[MCP Plugin] createCubes failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Set the pivot/origin of a GROUP — or of a CUBE where the format rotates cubes
    // (Java block/item rotation lives on the cube) — rule #1: pivot-first.
    // Set a pivot by value, or by `anchor`: the centre (or a side's centre) of the part's own
    // geometry, measured before its own rotation — "the shoulder is the top of the arm".
    const setOrigin = (input: { target?: string; origin?: [number, number, number]; anchor?: string }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.target) return { ok: false, error: 'target (group name) is required.' };
        const anchor = input.anchor as Anchor | undefined;
        if (anchor !== undefined && input.origin !== undefined) return { ok: false, error: "Give 'origin' [x,y,z] or 'anchor', not both." };
        if (anchor !== undefined && !(ANCHORS as readonly string[]).includes(anchor)) return { ok: false, error: `anchor must be one of ${ANCHORS.join(', ')}.` };
        if (anchor === undefined && !isVec3(input.origin)) return { ok: false, error: "'origin' must be 3 finite numbers [x,y,z] (rule #1) — or give 'anchor' (e.g. 'top') to put the pivot on the part's own geometry." };
        const pivotFor = (n: any): Vec3 | string => {
          if (anchor === undefined) return v3(input.origin);
          const g = toGeoNode(n);
          const points = !g ? [] : g.kind === 'group' ? (g.children || []).flatMap((c) => worldPoints(c, [])) : worldPoints({ ...g, rotation: [0, 0, 0] }, []);
          const box = boxOf(points);
          return box ? anchorPoint(box, anchor) : `"${n.name}" has no geometry to anchor a pivot to — give 'origin' instead.`;
        };
        const cubeTarget = findCubeByName(input.target);
        if (cubeTarget) {
          const rules = currentRules();
          if (!rules.cube.allowed) return { ok: false, error: `"${input.target}" is a cube, and cubes don't rotate in this format — set the pivot of its group instead.` };
          const origin = pivotFor(cubeTarget);
          if (typeof origin === 'string') return { ok: false, error: origin };
          Undo.initEdit({ elements: [cubeTarget] });
          cubeTarget.origin = origin;
          Undo.finishEdit('Set origin via MCP', { elements: [cubeTarget] });
          if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
          logToHistory(`set origin of cube "${cubeTarget.name}"`);
          return { ok: true, name: cubeTarget.name, origin: cubeTarget.origin, type: 'cube', ...(anchor ? { anchor } : {}) };
        }
        const group = findGroupByName(input.target);
        if (!group) return { ok: false, error: `Group "${input.target}" not found.` };
        const origin = pivotFor(group);
        if (typeof origin === 'string') return { ok: false, error: origin };
        const moved = !isVec3(group.origin) || [0, 1, 2].some((i) => Math.abs(group.origin[i] - origin[i]) > 1e-6);

        Undo.initEdit({ outliner: true, elements: [] });
        group.origin = origin;
        Undo.finishEdit('Set origin via MCP', { outliner: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`set origin of "${group.name}"`);
        return {
          ok: true, name: group.name, origin: group.origin, ...(anchor ? { anchor } : {}),
          warning: moved && nonZeroAxes(v3(group.rotation)) > 0
            ? 'this group is already rotated, so a new pivot swings the part somewhere else — set pivots before rotating (rule #1).'
            : undefined,
        };
      } catch (err: any) {
        console.error('[MCP Plugin] setOrigin failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Rotate a group/bone or a cube, as the open project's format allows (rule #1,
    // formatRules.ts): GeckoLib/Bedrock bones and cubes on any axes; Java block/item
    // only cubes (groups don't export rotation), within the target version's limits.
    const setRotation = (input: { target?: string; rotation?: [number, number, number] }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.target) return { ok: false, error: 'target (group or cube name) is required.' };
        if (!isVec3(input.rotation)) return { ok: false, error: "'rotation' must be 3 finite numbers [x,y,z] degrees (rule #1)." };
        const rules = currentRules();

        const cube = findCubeByName(input.target);
        if (cube) {
          const rotationError = checkRotation(rules.cube, input.rotation, `Cube "${cube.name}"`);
          if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };
          Undo.initEdit({ elements: [cube] });
          cube.rotation = [input.rotation[0], input.rotation[1], input.rotation[2]];
          Undo.finishEdit('Set rotation via MCP', { elements: [cube] });
          if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
          // A cube's default pivot is its `from` corner: fine for a hinge, rarely what a
          // centred tilt wants.
          const atCorner = nonZeroAxes(input.rotation) > 0 && [0, 1, 2].every((i) => Math.abs(cube.origin[i] - cube.from[i]) < 1e-6);
          const centre = [0, 1, 2].map((i) => (cube.from[i] + cube.to[i]) / 2);
          logToHistory(`rotated cube "${cube.name}"`);
          return {
            ok: true,
            name: cube.name,
            rotation: cube.rotation,
            type: 'cube',
            warning: atCorner ? `pivot is the cube's corner [${cube.origin.join(', ')}] — for a centred tilt set its origin to [${centre.join(', ')}] (set_origin or modify_cube origin).` : undefined,
          };
        }

        const group = findGroupByName(input.target);
        if (!group) return { ok: false, error: `No group or cube named "${input.target}".` };
        const rotationError = checkRotation(rules.bone, input.rotation, `Group "${group.name}"`);
        if (rotationError) return { ok: false, error: `${rotationError} (rule #1)` };

        Undo.initEdit({ outliner: true, elements: [] });
        group.rotation = [input.rotation[0], input.rotation[1], input.rotation[2]];
        Undo.finishEdit('Set rotation via MCP', { outliner: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        // A [0,0,0] pivot is only suspicious when it lies outside the bone's own cubes
        // (a forgotten set_origin). Inside them it is usually deliberate — e.g. a
        // blade rotating around its tip at the origin — so don't nag then.
        const origin = group.origin || [0, 0, 0];
        const pivotSet = origin.some((n: number) => Math.abs(n) > 1e-6);
        let pivotInsideCubes = false;
        if (!pivotSet) {
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          const visit = (children: any[]) => {
            for (const ch of children || []) {
              if (typeof Group !== 'undefined' && ch instanceof Group) { visit(ch.children); continue; }
              if (!isVec3(ch.from) || !isVec3(ch.to)) continue;
              for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], ch.from[i], ch.to[i]); hi[i] = Math.max(hi[i], ch.from[i], ch.to[i]); }
            }
          };
          visit(group.children);
          pivotInsideCubes = [0, 1, 2].every((i) => lo[i] <= 1e-6 && hi[i] >= -1e-6);
        }
        logToHistory(`rotated "${group.name}"`);
        return {
          ok: true,
          name: group.name,
          rotation: group.rotation,
          warning: pivotSet || pivotInsideCubes ? undefined : "pivot/origin is [0,0,0], outside this bone's cubes — call set_origin first unless that is intended (rule #1).",
        };
      } catch (err: any) {
        console.error('[MCP Plugin] setRotation failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Return the full outliner hierarchy + registered textures as a plain JSON tree.
    // Optional filters keep the payload small on big models (the default — no
    // filters — returns the FULL tree, byte-for-byte as before, which validate_model
    // relies on): `bone_names` scopes the result to those bones' subtrees,
    // `include_faces:false` drops per-cube face data, `max_depth` caps nesting.
    const getSceneTree = (input?: { bone_names?: string[]; include_faces?: boolean; max_depth?: number }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const includeFaces = input?.include_faces !== false; // default true (back-compat)
        const maxDepth = (typeof input?.max_depth === 'number' && isFinite(input.max_depth) && input.max_depth >= 0)
          ? Math.floor(input.max_depth) : undefined;

        const mapNode = (node: any, depth: number): any => {
          const isGroup = (typeof Group !== 'undefined' && node instanceof Group) || node.type === 'group';
          if (isGroup) {
            const out: any = {
              type: 'group',
              uuid: node.uuid,
              name: node.name,
              origin: node.origin ? [...node.origin] : [0, 0, 0],
              rotation: node.rotation ? [...node.rotation] : [0, 0, 0],
            };
            const kids = node.children || [];
            if (maxDepth !== undefined && depth >= maxDepth) {
              // Cap reached: omit deeper nodes but tell the caller how many were hidden
              // so it can re-query that subtree with bone_names + a larger max_depth.
              out.children = [];
              if (kids.length) out.truncated_children = kids.length;
            } else {
              out.children = kids.map((c: any) => mapNode(c, depth + 1));
            }
            return out;
          }
          const cube: any = {
            type: 'cube',
            uuid: node.uuid,
            name: node.name,
            from: node.from ? [...node.from] : [0, 0, 0],
            to: node.to ? [...node.to] : [0, 0, 0],
            origin: node.origin ? [...node.origin] : [0, 0, 0],
            rotation: node.rotation ? [...node.rotation] : [0, 0, 0],
            // UV state so the AI can SEE/verify UV without risky_eval (box_uv mode,
            // the box-UV offset, and the auto-UV flag).
            box_uv: !!node.box_uv,
            autouv: node.autouv,
            uv_offset: node.uv_offset ? [...node.uv_offset] : undefined,
          };
          if (includeFaces) {
            const faces: Record<string, { texture: string | null }> = {};
            if (node.faces) {
              for (const f of Object.keys(node.faces)) {
                const t = node.faces[f] ? node.faces[f].texture : null;
                faces[f] = { texture: t ? String(t) : null };
              }
            }
            cube.faces = faces;
          }
          return cube;
        };

        // Scope to specific bones' subtrees if requested; otherwise the outliner roots.
        let rootNodes: any[];
        let notFound: string[] | undefined;
        const requested = Array.isArray(input?.bone_names)
          ? input!.bone_names.filter((n) => typeof n === 'string' && n) : [];
        if (requested.length) {
          rootNodes = [];
          notFound = [];
          for (const n of requested) {
            const g = findGroupByName(n);
            if (g) rootNodes.push(g); else notFound.push(n);
          }
        } else {
          rootNodes = (typeof Outliner !== 'undefined' && Outliner.root ? Outliner.root : []);
        }

        const roots = rootNodes.map((n) => mapNode(n, 0));
        const textures = (typeof Texture !== 'undefined' && (Texture as any).all ? (Texture as any).all : []).map(
          (t: any) => ({ uuid: t.uuid, name: t.name })
        );
        // Format + mesh count so validate_model can warn EARLY about meshes in a
        // cubes-only format (GeckoLib renders cubes, not meshes → silent loss).
        // + the format's rotation flags, so validate_model applies this project's rules.
        const format = (typeof Format !== 'undefined') ? { ...currentFormatInfo(), meshes: !!(Format as any).meshes } : null;
        const mesh_count = (typeof Mesh !== 'undefined' && (Mesh as any).all) ? (Mesh as any).all.length : 0;
        const tree: any = { roots, textures, format, mesh_count };
        if (notFound && notFound.length) tree.requested_bones_not_found = notFound;
        return { ok: true, tree };
      } catch (err: any) {
        console.error('[MCP Plugin] getSceneTree failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Register/load a texture asset (rule #2). Source: data_url > path > blank canvas.
    const registerTexture = (input: { name?: string; data_url?: string; path?: string; width?: number; height?: number }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.name) return { ok: false, error: 'A unique texture name is required.' };
        const textures = (typeof Texture !== 'undefined' && (Texture as any).all) ? (Texture as any).all : [];
        if (textures.some((t: any) => t.name === input.name)) {
          return { ok: false, error: `Texture "${input.name}" is already registered.` };
        }

        let tex: any;
        if (input.data_url) {
          tex = new Texture({ name: input.name }).fromDataURL(input.data_url).add(false);
        } else if (input.path) {
          tex = new Texture({ name: input.name }).fromPath(input.path).add(false);
        } else {
          const w = input.width || 16;
          const h = input.height || 16;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          // Transparent blank texture of the requested resolution.
          tex = new Texture({ name: input.name }).fromDataURL(canvas.toDataURL('image/png')).add(false);
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`registered texture "${tex.name}"`);
        return { ok: true, id: tex.uuid, uuid: tex.uuid, name: tex.name };
      } catch (err: any) {
        console.error('[MCP Plugin] registerTexture failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Apply an already-registered texture to an existing cube (rule #2).
    const applyTexture = (input: { target?: string; texture?: string; faces?: string[]; apply_mode?: string }): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.target) return { ok: false, error: 'target (cube/mesh/group name) is required.' };
        if (!input.texture) return { ok: false, error: 'texture (name or id) is required.' };

        const textures = (typeof Texture !== 'undefined' && (Texture as any).all) ? (Texture as any).all : [];
        const tex = textures.find((t: any) => t.uuid === input.texture || t.name === input.texture);
        if (!tex) return { ok: false, error: `Texture "${input.texture}" is not registered. Call create_texture/register_texture first (rule #2).` };

        // Resolve target to cubes AND meshes: a cube/mesh name, OR a group name
        // (then ALL descendant cubes+meshes — one call textures a whole branch).
        const cubes: any[] = [];
        const meshes: any[] = [];
        const directCube = findCubeByName(input.target);
        const directMesh = (typeof findMesh === 'function') ? findMesh(input.target) : null;
        if (directCube) cubes.push(directCube);
        else if (directMesh) meshes.push(directMesh);
        else {
          const group = findGroupByName(input.target);
          if (!group) return { ok: false, error: `"${input.target}" is not a cube, mesh, or group (rule #2: the element must exist).` };
          const collect = (g: any) => {
            for (const child of g.children || []) {
              if (typeof Cube !== 'undefined' && child instanceof Cube) cubes.push(child);
              else if (typeof Mesh !== 'undefined' && child instanceof Mesh) meshes.push(child);
              else if (typeof Group !== 'undefined' && child instanceof Group) collect(child);
            }
          };
          collect(group);
          if (!cubes.length && !meshes.length) return { ok: false, error: `Group "${input.target}" has no descendant cubes/meshes.` };
        }
        const targets = [...cubes, ...meshes];

        // Save the caller's selection so this call is non-destructive to UI state.
        const prevCubes = (typeof Cube !== 'undefined' && (Cube as any).selected) ? [...(Cube as any).selected] : [];
        const prevMeshes = (typeof Mesh !== 'undefined' && (Mesh as any).selected) ? [...(Mesh as any).selected] : [];
        const prevGroup = (typeof Group !== 'undefined' && (Group as any).selected) ? (Group as any).selected : null;
        const faceScoped = !!(input.faces && input.faces.length);

        Undo.initEdit({ elements: targets, uv_only: false } as any);
        try {
          if (faceScoped) {
            // Native Texture.apply() can't scope to specific faces → assign directly.
            for (const el of targets) {
              for (const f of input.faces as string[]) { if (el.faces && el.faces[f]) el.faces[f].texture = tex.uuid; }
            }
          } else {
            // Native path (ported from upstream): select EXACTLY the targets, then
            // Texture.selected.apply(mode). mode: blank=only untextured faces,
            // all=every face, none=clear.
            (Cube as any).all?.forEach((c: any) => { if (c.selected) c.unselect?.(); });
            (Mesh as any).all?.forEach((m: any) => { if (m.selected) m.unselect?.(); });
            for (const el of targets) { try { el.select?.({ shiftKey: true }); } catch { /* best-effort */ } }
            if (typeof updateSelection === 'function') updateSelection();
            tex.select?.();
            const mode = input.apply_mode === 'all' ? true : input.apply_mode === 'none' ? false : 'blank';
            if (typeof (Texture as any).selected?.apply === 'function') {
              (Texture as any).selected.apply(mode);
            } else {
              for (const el of targets) { Object.keys(el.faces || {}).forEach((f) => { if (el.faces[f]) el.faces[f].texture = tex.uuid; }); }
            }
          }
          // Box-UV positioning: only auto-pack cubes still in AUTO mode (autouv != 0).
          // Cubes with a manual uv_offset (autouv:0) keep their atlas region — this is
          // why the old unconditional mapAutoUV() collapsed deliberate atlases.
          for (const cube of cubes) {
            if (cube.box_uv && cube.autouv !== 0 && typeof cube.mapAutoUV === 'function') cube.mapAutoUV();
          }
          if (typeof tex.updateChangesAfterEdit === 'function') tex.updateChangesAfterEdit();
        } finally {
          // Restore the caller's original selection.
          (Cube as any).all?.forEach((c: any) => { if (c.selected) c.unselect?.(); });
          (Mesh as any).all?.forEach((m: any) => { if (m.selected) m.unselect?.(); });
          for (const c of prevCubes) { try { c.select?.({ shiftKey: true }); } catch { /* */ } }
          for (const m of prevMeshes) { try { m.select?.({ shiftKey: true }); } catch { /* */ } }
          if (prevGroup) prevGroup.selected = true;
          if (typeof updateSelection === 'function') updateSelection();
          Undo.finishEdit('Apply texture via MCP', { elements: targets });
        }

        // Force a face-level render refresh — Canvas.updateAll() alone sometimes
        // doesn't push new face materials into the THREE render targets (upstream).
        if (typeof Canvas !== 'undefined') {
          if ((Canvas as any).updateView) (Canvas as any).updateView({ elements: targets, element_aspects: { faces: true, uv: true, geometry: false } });
          if ((Canvas as any).updateAll) (Canvas as any).updateAll();
        }

        logToHistory(`applied texture "${tex.name}" to ${cubes.length} cube(s) + ${meshes.length} mesh(es) [${input.apply_mode || 'blank'}]`);
        return { ok: true, target: input.target, texture: tex.name, cubes: cubes.length, meshes: meshes.length, mode: input.apply_mode || 'blank' };
      } catch (err: any) {
        console.error('[MCP Plugin] applyTexture failed:', err);
        logToHistory('error: ' + (err?.message || String(err)));
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Animation tools (ported from the upstream jasonjgardner blockbench-mcp
    // server/tools/animation.ts; execute bodies adapted to our ack model).
    // ---------------------------------------------------------------------

    const animationsSupported = (): boolean =>
      typeof Animator !== 'undefined' && typeof Format !== 'undefined' && !!(Format as any).animation_mode;

    // Selection, playback and previews only work in Animation mode. We create
    // animations programmatically (usually from Edit mode), so enter the mode
    // explicitly — otherwise Animation.selected stays null and play/select fail.
    // (Animator.open is a boolean flag in Blockbench; Animator.join() enters the mode.)
    const ensureAnimationMode = (): void => {
      try {
        if (typeof Animator !== 'undefined' && !(Animator as any).open && typeof (Animator as any).join === 'function') {
          (Animator as any).join();
        }
      } catch (e) {
        console.warn('[MCP Plugin] ensureAnimationMode failed:', e);
      }
    };

    const isAnimationSelected = (anim: any): boolean =>
      !!anim && (((Animator as any).selected === anim) || ((Animation as any).selected === anim) || anim.selected === true);

    const allAnimations = (): any[] => (typeof Animation !== 'undefined' && (Animation as any).all) ? (Animation as any).all : [];

    // Resolve by UUID, exact name, or short name (create_animation prefixes
    // "animation."). With no id: the selected animation, or — when the project has
    // exactly one — that one, so single-animation work never fails on "nothing
    // selected" (5 such errors in the June logs).
    const findAnimation = (idOrName?: string): any => {
      const all = allAnimations();
      if (idOrName) {
        return (
          all.find((a: any) => a.uuid === idOrName || a.name === idOrName) ||
          all.find((a: any) => a.name === `animation.${idOrName}`)
        );
      }
      return (Animation as any).selected || (all.length === 1 ? all[0] : undefined);
    };

    // Timeline/preview only act on the SELECTED animation: select the only one if
    // nothing is selected yet. Returns the selected animation or undefined.
    const ensureSelectedAnimation = (): any => {
      let selected = (Animation as any).selected;
      const all = allAnimations();
      if (!selected && all.length === 1 && typeof all[0].select === 'function') {
        try { all[0].select(); } catch { /* */ }
        selected = (Animation as any).selected || all[0];
      }
      return selected;
    };

    // One "which animation?" error that tells the caller what exists.
    const animationNotFound = (idOrName?: string): string => {
      const names = allAnimations().map((a: any) => a.name);
      const list = names.length
        ? ` Available: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}.`
        : ' The project has no animations yet — create one with create_animation.';
      return idOrName ? `Animation "${idOrName}" not found.${list}` : `No animation selected — pass animation_id.${list}`;
    };

    // Clipboard for animation_copy_paste (module-scoped, survives across calls).
    let animationClipboard: any = null;

    // Blockbench's Bedrock/GeckoLib animation codec flips signs between the file and
    // the values Blockbench stores and shows — measured live 2026-09-23: rotation X
    // and Y, position X; scale unchanged. create_animation imports through that
    // codec, so it pre-flips its input: every animation tool then speaks the STORED
    // convention (what get_keyframes and the Blockbench UI show), and export flips back.
    const toBedrockRotation = (v: number[]): number[] => [-v[0], -v[1], v[2]];
    const toBedrockPosition = (v: number[]): number[] => [-v[0], v[1], v[2]];

    // Create a complete animation from per-bone keyframes via Animator.loadFile
    // (bedrock animation JSON — the same path Blockbench uses for imports).
    const createAnimation = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!animationsSupported()) {
          return { ok: false, error: 'The current format does not support animations. Use a GeckoLib/Bedrock-style animated format.' };
        }
        if (!input.name) return { ok: false, error: 'Animation name is required.' };
        if (!input.bones || Object.keys(input.bones).length === 0) {
          return { ok: false, error: 'At least one bone with keyframes is required.' };
        }
        // State-safe (rule #3/#8): every animated bone must exist before keyframing.
        const missing = Object.keys(input.bones).filter((b) => !findGroupByName(b));
        if (missing.length) {
          return { ok: false, error: `Bone(s) not found: ${missing.join(', ')}. Create the groups first (get_scene_tree to inspect).` };
        }
        if (findAnimation(`animation.${input.name}`) || findAnimation(input.name)) {
          return { ok: false, error: `Animation "${input.name}" already exists (rule #4: unique names).` };
        }

        const animationData: any = {
          loop: !!input.loop,
          ...(input.animation_length ? { animation_length: input.animation_length } : {}),
          bones: Object.fromEntries(
            Object.entries(input.bones as Record<string, any[]>).map(([boneName, keyframes]) => {
              const boneData: Record<string, Record<string, any>> = {};
              (keyframes || []).forEach((kf: any) => {
                const timeKey = String(kf.time);
                if (kf.position) (boneData.position ??= {})[timeKey] = toBedrockPosition(kf.position);
                if (kf.rotation) (boneData.rotation ??= {})[timeKey] = toBedrockRotation(kf.rotation);
                if (kf.scale !== undefined) (boneData.scale ??= {})[timeKey] = kf.scale;
              });
              return [boneName, boneData];
            })
          ),
          ...(input.particle_effects ? { particle_effects: input.particle_effects } : {}),
        };

        Animator.loadFile({
          content: JSON.stringify({
            format_version: '1.8.0',
            animations: { [`animation.${input.name}`]: animationData },
          }),
        } as any);

        // Enter animation mode and select, so timeline/keyframe tools work
        // immediately (live finding: Blockbench does not select imported
        // animations, and selection is a no-op outside animation mode).
        ensureAnimationMode();
        const created = findAnimation(`animation.${input.name}`);
        if (created && typeof created.select === 'function') created.select();
        const selected = isAnimationSelected(created);

        logToHistory(`created animation "${input.name}"`);
        return {
          ok: true,
          name: `animation.${input.name}`,
          uuid: created ? created.uuid : undefined,
          selected,
          bones: Object.keys(input.bones).length,
        };
      } catch (err: any) {
        console.error('[MCP Plugin] createAnimation failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Write a keyframe's actual values into its data_points (x,y,z as strings, the
    // Blockbench storage format). Blockbench's createKeyframe does NOT read a
    // `.values` key, so passing values in the create-data silently saved 0 — this
    // sets them explicitly so create/edit actually stick. `values` = [x,y,z] for
    // rotation/position, or a number for uniform scale.
    const setKeyframeValues = (kf: any, values: any): boolean => {
      if (kf == null || values === undefined || values === null) return false;
      const a = Array.isArray(values) ? values : [values, values, values];
      const x = a[0] ?? 0, y = (a[1] ?? a[0]) ?? 0, z = (a[2] ?? a[0]) ?? 0;
      if (kf.data_points && kf.data_points[0]) {
        kf.data_points[0].x = String(x); kf.data_points[0].y = String(y); kf.data_points[0].z = String(z);
        return true;
      }
      if (typeof kf.set === 'function') { try { kf.set('x', x); kf.set('y', y); kf.set('z', z); return true; } catch { /* */ } }
      return false;
    };
    // Read a keyframe's actually-stored values back out (for self-verifying acks
    // and the get_keyframes tool — measure, don't guess).
    const readKeyframe = (kf: any): any => {
      const dp = (kf.data_points && kf.data_points[0]) ? kf.data_points[0] : {};
      const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : v; };
      return { time: kf.time, values: [num(dp.x), num(dp.y), num(dp.z)], interpolation: kf.interpolation };
    };
    const readChannel = (animator: any, channel: string): any[] =>
      ((animator && animator[channel]) || []).map(readKeyframe).sort((p: any, q: any) => p.time - q.time);

    // Blockbench silently grows an animation when a keyframe lands past its end
    // (seen live 2026-09-23: 2 s → 3 s, leaving a loop with a dead second).
    // Report it in the write reply so the change isn't discovered much later.
    const lengthChange = (before: number, animation: any): { length_changed?: { from: number; to: number } } => {
      const after = Number(animation && animation.length) || 0;
      return Math.abs(after - before) > 1e-6 ? { length_changed: { from: before, to: after } } : {};
    };

    // Create / delete / edit / select keyframes on one bone+channel.
    const manageKeyframes = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();
        const animation = findAnimation(input.animation_id);
        if (!animation) return { ok: false, error: animationNotFound(input.animation_id) };
        const group = findGroupByName(input.bone_name);
        if (!group) return { ok: false, error: `Bone/group "${input.bone_name}" not found. Use get_scene_tree to inspect.` };
        if (!input.channel) return { ok: false, error: 'channel is required (rotation/position/scale).' };
        const keyframes: any[] = input.keyframes || [];
        if (!keyframes.length) return { ok: false, error: 'keyframes array is required.' };

        let animator = animation.animators[group.uuid];
        if (!animator) {
          animator = new BoneAnimator(group.uuid, animation, input.bone_name);
          animation.animators[group.uuid] = animator;
        }

        const lengthBefore = Number(animation.length) || 0;
        Undo.initEdit({ animations: [animation], keyframes: [] } as any);

        const applyBezier = (keyframe: any, kf: any) => {
          if (kf.interpolation === 'bezier' && kf.bezier_handles) {
            const h = kf.bezier_handles;
            if (h.left_time !== undefined) keyframe.bezier_left_time = h.left_time;
            if (h.left_value) keyframe.bezier_left_value = h.left_value;
            if (h.right_time !== undefined) keyframe.bezier_right_time = h.right_time;
            if (h.right_value) keyframe.bezier_right_value = h.right_value;
          }
        };
        const findKf = (time: number) =>
          (animator[input.channel] || []).find((k: any) => Math.abs(k.time - time) < 0.001);

        let affected = 0;
        switch (input.action) {
          case 'create':
            keyframes.forEach((kf: any) => {
              const keyframe = animator.createKeyframe(undefined, kf.time, input.channel, false);
              if (!keyframe) return;
              setKeyframeValues(keyframe, kf.values); // explicit — createKeyframe ignores `.values`
              if (kf.interpolation) keyframe.interpolation = kf.interpolation;
              applyBezier(keyframe, kf);
              affected++;
            });
            break;
          case 'delete':
            keyframes.forEach((kf: any) => { const k = findKf(kf.time); if (k) { k.remove(); affected++; } });
            break;
          case 'edit':
            keyframes.forEach((kf: any) => {
              const k = findKf(kf.time);
              if (!k) return;
              if (kf.values !== undefined) setKeyframeValues(k, kf.values); // was k.set('values',…) — 'values' is not an axis
              if (kf.interpolation) k.interpolation = kf.interpolation;
              applyBezier(k, kf);
              affected++;
            });
            break;
          case 'select':
            (Timeline as any).selected.empty();
            keyframes.forEach((kf: any) => { const k = findKf(kf.time); if (k) { k.select(); affected++; } });
            break;
          default:
            Undo.finishEdit('no-op');
            return { ok: false, error: `Unknown action "${input.action}".` };
        }

        Undo.finishEdit(`${input.action} keyframes`);
        Animator.preview();
        // Self-verifying: read the values ACTUALLY stored back out, so a silent
        // write failure is visible in the ack instead of after 5 rounds.
        const stored = readChannel(animator, input.channel);
        logToHistory(`${input.action} ${affected} keyframe(s) on ${input.bone_name}.${input.channel}`);
        return { ok: true, action: input.action, affected, bone: input.bone_name, channel: input.channel, stored, ...lengthChange(lengthBefore, animation) };
      } catch (err: any) {
        console.error('[MCP Plugin] manageKeyframes failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Batch keyframe writer: many bones × channels × times in ONE call and ONE
    // undo step. Upsert — a keyframe already at that time (±0.001 s) is
    // overwritten, otherwise one is created. Values are the STORED (Blockbench-
    // internal) values, the same convention as manage_keyframes / get_keyframes.
    // Everything is validated first; a failure mid-write rolls the batch back.
    const KEYFRAME_CHANNELS = ['rotation', 'position', 'scale'];
    const isKeyframeValue = (v: any): boolean =>
      (typeof v === 'number' && isFinite(v)) || typeof v === 'string' ||
      (Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every((n) => (typeof n === 'number' && isFinite(n)) || typeof n === 'string'));
    const setKeyframes = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();
        const animation = findAnimation(input.animation_id);
        if (!animation) return { ok: false, error: animationNotFound(input.animation_id) };
        const entries: any[] = Array.isArray(input.keyframes) ? input.keyframes : [];
        if (!entries.length) return { ok: false, error: 'keyframes[] is required (each: bone, channel, time, values).' };

        const groups = new Map<string, any>();
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i] || {};
          if (!e.bone) return { ok: false, error: `keyframes[${i}]: bone is required.` };
          if (!KEYFRAME_CHANNELS.includes(e.channel)) return { ok: false, error: `keyframes[${i}]: channel must be rotation, position or scale.` };
          if (typeof e.time !== 'number' || !isFinite(e.time) || e.time < 0) return { ok: false, error: `keyframes[${i}]: time must be a number >= 0 (seconds).` };
          if (!isKeyframeValue(e.values)) return { ok: false, error: `keyframes[${i}]: values must be [x,y,z] (or one number for uniform scale).` };
          if (!groups.has(e.bone)) {
            const g = findGroupByName(e.bone);
            if (!g) return { ok: false, error: `keyframes[${i}]: bone "${e.bone}" not found (get_scene_tree).` };
            groups.set(e.bone, g);
          }
        }

        const animatorFor = (bone: string): any => {
          const g = groups.get(bone);
          let an = animation.animators[g.uuid];
          if (!an) { an = new BoneAnimator(g.uuid, animation, bone); animation.animators[g.uuid] = an; }
          return an;
        };

        let created = 0, updated = 0, cleared = 0;
        const touched = new Map<string, { animator: any; channel: string }>();
        let failure: string | null = null;
        const lengthBefore = Number(animation.length) || 0;
        Undo.initEdit({ animations: [animation], keyframes: [] } as any);
        try {
          if (input.clear_first) {
            // Rewrite mode: empty every bone/channel pair named in the batch first.
            const pairs = new Map<string, { bone: string; channel: string }>();
            for (const e of entries) pairs.set(`${e.bone}.${e.channel}`, { bone: e.bone, channel: e.channel });
            for (const { bone, channel } of pairs.values()) {
              const an = animatorFor(bone);
              for (const k of [...(an[channel] || [])]) { k.remove(); cleared++; }
            }
          }
          for (const e of entries) {
            const an = animatorFor(e.bone);
            let kf = (an[e.channel] || []).find((k: any) => Math.abs(k.time - e.time) < 0.001);
            if (kf) updated++;
            else {
              kf = an.createKeyframe(undefined, e.time, e.channel, false);
              if (!kf) throw new Error(`could not create a keyframe at ${e.bone}.${e.channel} t=${e.time}`);
              created++;
            }
            setKeyframeValues(kf, e.values); // explicit — createKeyframe ignores `.values`
            if (e.interpolation) kf.interpolation = e.interpolation;
            touched.set(`${e.bone}.${e.channel}`, { animator: an, channel: e.channel });
          }
        } catch (err: any) {
          failure = err?.message || String(err);
        }
        if (failure) {
          if (typeof (Undo as any).cancelEdit === 'function') (Undo as any).cancelEdit();
          else Undo.finishEdit('Set keyframes via MCP (failed)');
          return { ok: false, error: `Batch failed and was rolled back (nothing changed): ${failure}` };
        }
        Undo.finishEdit('Set keyframes via MCP');
        Animator.preview();

        const stored: Record<string, any[]> = {};
        for (const [key, t] of touched) stored[key] = readChannel(t.animator, t.channel);
        logToHistory(`set_keyframes: ${created} created, ${updated} updated, ${cleared} cleared on "${animation.name}"`);
        return { ok: true, animation: animation.name, created, updated, cleared, stored, ...lengthChange(lengthBefore, animation) };
      } catch (err: any) {
        console.error('[MCP Plugin] setKeyframes failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Curve/easing control over existing keyframes.
    const animationGraphEditor = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();
        const animation = findAnimation(input.animation_id);
        if (!animation) return { ok: false, error: animationNotFound(input.animation_id) };
        const group = findGroupByName(input.bone_name);
        if (!group) return { ok: false, error: `Bone/group "${input.bone_name}" not found.` };
        const animator = animation.animators[group.uuid];
        if (!animator || !animator[input.channel] || !animator[input.channel].length) {
          return { ok: false, error: `No keyframes found for ${input.bone_name}.${input.channel}` };
        }
        if (input.action === 'custom' && !input.custom_curve) {
          return { ok: false, error: "custom_curve is required for 'custom' action." };
        }

        Undo.initEdit({ animations: [animation], keyframes: animator[input.channel] } as any);

        const kfs = animator[input.channel].filter((kf: any) => {
          if (!input.keyframe_range) return true;
          return kf.time >= input.keyframe_range.start && kf.time <= input.keyframe_range.end;
        });

        kfs.forEach((kf: any, index: number) => {
          switch (input.action) {
            case 'linear': kf.interpolation = 'linear'; break;
            case 'stepped': kf.interpolation = 'step'; break;
            case 'smooth': kf.interpolation = 'catmullrom'; break;
            case 'ease_in':
            case 'ease_out':
            case 'ease_in_out': {
              kf.interpolation = 'bezier';
              const next = kfs[index + 1];
              if (next) {
                const duration = next.time - kf.time;
                kf.bezier_left_time = 0;
                kf.bezier_right_time = duration;
                if (input.action === 'ease_in') kf.bezier_right_time = duration * 0.6;
                else if (input.action === 'ease_out') kf.bezier_left_time = duration * 0.4;
                else { kf.bezier_left_time = duration * 0.3; kf.bezier_right_time = duration * 0.7; }
              }
              break;
            }
            case 'custom': {
              const c = input.custom_curve;
              kf.interpolation = 'bezier';
              kf.bezier_left_time = c.control_point_1[0];
              kf.bezier_left_value = [c.control_point_1[1], c.control_point_1[1], c.control_point_1[1]];
              kf.bezier_right_time = c.control_point_2[0];
              kf.bezier_right_value = [c.control_point_2[1], c.control_point_2[1], c.control_point_2[1]];
              break;
            }
          }
        });

        Undo.finishEdit('Modify animation curves');
        Animator.preview();
        if (typeof updateKeyframeSelection === 'function') updateKeyframeSelection();
        logToHistory(`applied ${input.action} curve to ${kfs.length} keyframe(s)`);
        return { ok: true, action: input.action, affected: kfs.length, bone: input.bone_name, channel: input.channel };
      } catch (err: any) {
        console.error('[MCP Plugin] animationGraphEditor failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Timeline / playback control.
    const animationTimeline = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();

        // If an animation_id is given, select that animation first (live finding:
        // the timeline only acts on the selected animation).
        if (input.animation_id) {
          const anim = findAnimation(input.animation_id);
          if (!anim) return { ok: false, error: animationNotFound(input.animation_id) };
          if (typeof anim.select === 'function') anim.select();
        }
        const selected = ensureSelectedAnimation();
        if (!selected) return { ok: false, error: animationNotFound() };

        let message = '';
        switch (input.action) {
          case 'select': message = `Selected animation "${selected.name}"`; break;
          case 'play': Timeline.start(); message = 'Started animation playback'; break;
          case 'pause': Timeline.pause(); message = 'Paused animation playback'; break;
          case 'stop': Timeline.setTime(0); Timeline.pause(); message = 'Stopped animation playback'; break;
          case 'set_time':
            if (input.time === undefined) return { ok: false, error: 'time is required for set_time.' };
            Timeline.setTime(input.time); message = `Set timeline to ${input.time}s`; break;
          case 'set_length':
            if (input.length === undefined) return { ok: false, error: 'length is required for set_length.' };
            selected.length = input.length; message = `Set animation length to ${input.length}s`; break;
          case 'set_fps':
            if (input.fps === undefined) return { ok: false, error: 'fps is required for set_fps.' };
            selected.snapping = input.fps; message = `Set animation FPS to ${input.fps}`; break;
          case 'loop':
            if (input.loop_mode) selected.loop = input.loop_mode;
            message = `Loop mode: ${input.loop_mode || selected.loop}`; break;
          case 'select_range': {
            if (!input.range) return { ok: false, error: 'range is required for select_range.' };
            let count = 0;
            (Timeline as any).keyframes.forEach((kf: any) => {
              if (kf.time >= input.range.start && kf.time <= input.range.end) { kf.select(); count++; }
              else kf.selected = false;
            });
            message = `Selected ${count} keyframe(s) in range`; break;
          }
          default: return { ok: false, error: `Unknown action "${input.action}".` };
        }
        Animator.preview();
        return { ok: true, message };
      } catch (err: any) {
        console.error('[MCP Plugin] animationTimeline failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Batch operations across many keyframes.
    const batchKeyframeOperations = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();
        const selected = ensureSelectedAnimation();
        if (!selected) return { ok: false, error: animationNotFound() };
        const params = input.parameters || {};

        let kfs: any[] = [];
        switch (input.selection || 'selected') {
          case 'all': kfs = (Timeline as any).keyframes; break;
          case 'selected': kfs = (Timeline as any).selected; break;
          case 'range':
            if (!input.range) return { ok: false, error: 'range is required for range selection.' };
            kfs = (Timeline as any).keyframes.filter((kf: any) => kf.time >= input.range.start && kf.time <= input.range.end);
            break;
          case 'pattern':
            if (!input.pattern) return { ok: false, error: 'pattern is required for pattern selection.' };
            kfs = (Timeline as any).keyframes.filter((kf: any) => {
              const rel = kf.time - (input.pattern.offset || 0);
              return Math.abs(rel % input.pattern.interval) < 0.001;
            });
            break;
        }
        if (!kfs.length) return { ok: false, error: 'No keyframes match the selection criteria.' };

        Undo.initEdit({ keyframes: kfs } as any);

        switch (input.operation) {
          case 'offset':
            kfs.forEach((kf: any) => {
              if (params.offset_time !== undefined) kf.time += params.offset_time;
              if (params.offset_values) {
                const v = kf.getArray();
                kf.set('values', [v[0] + params.offset_values[0], v[1] + params.offset_values[1], v[2] + params.offset_values[2]]);
              }
            });
            break;
          case 'scale': {
            const pivot = params.scale_pivot || 0;
            const factor = params.scale_factor || 1;
            kfs.forEach((kf: any) => { kf.time = pivot + (kf.time - pivot) * factor; });
            break;
          }
          case 'reverse': {
            const times = kfs.map((kf: any) => kf.time);
            const minT = Math.min(...times);
            const maxT = Math.max(...times);
            kfs.forEach((kf: any) => { kf.time = maxT - (kf.time - minT); });
            break;
          }
          case 'mirror': {
            if (!params.mirror_axis) return { ok: false, error: 'mirror_axis is required for mirror.' };
            const idx = params.mirror_axis === 'x' ? 0 : params.mirror_axis === 'y' ? 1 : 2;
            kfs.forEach((kf: any) => { const v = kf.getArray(); v[idx] *= -1; kf.set('values', v); });
            break;
          }
          case 'smooth':
            kfs.forEach((kf: any) => { kf.interpolation = 'catmullrom'; });
            break;
          case 'bake': {
            const interval = params.bake_interval || 1 / selected.snapping;
            const animators = new Set(kfs.map((kf: any) => kf.animator));
            animators.forEach((animator: any) => {
              ['rotation', 'position', 'scale'].forEach((channel) => {
                const chKfs = animator[channel];
                if (!chKfs || chKfs.length < 2) return;
                const startT = Math.min(...chKfs.map((kf: any) => kf.time));
                const endT = Math.max(...chKfs.map((kf: any) => kf.time));
                for (let t = startT; t <= endT; t += interval) {
                  if (!chKfs.find((kf: any) => Math.abs(kf.time - t) < 0.001)) {
                    (Timeline as any).time = t;
                    animator.fillValues(
                      animator.createKeyframe({ time: t, channel, values: animator.interpolate(channel, true) }, t, channel, false),
                      null, false
                    );
                  }
                }
              });
            });
            break;
          }
          default: return { ok: false, error: `Unknown operation "${input.operation}".` };
        }

        Undo.finishEdit(`Batch keyframe operation: ${input.operation}`);
        Animator.preview();
        logToHistory(`batch ${input.operation} on ${kfs.length} keyframe(s)`);
        return { ok: true, operation: input.operation, affected: kfs.length };
      } catch (err: any) {
        console.error('[MCP Plugin] batchKeyframeOperations failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Copy/paste (optionally mirrored) animation data between bones/animations.
    const animationCopyPaste = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        ensureAnimationMode();

        if (input.action === 'copy') {
          const source = input.source;
          if (!source) return { ok: false, error: 'source is required for copy.' };
          const srcAnimation = findAnimation(source.animation);
          if (!srcAnimation) return { ok: false, error: 'Source animation not found.' };
          const srcBone = findGroupByName(source.bone);
          if (!srcBone) return { ok: false, error: `Source bone "${source.bone}" not found.` };
          const animator = srcAnimation.animators[srcBone.uuid];
          if (!animator) return { ok: false, error: `No animation data for bone "${source.bone}".` };

          const copied: any = { bone_name: source.bone, channels: {} };
          (source.channels || ['rotation', 'position', 'scale']).forEach((channel: string) => {
            if (!animator[channel]) return;
            let kfs = animator[channel];
            if (source.time_range) {
              kfs = kfs.filter((kf: any) => kf.time >= source.time_range.start && kf.time <= source.time_range.end);
            }
            copied.channels[channel] = kfs.map((kf: any) => ({
              time: kf.time,
              values: kf.getArray(),
              interpolation: kf.interpolation,
              bezier_left_time: kf.bezier_left_time,
              bezier_left_value: kf.bezier_left_value,
              bezier_right_time: kf.bezier_right_time,
              bezier_right_value: kf.bezier_right_value,
            }));
          });

          animationClipboard = copied;
          return { ok: true, message: `Copied ${Object.keys(copied.channels).join(', ')} from "${source.bone}"` };
        }

        if (input.action === 'paste' || input.action === 'mirror_paste') {
          const target = input.target;
          if (!target) return { ok: false, error: 'target is required for paste.' };
          if (!animationClipboard) return { ok: false, error: 'Clipboard is empty — copy first.' };
          const tgtAnimation = findAnimation(target.animation);
          if (!tgtAnimation) return { ok: false, error: 'Target animation not found.' };
          const tgtBone = findGroupByName(target.bone);
          if (!tgtBone) return { ok: false, error: `Target bone "${target.bone}" not found.` };

          let animator = tgtAnimation.animators[tgtBone.uuid];
          if (!animator) {
            animator = new BoneAnimator(tgtBone.uuid, tgtAnimation, target.bone);
            tgtAnimation.animators[tgtBone.uuid] = animator;
          }

          Undo.initEdit({ animations: [tgtAnimation], keyframes: [] } as any);

          const mirrorAxis = input.action === 'mirror_paste' ? (target.mirror_axis || 'x') : null;
          const axisIndex = mirrorAxis === 'x' ? 0 : mirrorAxis === 'y' ? 1 : mirrorAxis === 'z' ? 2 : -1;
          let pasted = 0;

          Object.entries(animationClipboard.channels as Record<string, any[]>).forEach(([channel, kfsData]) => {
            kfsData.forEach((kfData: any) => {
              const values = Array.isArray(kfData.values) ? [...kfData.values] : kfData.values;
              if (mirrorAxis && Array.isArray(values) && (channel === 'rotation' || channel === 'position')) {
                values[axisIndex] *= -1;
              }
              const time = kfData.time + (target.time_offset || 0);
              const keyframe = animator.createKeyframe(undefined, time, channel, false);
              if (!keyframe) return;
              setKeyframeValues(keyframe, values); // explicit — createKeyframe ignores `.values`
              if (kfData.interpolation) keyframe.interpolation = kfData.interpolation;
              if (kfData.interpolation === 'bezier') {
                if (kfData.bezier_left_time !== undefined) keyframe.bezier_left_time = kfData.bezier_left_time;
                if (kfData.bezier_left_value) keyframe.bezier_left_value = kfData.bezier_left_value;
                if (kfData.bezier_right_time !== undefined) keyframe.bezier_right_time = kfData.bezier_right_time;
                if (kfData.bezier_right_value) keyframe.bezier_right_value = kfData.bezier_right_value;
              }
              pasted++;
            });
          });

          Undo.finishEdit(`${input.action} animation data`);
          Animator.preview();
          logToHistory(`pasted ${pasted} keyframe(s) to "${target.bone}"`);
          return { ok: true, message: `Pasted ${pasted} keyframe(s) to "${target.bone}"${mirrorAxis ? ` (mirrored on ${mirrorAxis})` : ''}` };
        }

        return { ok: false, error: `Unknown action "${input.action}".` };
      } catch (err: any) {
        console.error('[MCP Plugin] animationCopyPaste failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // List animations + their per-bone keyframe counts (state verification, rule #3/#8).
    const listAnimations = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const all = (typeof Animation !== 'undefined' && (Animation as any).all) ? (Animation as any).all : [];
        const animations = all.map((a: any) => ({
          uuid: a.uuid,
          name: a.name,
          loop: a.loop,
          length: a.length,
          selected: a.selected || false,
          bones: Object.values(a.animators || {})
            .filter((an: any) => an && an.constructor && an.constructor.name !== 'EffectAnimator')
            .map((an: any) => ({
              name: an.name,
              rotation_keyframes: (an.rotation || []).length,
              position_keyframes: (an.position || []).length,
              scale_keyframes: (an.scale || []).length,
            }))
            // Only report bones that actually have keyframes (cosmetic: imported
            // animations register an animator for every group, most with 0 keys).
            .filter((b: any) => b.rotation_keyframes + b.position_keyframes + b.scale_keyframes > 0),
        }));
        return { ok: true, animations };
      } catch (err: any) {
        console.error('[MCP Plugin] listAnimations failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Delete / rename / duplicate a whole animation (previously only possible via
    // risky_eval). Names follow create_animation: a bare name gets "animation.".
    const fullAnimationName = (n: string): string => (n.startsWith('animation.') ? n : `animation.${n}`);
    const manageAnimation = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        if (!input.animation_id) return { ok: false, error: 'animation_id (UUID, full or short name) is required.' };
        const anim = findAnimation(input.animation_id);
        if (!anim) return { ok: false, error: animationNotFound(input.animation_id) };
        const all = () => ((typeof Animation !== 'undefined' && (Animation as any).all) ? (Animation as any).all : []);

        if (input.action === 'delete') {
          const name = anim.name;
          Undo.initEdit({ animations: [anim] } as any);
          anim.remove(false);
          Undo.finishEdit('Delete animation via MCP', { animations: [] } as any);
          logToHistory(`deleted animation "${name}"`);
          return { ok: true, action: 'delete', name, remaining: all().length };
        }

        if (!input.new_name) return { ok: false, error: `new_name is required for ${input.action}.` };
        const newName = fullAnimationName(String(input.new_name));
        if (findAnimation(newName)) return { ok: false, error: `Animation "${newName}" already exists (rule #4: unique names).` };

        if (input.action === 'rename') {
          const oldName = anim.name;
          Undo.initEdit({ animations: [anim] } as any);
          anim.name = newName;
          Undo.finishEdit('Rename animation via MCP', { animations: [anim] } as any);
          logToHistory(`renamed animation "${oldName}" -> "${newName}"`);
          return { ok: true, action: 'rename', name: newName, previous_name: oldName, uuid: anim.uuid };
        }

        if (input.action === 'duplicate') {
          // Round-trip through the Bedrock compiler + importer (the create_animation
          // path): the sign conversion is applied both ways, so stored values match.
          if (typeof anim.compileBedrockAnimation !== 'function') return { ok: false, error: 'compileBedrockAnimation unavailable in this Blockbench build.' };
          const data = anim.compileBedrockAnimation();
          Animator.loadFile({ content: JSON.stringify({ format_version: '1.8.0', animations: { [newName]: data } }) } as any);
          const copy = findAnimation(newName);
          if (!copy) return { ok: false, error: `Duplicate "${newName}" was not created.` };
          logToHistory(`duplicated animation "${anim.name}" -> "${newName}"`);
          return { ok: true, action: 'duplicate', name: newName, source: anim.name, uuid: copy.uuid };
        }

        return { ok: false, error: `Unknown action "${input.action}" (delete | rename | duplicate).` };
      } catch (err: any) {
        console.error('[MCP Plugin] manageAnimation failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Read back the ACTUAL stored keyframe values for a bone (verify writes, don't
    // guess). Returns per-channel [{time, values:[x,y,z], interpolation}].
    // Read back stored keyframes: one bone (bone_name), several (bone_names), or —
    // with neither — every bone that has keyframes in the animation. The multi
    // form replaces the per-bone loop / risky_eval dumps.
    const getKeyframes = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        const animation = findAnimation(input.animation_id);
        if (!animation) return { ok: false, error: animationNotFound(input.animation_id) };
        const chans = input.channel ? [input.channel] : KEYFRAME_CHANNELS;

        if (input.bone_name && !Array.isArray(input.bone_names)) {
          const group = findGroupByName(input.bone_name);
          if (!group) return { ok: false, error: `Bone/group "${input.bone_name}" not found.` };
          const animator = animation.animators[group.uuid];
          const channels: any = {};
          for (const ch of chans) channels[ch] = animator ? readChannel(animator, ch) : [];
          return { ok: true, animation: animation.name, bone: input.bone_name, has_animator: !!animator, channels };
        }

        const bones: Record<string, any> = {};
        const notFound: string[] = [];
        if (Array.isArray(input.bone_names)) {
          for (const name of input.bone_names) {
            const group = findGroupByName(name);
            if (!group) { notFound.push(name); continue; }
            const animator = animation.animators[group.uuid];
            const channels: any = {};
            for (const ch of chans) channels[ch] = animator ? readChannel(animator, ch) : [];
            bones[name] = channels;
          }
        } else {
          // Every animated bone; only channels that actually hold keyframes.
          for (const an of Object.values(animation.animators || {}) as any[]) {
            if (!an || !an.name || (an.constructor && an.constructor.name === 'EffectAnimator')) continue;
            const channels: any = {};
            for (const ch of chans) { const kfs = readChannel(an, ch); if (kfs.length) channels[ch] = kfs; }
            if (Object.keys(channels).length) bones[an.name] = channels;
          }
        }
        return { ok: true, animation: animation.name, bones, ...(notFound.length ? { not_found: notFound } : {}) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // World AABB of the ELEMENTS (cubes, meshes) under an outliner node (a group, or
    // the outliner root when `node` is null). Only element geometry counts: the
    // earlier Box3.setFromObject(group.mesh) also swept in editor helpers — a selected
    // bone's pivot_marker gizmo (±5.5 units) — which is why lowest_y read -5.11
    // instead of -0.19 (measured live 2026-09-23). Returns null when there is none.
    const elementsWorldBox = (node: any): any => {
      const T = (globalThis as any).THREE;
      if (!T) return null;
      const box = new T.Box3();
      const tmp = new T.Box3();
      const visit = (children: any[]) => {
        for (const ch of children || []) {
          if (typeof Group !== 'undefined' && ch instanceof Group) { visit(ch.children); continue; }
          const m = ch && ch.mesh;
          const geo = m && m.geometry;
          if (!geo) continue;
          if (m.updateWorldMatrix) m.updateWorldMatrix(true, false);
          geo.computeBoundingBox();
          tmp.copy(geo.boundingBox).applyMatrix4(m.matrixWorld);
          box.union(tmp);
        }
      };
      visit(node ? node.children : ((typeof Outliner !== 'undefined' && Outliner.root) ? Outliner.root : []));
      return box.isEmpty() ? null : box;
    };

    // Measure a bone's rotation — local AND world-space (degrees) — so rotation
    // direction can be CALIBRATED by number, not guessed from a camera angle.
    // Optionally evaluate the selected animation at `time` first.
    const getBonePose = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const group = findGroupByName(input.bone_name);
        if (!group) return { ok: false, error: `Bone/group "${input.bone_name}" not found.` };
        if (input.time !== undefined) {
          try { ensureAnimationMode(); (Timeline as any).time = input.time; if (typeof Animator !== 'undefined' && (Animator as any).preview) (Animator as any).preview(); } catch { /* */ }
        }
        let world_rotation: number[] | null = null;
        let world_position: number[] | null = null;
        let world_bbox: { min: number[]; max: number[]; lowest_y: number } | null = null;
        try {
          const mesh = (group as any).mesh;
          const T = (globalThis as any).THREE; // a runtime global, not in the typings
          if (mesh && T) {
            // Update parents AND children so both the bone transform and the
            // descendant geometry reflect the (animated) pose for the bbox below.
            if (mesh.updateWorldMatrix) mesh.updateWorldMatrix(true, true);
            const r2 = (n: number) => Math.round(n * 100) / 100;
            if (mesh.getWorldQuaternion) {
              const q = new T.Quaternion(); mesh.getWorldQuaternion(q);
              const e = new T.Euler().setFromQuaternion(q, 'ZYX');
              const deg = (r: number) => r2(r * 180 / Math.PI);
              world_rotation = [deg(e.x), deg(e.y), deg(e.z)];
            }
            if (mesh.getWorldPosition) {
              const p = new T.Vector3(); mesh.getWorldPosition(p);
              world_position = [r2(p.x), r2(p.y), r2(p.z)]; // bone pivot in scene/world space
            }
            // World-space AABB of the bone's descendant elements at this time — the
            // numeric answer to "is anything below the floor?" (lowest_y). Empty
            // bones (no descendant geometry) yield no box → left null.
            try {
              const box = elementsWorldBox(group);
              if (box) {
                world_bbox = {
                  min: [r2(box.min.x), r2(box.min.y), r2(box.min.z)],
                  max: [r2(box.max.x), r2(box.max.y), r2(box.max.z)],
                  lowest_y: r2(box.min.y),
                };
              }
            } catch { /* bbox is best-effort */ }
          }
        } catch { /* world is best-effort */ }
        return {
          ok: true, bone: input.bone_name, time: input.time ?? null,
          local_rotation: group.rotation ? [...group.rotation] : null,
          origin: group.origin ? [...group.origin] : null,
          world_rotation, world_position, world_bbox,
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // One-call animation lint for the mistakes that otherwise take screenshot
    // rounds: keyframes past the end, suspicious rotation jumps, loops that pop,
    // keyframes on bones that no longer exist, and (with floor_y) the model dipping
    // below the floor — found by sampling the whole animation numerically.
    const checkAnimation = (input: any): any => {
      try {
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        const animation = findAnimation(input.animation_id);
        if (!animation) return { ok: false, error: animationNotFound(input.animation_id) };
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const length = Number(animation.length) || 0;
        const loopMode = animation.loop;
        const maxJump = typeof input.max_jump === 'number' && input.max_jump > 0 ? input.max_jump : 90;
        const issues: Array<{ severity: 'error' | 'warning' | 'info'; rule: string; message: string }> = [];
        const add = (severity: 'error' | 'warning' | 'info', rule: string, message: string) => issues.push({ severity, rule, message });
        const boneNames = new Set(allGroups().map((g: any) => g.name));
        const keyTimes = new Set<number>();
        let bones = 0, keyframes = 0;

        for (const an of Object.values(animation.animators || {}) as any[]) {
          if (!an || !an.name || (an.constructor && an.constructor.name === 'EffectAnimator')) continue;
          let animated = false;
          for (const ch of KEYFRAME_CHANNELS) {
            const kfs = readChannel(an, ch);
            if (!kfs.length) continue;
            animated = true;
            keyframes += kfs.length;
            for (const k of kfs) {
              keyTimes.add(k.time);
              if (length > 0 && k.time > length + 1e-3) add('warning', 'beyond-length', `${an.name}.${ch} has a keyframe at ${k.time}s, after the ${length}s end — it never plays.`);
            }
            if (ch === 'rotation') {
              for (let i = 1; i < kfs.length; i++) {
                const a = kfs[i - 1].values, b = kfs[i].values;
                if (![...a, ...b].every((v: any) => typeof v === 'number')) continue;
                const d = Math.max(...[0, 1, 2].map((j) => Math.abs(b[j] - a[j])));
                if (d > maxJump) add('warning', 'rotation-jump', `${an.name}.rotation turns ${r2(d)}° between ${kfs[i - 1].time}s and ${kfs[i].time}s — an intended spin, or a sign/unit mistake?`);
              }
            }
            if (loopMode === 'loop' && length > 0 && kfs.length >= 2) {
              const first = kfs[0], last = kfs[kfs.length - 1];
              if (first.time <= 1e-3 && Math.abs(last.time - length) <= 1e-3) {
                const diff = Math.max(...[0, 1, 2].map((j) => Math.abs(Number(first.values[j]) - Number(last.values[j]))));
                if (diff > 0.01) add('warning', 'loop-seam', `${an.name}.${ch} starts at [${first.values.join(', ')}] but ends at [${last.values.join(', ')}] — the loop will visibly pop.`);
              } else {
                add('info', 'loop-seam', `${an.name}.${ch} has no keyframes at both 0s and ${length}s — check that the loop blends.`);
              }
            }
          }
          if (animated) {
            bones++;
            if (!boneNames.has(an.name)) add('error', 'missing-bone', `Keyframes target "${an.name}", which is not a bone in this model — they will not play.`);
          }
        }

        // Floor check: sample the whole model over the animation (evenly spaced
        // times plus every keyframe time), then restore the timeline.
        let lowest: { y: number; time: number } | null = null;
        if (typeof input.floor_y === 'number' && length > 0) {
          ensureAnimationMode();
          if (animation !== (Animation as any).selected && typeof animation.select === 'function') animation.select();
          const prevTime = (Timeline as any).time;
          const samples = Math.min(200, Math.max(2, Math.floor(input.samples ?? 24)));
          const times = new Set<number>(keyTimes);
          for (let i = 0; i <= samples; i++) times.add(Math.round((length * i / samples) * 1000) / 1000);
          for (const t of [...times].filter((t) => t >= 0 && t <= length).sort((a, b) => a - b)) {
            (Timeline as any).time = t;
            (Animator as any).preview();
            const box = elementsWorldBox(null);
            if (box && (!lowest || box.min.y < lowest.y)) lowest = { y: r2(box.min.y), time: t };
          }
          (Timeline as any).time = prevTime;
          (Animator as any).preview();
          if (lowest && lowest.y < input.floor_y - 0.01) {
            add('warning', 'below-floor', `The model reaches y=${lowest.y} at ${lowest.time}s — ${r2(input.floor_y - lowest.y)} below the floor (y=${input.floor_y}). Raise the root/body by that much there, or adjust the limbs.`);
          }
        }

        return { ok: true, animation: animation.name, length, loop: loopMode, bones, keyframes, issues, ...(lowest ? { lowest } : {}) };
      } catch (e: any) {
        console.error('[MCP Plugin] checkAnimation failed:', e);
        return { ok: false, error: e?.message || String(e) };
      }
    };

    // ---------------------------------------------------------------------
    // Editing tools (ported from upstream cubes.ts modify_cube + element.ts
    // remove/rename/reparent patterns, with our guardrails).
    // ---------------------------------------------------------------------

    const findCubeByNameOrUuid = (id: string): any =>
      allCubes().find((c: any) => c.uuid === id || c.name === id);
    const findGroupByNameOrUuid = (id: string): any =>
      allGroups().find((g: any) => g.uuid === id || g.name === id);

    // Validate one cube edit and compute the properties to apply, WITHOUT touching
    // the model — shared by modify_cube and the all-or-nothing modify_cubes batch.
    // Rotation and coordinates follow the project's format rules (rule #1/#5).
    const planCubeModification = (input: any): { error: string } | { cube: any; props: any; warning: string | null } => {
      const id = input.id || input.cube_name;
      if (!id) return { error: 'id (cube name or uuid) is required. Deprecated alias cube_name is also accepted.' };
      const cube = findCubeByNameOrUuid(id);
      if (!cube) return { error: `Cube "${id}" not found. Use get_scene_tree to inspect.` };

      for (const key of ['from', 'to', 'origin'] as const) {
        if (input[key] !== undefined && !isVec3(input[key])) {
          return { error: `'${key}' must be 3 finite numbers [x,y,z] (rule #5).` };
        }
      }
      if (input.uv_offset !== undefined && !isVec2(input.uv_offset)) return { error: "'uv_offset' must be 2 finite numbers [u,v]." };
      if (input.name && input.name !== cube.name && nameTaken(input.name)) {
        return { error: `Name "${input.name}" already exists (rule #4).` };
      }

      // Normalize corners if either is being changed (rule #5: never inverted).
      const from = input.from !== undefined ? input.from : [...cube.from];
      const to = input.to !== undefined ? input.to : [...cube.to];
      const nFrom = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])] as [number, number, number];
      const nTo = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])] as [number, number, number];
      const rules = currentRules();
      if (input.from !== undefined || input.to !== undefined) {
        const boundsError = checkBounds(rules, nFrom, nTo, `Cube "${cube.name}"`);
        if (boundsError) return { error: `${boundsError} (rule #5)` };
      }
      if (input.rotation !== undefined) {
        if (!isVec3(input.rotation)) return { error: "'rotation' must be 3 finite numbers [x,y,z] degrees." };
        const rotationError = checkRotation(rules.cube, input.rotation, `Cube "${cube.name}"`);
        if (rotationError) return { error: `${rotationError} (rule #1)` };
      }
      // Only warn when the geometry is being changed — not on every UV/name edit
      // of an existing flat cube.
      const warning = (input.from !== undefined || input.to !== undefined)
        ? thinCubeWarning(nFrom, nTo, `Cube "${cube.name}"`) : null;

      return {
        cube,
        warning,
        props: {
          name: input.name ?? cube.name,
          from: nFrom,
          to: nTo,
          origin: input.origin ?? cube.origin,
          rotation: input.rotation ?? cube.rotation,
          inflate: input.inflate ?? cube.inflate,
          visibility: input.visibility ?? cube.visibility,
          shade: input.shade ?? cube.shade,
          // Setting a manual uv_offset implies box-UV lock (autouv:0) unless the
          // caller overrides — otherwise Blockbench re-derives box-UV and the
          // offset collapses to [0,0] (the recurring "everything one colour" bug).
          autouv: input.autouv !== undefined ? (Number(input.autouv) as 0 | 1 | 2) : (input.uv_offset !== undefined ? 0 : cube.autouv),
          mirror_uv: input.mirror_uv ?? cube.mirror_uv,
          uv_offset: input.uv_offset ?? cube.uv_offset,
        },
      };
    };

    const modifyCube = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const plan = planCubeModification(input);
        if ('error' in plan) return { ok: false, error: plan.error };
        const { cube, props, warning } = plan;

        Undo.initEdit({ elements: [cube], outliner: true });
        cube.extend(props);
        Undo.finishEdit('Modify cube via MCP', { elements: [cube] });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`modified cube "${cube.name}"`);
        return { ok: true, name: cube.name, from: [...cube.from], to: [...cube.to], ...(warning ? { warning } : {}) };
      } catch (err: any) {
        console.error('[MCP Plugin] modifyCube failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Edit many cubes in ONE call and ONE undo step (e.g. assign every cube's
    // uv_offset, or resize a set of parts). All entries are validated first, so a
    // bad entry changes nothing.
    const modifyCubes = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const entries: any[] = Array.isArray(input.cubes) ? input.cubes : [];
        if (!entries.length) return { ok: false, error: 'cubes[] is required (each entry: id + the fields to change).' };

        const plans: Array<{ cube: any; props: any; warning: string | null }> = [];
        const seenCubes = new Set<string>();
        const newNames = new Set<string>();
        for (let i = 0; i < entries.length; i++) {
          const plan = planCubeModification(entries[i] || {});
          if ('error' in plan) return { ok: false, error: `cubes[${i}]: ${plan.error}` };
          if (seenCubes.has(plan.cube.uuid)) return { ok: false, error: `cubes[${i}]: cube "${plan.cube.name}" appears twice in the batch.` };
          seenCubes.add(plan.cube.uuid);
          if (plan.props.name !== plan.cube.name) {
            if (newNames.has(plan.props.name)) return { ok: false, error: `cubes[${i}]: new name "${plan.props.name}" is used twice in the batch (rule #4).` };
            newNames.add(plan.props.name);
          }
          plans.push(plan);
        }

        const cubes = plans.map((p) => p.cube);
        Undo.initEdit({ elements: cubes, outliner: true } as any);
        for (const p of plans) p.cube.extend(p.props);
        Undo.finishEdit('Modify cubes via MCP', { elements: cubes } as any);
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        const warnings = plans.map((p) => p.warning).filter(Boolean) as string[];
        logToHistory(`modified ${cubes.length} cube(s) in one batch`);
        return {
          ok: true,
          cubes: plans.map((p) => ({ name: p.cube.name, from: [...p.cube.from], to: [...p.cube.to], uv_offset: p.cube.uv_offset ? [...p.cube.uv_offset] : undefined })),
          ...(warnings.length ? { warnings } : {}),
        };
      } catch (err: any) {
        console.error('[MCP Plugin] modifyCubes failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Delete a cube or group (and its children) by name/uuid.
    const deleteElement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.id) return { ok: false, error: 'id (name or uuid) is required.' };
        // Resolve cubes, groups AND meshes (delete_element used to miss meshes,
        // so a mesh could only be removed via risky_eval — LIVE 2026-06-15).
        const el = findCubeByNameOrUuid(input.id) || findGroupByNameOrUuid(input.id) || findMesh(input.id);
        if (!el) return { ok: false, error: `Element "${input.id}" not found. Use get_scene_tree to inspect.` };

        const isGroup = (typeof Group !== 'undefined' && el instanceof Group);
        const isMesh = (typeof Mesh !== 'undefined' && el instanceof Mesh);
        const kind = isGroup ? 'group' : (isMesh ? 'mesh' : 'cube');
        const name = el.name;

        // Groups delete via the outliner; cubes AND meshes are elements.
        Undo.initEdit({ elements: isGroup ? [] : [el], outliner: true, selection: true });
        el.remove();
        Undo.finishEdit('Delete element via MCP', { outliner: true, selection: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`deleted ${kind} "${name}"`);
        return { ok: true, deleted: name, kind };
      } catch (err: any) {
        console.error('[MCP Plugin] deleteElement failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Move a cube/group under another parent group (or to root).
    const reparentElement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.id) return { ok: false, error: 'id (name or uuid) is required.' };
        if (!input.parent) return { ok: false, error: "parent (group name or 'root') is required." };

        const el = findCubeByNameOrUuid(input.id) || findGroupByNameOrUuid(input.id);
        if (!el) return { ok: false, error: `Element "${input.id}" not found.` };

        let target: any = 'root';
        if (input.parent !== 'root') {
          target = findGroupByNameOrUuid(input.parent);
          if (!target) return { ok: false, error: `Parent group "${input.parent}" not found.` };
          // Guard: a group must not be moved into itself or its own descendant.
          if (typeof Group !== 'undefined' && el instanceof Group) {
            let walker: any = target;
            while (walker && walker !== 'root') {
              if (walker === el) return { ok: false, error: `Cannot move "${el.name}" into its own descendant "${target.name}".` };
              walker = walker.parent;
            }
          }
        }

        Undo.initEdit({ outliner: true, selection: true });
        el.addTo(target);
        Undo.finishEdit('Reparent element via MCP', { outliner: true, selection: true });
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`moved "${el.name}" under "${input.parent}"`);
        return { ok: true, name: el.name, parent: input.parent };
      } catch (err: any) {
        console.error('[MCP Plugin] reparentElement failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Export tools (ported from upstream export.ts). Compile the project via a
    // Blockbench codec (e.g. GeckoLib/Bedrock) and optionally write to disk.
    // ---------------------------------------------------------------------

    const listExportFormats = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const registry: any = (typeof Codecs !== 'undefined') ? (Codecs as any) : {};
        const currentId = (typeof Format !== 'undefined' && (Format as any).codec) ? (Format as any).codec.id : null;
        let summaries = Object.keys(registry).map((id) => {
          const c = registry[id] || {};
          return {
            id,
            name: c.name || id,
            extension: c.extension || null,
            has_compile: typeof c.compile === 'function',
            belongs_to_current_format: c.id === currentId,
          };
        });
        if (input.only_current_format) summaries = summaries.filter((s: any) => s.belongs_to_current_format);
        summaries.sort((a: any, b: any) => a.id.localeCompare(b.id));
        return { ok: true, current_format_codec: currentId, count: summaries.length, codecs: summaries };
      } catch (err: any) {
        console.error('[MCP Plugin] listExportFormats failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const exportModel = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const registry: any = (typeof Codecs !== 'undefined') ? (Codecs as any) : {};
        const formatCodec = (typeof Format !== 'undefined' && (Format as any).codec) ? (Format as any).codec : null;
        let resolvedId = input.codec_id || (formatCodec ? formatCodec.id : null);
        // GeckoLib's format codec is the project file (.bbmodel), but a GeckoLib model ships as
        // Bedrock geometry (.geo.json) — without a codec_id that is what the caller wants.
        let defaultNote: string | null = null;
        if (!input.codec_id && resolvedId === 'project' && (Format as any)?.id === 'geckolib_model') {
          const geo = Object.keys(registry).find((k) => /geckolib/i.test(k) && typeof registry[k]?.compile === 'function')
            || (typeof registry.bedrock?.compile === 'function' ? 'bedrock' : null);
          if (geo) {
            resolvedId = geo;
            const what = geo === 'bedrock' ? 'Bedrock geometry (.geo.json), what GeckoLib loads' : `"${geo}"`;
            defaultNote = `no codec_id: a GeckoLib model exports as ${what} — pass codec_id "project" for the .bbmodel file.`;
          }
        }
        if (!resolvedId) return { ok: false, error: 'No codec_id and the current format has no default codec. Use list_export_formats.' };
        const codec = registry[resolvedId];
        if (!codec) return { ok: false, error: `Codec "${resolvedId}" not found. Use list_export_formats for valid IDs.` };
        if (typeof codec.compile !== 'function') return { ok: false, error: `Codec "${resolvedId}" cannot export programmatically (no compile()).` };

        const effectiveOptions = input.options !== undefined
          ? input.options
          : (typeof codec.getExportOptions === 'function' ? codec.getExportOptions() : undefined);
        const rawResult = codec.compile(effectiveOptions);

        const isArrayBuffer = rawResult instanceof ArrayBuffer;
        const isBinaryView = ArrayBuffer.isView(rawResult) && !(rawResult instanceof DataView);
        let binaryBuffer: any = null;
        if (isArrayBuffer) binaryBuffer = Buffer.from(rawResult as ArrayBuffer);
        else if (isBinaryView) {
          const v = rawResult as ArrayBufferView;
          binaryBuffer = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        }

        const text = binaryBuffer ? null : (typeof rawResult === 'string' ? rawResult : (rawResult == null ? '' : JSON.stringify(rawResult, null, 2)));
        const byteLength = binaryBuffer ? binaryBuffer.byteLength : Buffer.byteLength(text || '', 'utf8');
        const encoding = binaryBuffer ? 'base64' : 'utf-8';

        let wrote_to_path: string | null = null;
        if (input.path) {
          const rnm = (globalThis as any).requireNativeModule;
          const fs = (typeof rnm === 'function')
            ? rnm('fs', { message: `MCP export_model requested write access to save the model to ${input.path}` })
            : null;
          if (!fs) return { ok: false, error: 'File system access was denied/unavailable. Omit "path" to get the content in the response instead.' };
          fs.writeFileSync(input.path, binaryBuffer ? binaryBuffer : (text || ''));
          wrote_to_path = input.path;
        }

        const maxLen = typeof input.max_content_length === 'number' ? input.max_content_length : 100000;
        const fullContent = binaryBuffer ? binaryBuffer.toString('base64') : (text || '');
        const truncated = fullContent.length > maxLen;
        const content = maxLen === 0 ? null : (truncated ? fullContent.slice(0, maxLen) : fullContent);
        const fileName = (typeof codec.fileName === 'function') ? codec.fileName() : (Project as any).name;

        // Warn about silent data loss: the Bedrock/GeckoLib geo format stores only
        // cubes, so the codec drops any mesh WITHOUT erroring or warning (the export
        // looks fine but the mesh is gone — LIVE 2026-06-15). Surface it explicitly.
        const meshCount = (typeof Mesh !== 'undefined' && (Mesh as any).all) ? (Mesh as any).all.length : 0;
        const meshWarning = (meshCount > 0 && resolvedId === 'bedrock')
          ? `${meshCount} mesh element(s) were OMITTED — the Bedrock/GeckoLib geometry format supports only cubes. Convert meshes to cubes or delete them before exporting.`
          : null;
        const warning = [defaultNote, meshWarning].filter(Boolean).join(' ') || null;

        logToHistory(`exported via "${resolvedId}"${wrote_to_path ? ` → ${wrote_to_path}` : ''}${warning ? ' [mesh omitted]' : ''}`);
        return {
          ok: true,
          codec: { id: resolvedId, name: codec.name || resolvedId, extension: codec.extension || null },
          file_name: fileName,
          byte_length: byteLength,
          encoding,
          wrote_to_path,
          truncated,
          content,
          warning,
        };
      } catch (err: any) {
        console.error('[MCP Plugin] exportModel failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Project tools (ported/adapted from upstream project.ts) + animation
    // export. set_project fixes the GeckoLib geometry identifier; export_
    // animations writes the separate .animation.json GeckoLib needs.
    // ---------------------------------------------------------------------

    const getProjectInfo = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const fmt: any = (typeof Format !== 'undefined') ? Format : null;
        const rootGroups = (typeof Outliner !== 'undefined' && Outliner.root ? Outliner.root : [])
          .filter((n: any) => typeof Group !== 'undefined' && n instanceof Group)
          .map((g: any) => ({ name: g.name, uuid: g.uuid, children: (g.children || []).length }));
        return {
          ok: true,
          info: {
            project: {
              name: (Project as any).name,
              uuid: (Project as any).uuid,
              model_identifier: (Project as any).model_identifier || null,
              save_path: (Project as any).save_path || null,
            },
            plugin_build: PLUGIN_BUILD, // bump on each plugin change to confirm the loaded build
            tool_count: pluginToolCount,
            format: {
              id: fmt ? fmt.id : null,
              name: fmt ? (fmt.display_name || fmt.name) : null,
              animation_mode: fmt ? !!fmt.animation_mode : false,
              ...(fmt && fmt.id === 'java_block' ? { minecraft: javaVersionLabel((Project as any).java_block_version), java_block_version: (Project as any).java_block_version ?? null } : {}),
            },
            rules: rulesInfo(currentRules()),
            resolution: { texture_width: (Project as any).texture_width || null, texture_height: (Project as any).texture_height || null },
            counts: {
              cubes: allCubes().length,
              groups: allGroups().length,
              textures: (typeof Texture !== 'undefined' && (Texture as any).all ? (Texture as any).all : []).length,
              animations: (typeof Animation !== 'undefined' && (Animation as any).all ? (Animation as any).all : []).length,
            },
            root_groups: rootGroups,
          },
        };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Java block/item projects target a Minecraft version, which decides the rotation
    // rules (formatRules.ts); Blockbench stores it as java_block_version.
    const applyMinecraftVersion = (minecraftVersion: string): { error: string } | { java_block_version: string } => {
      if ((Format as any)?.id !== 'java_block') return { error: 'minecraft_version only applies to Java block/item projects.' };
      const key = javaBlockVersionFor(minecraftVersion);
      if (!key) return { error: `"${minecraftVersion}" is not a Minecraft version like 1.20.1 or 26.3.` };
      (Project as any).java_block_version = key;
      return { java_block_version: key };
    };

    // Set project-level metadata. model_identifier drives the exported
    // "geometry.<id>" name (GeckoLib needs a real one, not "unknown").
    const setProject = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const changed: string[] = [];
        if (typeof input.model_identifier === 'string') { (Project as any).model_identifier = input.model_identifier; changed.push('model_identifier'); }
        if (typeof input.name === 'string') { (Project as any).name = input.name; changed.push('name'); }
        if (typeof input.texture_width === 'number' && input.texture_width > 0) changed.push('texture_width');
        if (typeof input.texture_height === 'number' && input.texture_height > 0) changed.push('texture_height');
        if (changed.some((c) => c.startsWith('texture_'))) setTextureResolution(input.texture_width, input.texture_height);
        if (input.minecraft_version !== undefined) {
          const applied = applyMinecraftVersion(String(input.minecraft_version));
          if ('error' in applied) return { ok: false, error: applied.error };
          changed.push('minecraft_version');
        }
        if (!changed.length) {
          return { ok: false, error: 'Nothing to set. Provide model_identifier, name, texture_width, texture_height or minecraft_version.' };
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`set project: ${changed.join(', ')}`);
        return { ok: true, changed, model_identifier: (Project as any).model_identifier || null, name: (Project as any).name, rules: currentRules().summary };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Create a NEW project in a given format (opens a new tab; the open project
    // stays). Replaces the risky_eval workaround for "the open project is in the
    // wrong format" (free/Java instead of Bedrock/GeckoLib).
    const FORMAT_ALIASES: Record<string, string[]> = {
      geckolib: ['geckolib_model', 'animated_entity_model'],
      bedrock: ['bedrock'],
      java: ['java_block'],
    };
    const createProject = (input: any): any => {
      try {
        const formats: any = (typeof Formats !== 'undefined') ? Formats : null;
        if (!formats || typeof newProject !== 'function') return { ok: false, error: 'Project creation API (Formats/newProject) unavailable in this Blockbench build.' };
        const available = Object.keys(formats);
        const wanted = String(input.format || '').trim();
        const candidates = FORMAT_ALIASES[wanted.toLowerCase()] || [wanted];
        const formatId = candidates.find((id) => formats[id]);
        if (!formatId) {
          const list = available.map((id) => `${id} (${formats[id].name || id})`).join(', ');
          return { ok: false, error: `Format "${wanted}" not found. Available: ${list}. Aliases: geckolib, bedrock, java.` };
        }
        const created = newProject(formats[formatId]);
        if (created === false || !hasProject()) return { ok: false, error: `Blockbench did not create the ${formatId} project.` };
        if (typeof input.name === 'string') (Project as any).name = input.name;
        if (typeof input.model_identifier === 'string') (Project as any).model_identifier = input.model_identifier;
        setTextureResolution(input.texture_width, input.texture_height);
        // A Java project defaults to the newest Minecraft rules; the server passes the
        // mod's version (default 1.20.1) so exported rotations stay loadable there.
        let versionNote: string | undefined;
        if (formatId === 'java_block') {
          const wantedVersion = input.minecraft_version || input.default_minecraft_version;
          if (wantedVersion) {
            const applied = applyMinecraftVersion(String(wantedVersion));
            if ('error' in applied) versionNote = applied.error;
          }
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`created ${formatId} project "${(Project as any).name || ''}"`);
        return {
          ok: true,
          format: formatId,
          name: (Project as any).name || null,
          model_identifier: (Project as any).model_identifier || null,
          animation_mode: !!(formats[formatId].animation_mode),
          texture: [(Project as any).texture_width || null, (Project as any).texture_height || null],
          rules: currentRules().summary,
          ...(versionNote ? { warning: versionNote } : {}),
        };
      } catch (err: any) {
        console.error('[MCP Plugin] createProject failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Compile all animations to a GeckoLib/Bedrock .animation.json (the model
    // geometry is exported separately via export_model). Optionally write to disk.
    const exportAnimations = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!animationsSupported()) return { ok: false, error: 'Current format does not support animations.' };
        const all = (typeof Animation !== 'undefined' && (Animation as any).all) ? (Animation as any).all : [];
        if (!all.length) return { ok: false, error: 'No animations to export. Create one with create_animation first.' };

        const animations: Record<string, any> = {};
        let compiled = 0;
        all.forEach((a: any) => {
          if (typeof a.compileBedrockAnimation === 'function') {
            animations[a.name] = a.compileBedrockAnimation();
            compiled++;
          }
        });
        if (!compiled) return { ok: false, error: 'No animations could be compiled (compileBedrockAnimation unavailable).' };

        const content = JSON.stringify({ format_version: '1.8.0', animations }, null, 2);

        let wrote_to_path: string | null = null;
        if (input.path) {
          const rnm = (globalThis as any).requireNativeModule;
          const fs = (typeof rnm === 'function') ? rnm('fs', { message: `MCP export_animations requested write access to ${input.path}` }) : null;
          if (!fs) return { ok: false, error: 'File system access denied/unavailable. Omit "path" to get content inline.' };
          fs.writeFileSync(input.path, content);
          wrote_to_path = input.path;
        }

        const maxLen = typeof input.max_content_length === 'number' ? input.max_content_length : 100000;
        const truncated = content.length > maxLen;
        const out = maxLen === 0 ? null : (truncated ? content.slice(0, maxLen) : content);

        logToHistory(`exported ${compiled} animation(s)${wrote_to_path ? ` → ${wrote_to_path}` : ''}`);
        return { ok: true, count: compiled, byte_length: Buffer.byteLength(content, 'utf8'), wrote_to_path, truncated, content: out };
      } catch (err: any) {
        console.error('[MCP Plugin] exportAnimations failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Texture & UV tools (ported from upstream texture.ts + uv.ts).
    // ---------------------------------------------------------------------

    const allTextures = (): any[] => (typeof Texture !== 'undefined' && (Texture as any).all) ? (Texture as any).all : [];
    const findTexture = (id: string): any => allTextures().find((t: any) => t.uuid === id || t.name === id || t.id === id);
    const allMeshes = (): any[] => (typeof Mesh !== 'undefined' && (Mesh as any).all) ? (Mesh as any).all : [];
    const findMesh = (id: string): any => allMeshes().find((m: any) => m.uuid === id || m.name === id);

    const colorToCss = (c: any): string => {
      if (Array.isArray(c)) {
        const [r, g, b, a = 255] = c;
        return `rgba(${r}, ${g}, ${b}, ${(a > 1 ? a / 255 : a)})`;
      }
      return String(c);
    };

    // Richer texture creation than register_texture: data URL, file path, fill color, or blank.
    const createTexture = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.name) return { ok: false, error: 'A unique texture name is required.' };
        if (allTextures().some((t: any) => t.name === input.name)) {
          return { ok: false, error: `Texture "${input.name}" already exists.` };
        }
        // Default to the project's texture resolution (set by pack_uv / set_project)
        // so the atlas matches the packed model instead of an arbitrary size.
        const projW = (typeof Project !== 'undefined' && (Project as any).texture_width) || 0;
        const projH = (typeof Project !== 'undefined' && (Project as any).texture_height) || 0;
        const w = input.width || projW || 16;
        const h = input.height || projH || 16;
        let tex: any;

        if (input.data && typeof input.data === 'string') {
          if (input.data.startsWith('data:image/')) {
            tex = new Texture({ name: input.name, width: w, height: h }).fromDataURL(input.data).add(false);
          } else {
            const path = input.data.replace(/^file:\/\//, '');
            tex = new Texture({ name: input.name }).fromFile({ name: path.split(/[\\/]/).pop() || path, path } as any).add(false);
          }
        } else {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          if (input.fill_color) {
            ctx.fillStyle = colorToCss(input.fill_color);
            ctx.fillRect(0, 0, w, h);
          } else {
            ctx.clearRect(0, 0, w, h);
          }
          tex = new Texture({ name: input.name, width: w, height: h }).fromDataURL(canvas.toDataURL('image/png')).add(false);
        }

        // Optional: enable texture layers so paint passes can be non-destructive
        // (paint tools accept a `layer` name to target separate base/shade/highlight).
        if (input.layers && typeof tex.activateLayers === 'function' && !tex.layers_enabled) tex.activateLayers(true);

        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`created texture "${tex.name}"${tex.layers_enabled ? ' (layers on)' : ''}`);
        return { ok: true, id: tex.uuid, uuid: tex.uuid, name: tex.name, width: tex.width || w, height: tex.height || h, layers_enabled: !!tex.layers_enabled };
      } catch (err: any) {
        console.error('[MCP Plugin] createTexture failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Swap the IMAGE of an existing texture (PNG data URL or file path) while
    // keeping the texture itself — uuid, name and every face that uses it — so a
    // lost/broken atlas can be restored in one call instead of via risky_eval.
    const replaceTexture = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.texture) return { ok: false, error: 'texture (name/uuid/id) is required.' };
        const tex = findTexture(input.texture);
        if (!tex) return { ok: false, error: `Texture "${input.texture}" not found (use list_textures).` };
        const data = typeof input.data === 'string' ? input.data.trim() : '';
        if (!data) return { ok: false, error: 'data (PNG data URL or absolute file path) is required.' };

        const keepName = tex.name;
        Undo.initEdit({ textures: [tex], bitmap: true } as any);
        let source: 'data_url' | 'path';
        if (data.startsWith('data:image/')) {
          tex.fromDataURL(data);
          source = 'data_url';
        } else {
          const path = data.replace(/^file:\/\//, '');
          tex.fromFile({ name: path.split(/[\\/]/).pop() || path, path } as any);
          source = 'path';
        }
        tex.name = keepName; // loading from a file may rename it after the file
        Undo.finishEdit('Replace texture via MCP', { textures: [tex], bitmap: true } as any);
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`replaced image of texture "${keepName}" from ${source}`);
        return { ok: true, name: keepName, uuid: tex.uuid, source };
      } catch (err: any) {
        console.error('[MCP Plugin] replaceTexture failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const listTextures = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const textures = allTextures().map((t: any) => ({ name: t.name, uuid: t.uuid, id: t.id, group: t.group || null, width: t.width, height: t.height }));
        return { ok: true, textures };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Returns the texture's image as a data URL (server turns it into MCP image content).
    const getTexture = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        let tex: any;
        if (input.texture) {
          tex = findTexture(input.texture);
          if (!tex) return { ok: false, error: `Texture "${input.texture}" not found.` };
        } else {
          tex = (typeof Texture !== 'undefined' && (Texture as any).getDefault) ? (Texture as any).getDefault() : allTextures()[0];
          if (!tex) return { ok: false, error: 'No textures in the project.' };
        }
        return { ok: true, name: tex.name, uuid: tex.uuid, data_url: tex.getDataURL() };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const activateTexture = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tex = findTexture(input.texture);
        if (!tex) return { ok: false, error: `Texture "${input.texture}" not found.` };
        if (!(typeof Texture !== 'undefined' && (Texture as any).selected) || (Texture as any).selected.uuid !== tex.uuid) {
          tex.select();
        }
        return { ok: true, name: tex.name, uuid: tex.uuid };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const addTextureGroup = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.name) return { ok: false, error: 'A group name is required.' };
        if (typeof TextureGroup === 'undefined') return { ok: false, error: 'TextureGroup is not available in this Blockbench version.' };
        const isMaterial = input.is_material !== false;
        const group = new (TextureGroup as any)({ name: input.name, is_material: isMaterial }).add();
        if (Array.isArray(input.textures) && input.textures.length) {
          const list = input.textures.map((t: string) => findTexture(t)).filter(Boolean);
          list.forEach((t: any) => t.extend({ group: group.uuid }));
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`added texture group "${group.name}"`);
        return { ok: true, name: group.name, uuid: group.uuid };
      } catch (err: any) {
        console.error('[MCP Plugin] addTextureGroup failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // --- Mesh UV (only meaningful once meshes exist; see Phase 9) ----------
    const setMeshUv = (input: any): any => {
      try {
        const mesh = findMesh(input.mesh_id);
        if (!mesh) return { ok: false, error: `Mesh "${input.mesh_id}" not found.` };
        const face = mesh.faces[input.face_key];
        if (!face) return { ok: false, error: `Face "${input.face_key}" not found in mesh.` };
        Undo.initEdit({ elements: [mesh], uv_only: true } as any);
        Object.entries(input.uv_mapping || {}).forEach(([vkey, uv]) => {
          if (face.vertices.includes(vkey)) face.uv[vkey] = uv;
        });
        mesh.preview_controller.updateUV(mesh);
        if (typeof UVEditor !== 'undefined') (UVEditor as any).loadData();
        Undo.finishEdit('Set mesh UV');
        return { ok: true, mesh: mesh.name, face: input.face_key };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const autoUvMesh = (input: any): any => {
      try {
        const mesh = input.mesh_id ? findMesh(input.mesh_id) : (allMeshes().find((m: any) => m.selected) || allMeshes()[0]);
        if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
        Undo.initEdit({ elements: [mesh], uv_only: true } as any);
        const mode = input.mode || 'project';
        const selectedFaces = input.faces || (typeof UVEditor !== 'undefined' ? (UVEditor as any).getSelectedFaces(mesh) : Object.keys(mesh.faces));
        if (mode === 'project') {
          (BarItems as any).uv_project_from_view.click();
        } else {
          selectedFaces.forEach((fkey: string) => {
            const face = mesh.faces[fkey];
            if (!face) return;
            if (mode === 'unwrap') {
              (UVEditor as any).setAutoSize(null, true, [fkey]);
            } else if (mode === 'cylinder' || mode === 'sphere') {
              const verts = face.getSortedVertices();
              verts.forEach((vkey: string) => {
                const v = mesh.vertices[vkey];
                if (mode === 'cylinder') {
                  const angle = Math.atan2(v[0], v[2]);
                  face.uv[vkey] = [((angle + Math.PI) / (2 * Math.PI)) * (Project as any).texture_width, ((v[1] + 8) / 16) * (Project as any).texture_height];
                } else {
                  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
                  const theta = Math.acos(v[1] / len);
                  const phi = Math.atan2(v[0], v[2]);
                  face.uv[vkey] = [((phi + Math.PI) / (2 * Math.PI)) * (Project as any).texture_width, (theta / Math.PI) * (Project as any).texture_height];
                }
              });
            }
          });
        }
        mesh.preview_controller.updateUV(mesh);
        if (typeof UVEditor !== 'undefined') (UVEditor as any).loadData();
        Undo.finishEdit('Auto UV mesh');
        return { ok: true, mesh: mesh.name, mode, faces: selectedFaces.length };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const rotateMeshUv = (input: any): any => {
      try {
        const mesh = input.mesh_id ? findMesh(input.mesh_id) : (allMeshes().find((m: any) => m.selected) || allMeshes()[0]);
        if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
        Undo.initEdit({ elements: [mesh], uv_only: true } as any);
        if (input.faces && input.faces.length) {
          const sel = mesh.getSelectedFaces(true);
          sel.length = 0;
          sel.push(...input.faces);
        }
        (UVEditor as any).rotate(parseInt(input.angle || '90'));
        Undo.finishEdit('Rotate mesh UV');
        const affected = input.faces || mesh.getSelectedFaces();
        return { ok: true, mesh: mesh.name, angle: input.angle || '90', faces: affected.length };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Camera & screenshot tools (ported from upstream camera.ts + util.ts).
    // Return a data URL; the server turns it into MCP image content.
    // ---------------------------------------------------------------------

    // Screenshots are the heaviest thing the model has to read. Downscale so the
    // longest edge is at most `max_size` px — 800 keeps a model clearly readable at
    // roughly a third of the image tokens of a full viewport. 0 = native size.
    const DEFAULT_SCREENSHOT_MAX = 800;
    const screenshotMax = (input: any): number => {
      const v = Number(input?.max_size);
      return input?.max_size !== undefined && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SCREENSHOT_MAX;
    };
    const scaledSize = (w: number, h: number, maxSize: number): [number, number] | null => {
      const longest = Math.max(w, h);
      if (!maxSize || longest <= maxSize) return null;
      const k = maxSize / longest;
      return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
    };
    const drawScaled = (src: CanvasImageSource, w: number, h: number): string | null => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      return c.toDataURL();
    };
    // Scale an image data URL (e.g. a Screencam app capture) the same way.
    const scaleDataURL = (dataUrl: string, maxSize: number): Promise<string> =>
      new Promise((resolve) => {
        if (!maxSize || !dataUrl) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = () => {
          const size = scaledSize(img.width, img.height, maxSize);
          resolve(size ? (drawScaled(img, size[0], size[1]) || dataUrl) : dataUrl);
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });

    const renderPreviewDataURL = (preview: any, maxSize = DEFAULT_SCREENSHOT_MAX): string | undefined => {
      let dataUrl: string | undefined;
      (Canvas as any).withoutGizmos(() => {
        preview.render();
        // Read the WebGL canvas in the same tick as render(), before it is cleared.
        const canvas = preview.canvas;
        const size = scaledSize(canvas.width, canvas.height, maxSize);
        dataUrl = (size && drawScaled(canvas, size[0], size[1])) || canvas.toDataURL();
      });
      return dataUrl;
    };

    // If `time` is given, evaluate the (named or selected) animation at that moment
    // SYNCHRONOUSLY before rendering — otherwise a render races the timeline and can
    // show the rest pose instead of the animated frame (the evaluate-then-measure
    // pattern get_bone_pose uses). No time = leave the current pose as-is.
    const poseAtTime = (input: any): void => {
      if (input.time === undefined) return;
      try {
        ensureAnimationMode();
        const anim = input.animation_id ? findAnimation(input.animation_id) : ensureSelectedAnimation();
        if (anim && anim !== (Animation as any).selected && typeof anim.select === 'function') anim.select();
        (Timeline as any).time = input.time;
        if (typeof Animator !== 'undefined' && (Animator as any).preview) (Animator as any).preview();
      } catch { /* best-effort: fall back to the current pose */ }
    };

    // A contact sheet: several angles and/or animation frames in ONE image — one read
    // instead of a screenshot each (packages/shared/src/views.ts). Each named view is
    // framed on the whole model over all requested frames; without views every frame uses
    // the current camera. The camera and the timeline are put back afterwards.
    const captureSheet = (input: any, preview: any): any => {
      const views: View[] = Array.isArray(input.views) ? input.views : [];
      const times: number[] = Array.isArray(input.times) ? input.times : (views.length && input.time !== undefined ? [input.time] : []);
      if (views.some((v) => !(VIEWS as readonly string[]).includes(v))) return { ok: false, error: `views must be from: ${VIEWS.join(', ')}.` };
      if (times.some((t) => typeof t !== 'number' || !isFinite(t) || t < 0)) return { ok: false, error: 'times must be seconds ≥ 0.' };
      if (views.length > 8 || times.length > 12 || Math.max(1, views.length) * Math.max(1, times.length) > 16) return { ok: false, error: 'A sheet takes at most 8 views, 12 times and 16 pictures.' };
      const cam = preview.camera, controls = preview.controls;
      const saved = {
        position: cam?.position?.toArray?.(), target: controls?.target?.toArray?.(),
        ortho: !!preview.isOrtho, zoom: preview.camOrtho?.zoom,
      };
      const savedTime = times.length && typeof Timeline !== 'undefined' ? (Timeline as any).time : null;
      const frames: (number | null)[] = times.length ? times : [null];
      const angles: (View | null)[] = views.length ? views : [null];
      const poseAt = (t: number | null) => { if (t !== null) poseAtTime({ time: t, animation_id: input.animation_id }); };
      try {
        // Frame on the model over every requested frame.
        let box: any = null;
        for (const t of frames) {
          poseAt(t);
          const b = elementsWorldBox(null);
          if (b) box = box ? box.union(b) : b.clone();
        }
        const center: Vec3 = box ? [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2] : [0, 8, 0];
        const dist = fitDistance(box ? box.min.distanceTo(box.max) / 2 : 8, preview.camPers?.fov ?? 45);
        const { cols, rows } = sheetLayout(views.length, times.length);
        const gap = 4;
        const cell = sheetCell(cols, rows, screenshotMax(input) || 1600, gap);
        const sheet = document.createElement('canvas');
        sheet.width = cols * cell + (cols + 1) * gap;
        sheet.height = rows * cell + (rows + 1) * gap;
        const ctx = sheet.getContext('2d');
        if (!ctx) return { ok: false, error: 'Could not create the sheet canvas.' };
        ctx.fillStyle = '#3a3d44';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        const cells: string[] = [];
        let index = 0;
        for (const t of frames) {
          for (const v of angles) {
            poseAt(t);
            if (v) {
              const d = viewDirection(v);
              preview.loadAnglePreset({ position: center.map((x, k) => x + d[k] * dist), target: center, projection: 'perspective' });
            }
            const x0 = gap + (index % cols) * (cell + gap), y0 = gap + Math.floor(index / cols) * (cell + gap);
            ctx.fillStyle = '#e6e8ec';
            ctx.fillRect(x0, y0, cell, cell);
            (Canvas as any).withoutGizmos(() => {
              preview.render();
              // Read the WebGL canvas in the same tick as render(); keep the centred square.
              const src = preview.canvas;
              const side = Math.min(src.width, src.height);
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, x0, y0, cell, cell);
            });
            const label = [v, t !== null ? `t=${t}s` : null].filter(Boolean).join(' · ') || 'current view';
            const font = Math.max(11, Math.round(cell / 20));
            ctx.font = `600 ${font}px sans-serif`;
            ctx.fillStyle = 'rgba(20, 22, 28, 0.72)';
            ctx.fillRect(x0 + 4, y0 + 4, ctx.measureText(label).width + font * 0.8, font * 1.5);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, x0 + 4 + font * 0.4, y0 + 4 + font * 1.1);
            cells.push(label);
            index++;
          }
        }
        return { ok: true, data_url: sheet.toDataURL(), cells, cols, rows };
      } finally {
        try {
          if (saved.position && saved.target) preview.loadAnglePreset({ position: saved.position, target: saved.target, projection: saved.ortho ? 'orthographic' : 'perspective' });
          if (saved.ortho && saved.zoom && preview.camOrtho) { preview.camOrtho.zoom = saved.zoom; preview.camOrtho.updateProjectionMatrix?.(); }
        } catch { /* the view is best-effort */ }
        if (savedTime !== null) {
          try { (Timeline as any).time = savedTime; (Animator as any).preview?.(); } catch { /* best-effort */ }
        }
      }
    };

    const captureScreenshot = (input: any): any => {
      try {
        let selectedProject: any = (typeof Project !== 'undefined') ? Project : null;
        const projects: any[] = typeof ModelProject !== 'undefined' ? (ModelProject as any).all : [];
        if (input.project !== undefined) {
          // Match the requested project exactly. (The old `name || uuid || selected`
          // test returned whichever project came first — often the open one, so a
          // screenshot of another tab silently showed the wrong model; seen live.)
          selectedProject = projects.find((p: any) => p.name === input.project || p.uuid === input.project);
          if (!selectedProject) return { ok: false, error: `Project "${input.project}" not found. Open projects: ${projects.map((p: any) => p.name).join(', ') || '(none)'}.` };
        } else if (!selectedProject) {
          selectedProject = projects.find((p: any) => p.selected) || null;
        }
        if (!selectedProject) return { ok: false, error: 'No project found.' };
        if (!selectedProject.selected) selectedProject.select();

        const preview = (Preview as any).selected;
        if (!preview) return { ok: false, error: 'No preview available for the selected project.' };
        if (Array.isArray(input.views) || Array.isArray(input.times)) return captureSheet(input, preview);
        poseAtTime(input);

        const dataUrl = renderPreviewDataURL(preview, screenshotMax(input));
        if (!dataUrl) return { ok: false, error: 'Failed to capture preview screenshot.' };
        return { ok: true, data_url: dataUrl };
      } catch (err: any) {
        console.error('[MCP Plugin] captureScreenshot failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // Whole-window capture (also used after trigger_action / emulate_clicks /
    // from_geo_json). A full app window is large, so it is downscaled too.
    const captureAppScreenshot = (input?: any): Promise<any> =>
      new Promise((resolve) => {
        try {
          if (typeof Screencam === 'undefined' || !(Screencam as any).fullScreen) {
            resolve({ ok: false, error: 'Screencam unavailable (desktop only).' });
            return;
          }
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'App screenshot timed out.' }); } }, 5000);
          (Screencam as any).fullScreen({}, async (dataUrl: string) => {
            if (done) return;
            done = true;
            clearTimeout(t);
            if (!dataUrl) { resolve({ ok: false, error: 'No data returned.' }); return; }
            resolve({ ok: true, data_url: await scaleDataURL(dataUrl, screenshotMax(input)) });
          });
        } catch (err: any) {
          resolve({ ok: false, error: err?.message || String(err) });
        }
      });

    const setCameraAngle = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const preview = (Preview as any).selected;
        if (!preview) return { ok: false, error: 'No preview found in the editor.' };
        preview.loadAnglePreset({
          position: input.position,
          target: input.target,
          rotation: input.rotation,
          projection: input.projection,
        });
        // screenshot:false = just move the camera (e.g. before a capture_screenshot
        // with a `time`), saving a whole image round-trip for the model.
        if (input.screenshot === false) return { ok: true, message: `Camera set to [${(input.position || []).join(', ')}].` };
        poseAtTime(input);
        const dataUrl = renderPreviewDataURL(preview, screenshotMax(input));
        if (!dataUrl) return { ok: false, error: 'Failed to capture screenshot after setting angle.' };
        return { ok: true, data_url: dataUrl };
      } catch (err: any) {
        console.error('[MCP Plugin] setCameraAngle failed:', err);
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // History tools (ported from upstream history.ts): undo/redo/stack/checkpoint.
    // ---------------------------------------------------------------------

    const summarizeHistory = (limit: number) => {
      const history: any[] = (Undo as any).history ?? [];
      const index = (Undo as any).index ?? 0;
      const start = Math.max(0, history.length - limit);
      const entries = history.slice(start).map((entry: any, offset: number) => {
        const absoluteIndex = start + offset;
        return {
          index: absoluteIndex,
          action: entry.action ?? '(unnamed edit)',
          type: entry.type ?? 'edit',
          time: entry.time ?? 0,
          is_applied: absoluteIndex < index,
          is_current: absoluteIndex === index - 1,
        };
      }).reverse();
      return { index, total: history.length, can_undo: index > 0, can_redo: index < history.length, entries };
    };

    const undoTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const history: any[] = (Undo as any).history ?? [];
        const available = (Undo as any).index ?? 0;
        if (available === 0) return { ok: false, error: 'Nothing to undo. The undo stack is empty.' };
        const steps = typeof input.steps === 'number' ? input.steps : 1;
        const count = Math.min(steps, available);
        const undone: string[] = [];
        for (let i = 0; i < count; i++) {
          const entry = history[((Undo as any).index ?? 0) - 1];
          undone.push(entry?.action ?? '(unnamed edit)');
          (Undo as any).undo();
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, undone_count: undone.length, requested: steps, undone, new_index: (Undo as any).index };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const redoTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const history: any[] = (Undo as any).history ?? [];
        const available = history.length - ((Undo as any).index ?? 0);
        if (available === 0) return { ok: false, error: 'Nothing to redo.' };
        const steps = typeof input.steps === 'number' ? input.steps : 1;
        const count = Math.min(steps, available);
        const redone: string[] = [];
        for (let i = 0; i < count; i++) {
          const entry = history[(Undo as any).index ?? 0];
          redone.push(entry?.action ?? '(unnamed edit)');
          (Undo as any).redo();
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, redone_count: redone.length, requested: steps, redone, new_index: (Undo as any).index };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const getUndoStack = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        return { ok: true, stack: summarizeHistory(typeof input.limit === 'number' ? input.limit : 50) };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    const saveCheckpoint = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.name) return { ok: false, error: 'A checkpoint name is required.' };
        const label = `[checkpoint] ${input.name}`;
        Undo.initEdit({ elements: [], outliner: true } as any);
        Undo.finishEdit(label);
        logToHistory(`checkpoint "${input.name}"`);
        return { ok: true, name: input.name, label, index: (Undo as any).index, total: (Undo as any).history?.length ?? 0 };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    };

    // ---------------------------------------------------------------------
    // Element utilities (ported from upstream element.ts). list_outline is
    // skipped — get_scene_tree already covers it.
    // ---------------------------------------------------------------------

    const findElementAny = (id: string): any =>
      findCubeByNameOrUuid(id) || findGroupByNameOrUuid(id) || allMeshes().find((m: any) => m.uuid === id || m.name === id);
    const elementType = (el: any): 'cube' | 'mesh' | 'group' | null => {
      if (typeof Cube !== 'undefined' && el instanceof Cube) return 'cube';
      if (typeof Mesh !== 'undefined' && el instanceof Mesh) return 'mesh';
      if (typeof Group !== 'undefined' && el instanceof Group) return 'group';
      return null;
    };
    const parentName = (el: any): string | null => {
      const p = el.parent;
      if (!p || typeof p !== 'object') return null;
      return p.name ?? p.uuid ?? null;
    };
    const isDescendantOf = (el: any, target: any): boolean => {
      let cur = el;
      while (cur && cur.parent && typeof cur.parent === 'object') {
        if (cur.parent === target) return true;
        cur = cur.parent;
      }
      return false;
    };

    const renameElement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.id) return { ok: false, error: 'id is required.' };
        if (!input.new_name) return { ok: false, error: 'new_name is required.' };
        const el = findElementAny(input.id);
        if (!el) return { ok: false, error: `Element "${input.id}" not found.` };
        if (input.new_name !== el.name && nameTaken(input.new_name)) {
          return { ok: false, error: `Name "${input.new_name}" already exists (rule #4).` };
        }
        Undo.initEdit({ elements: [el], outliner: true } as any);
        el.extend({ name: input.new_name });
        Undo.finishEdit('Rename element via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`renamed "${input.id}" → "${input.new_name}"`);
        return { ok: true, id: input.id, name: input.new_name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // Placement: a part's world bounds, moving a whole part (a group with everything
    // inside, pivots included) in one undo step, placing it against another part, and
    // mirrored copies. The math is packages/shared/src/placement.ts — unit-tested, and
    // the test mock runs the same functions.
    // ---------------------------------------------------------------------
    const isGroupEl = (n: any): boolean => typeof Group !== 'undefined' && n instanceof Group;
    const v3 = (v: any): Vec3 => (isVec3(v) ? [v[0], v[1], v[2]] : [0, 0, 0]);
    const toGeoNode = (n: any): GeoNode | null => {
      if (isGroupEl(n)) {
        return {
          name: n.name, kind: 'group', origin: v3(n.origin), rotation: v3(n.rotation),
          children: (n.children || []).map(toGeoNode).filter((c: GeoNode | null): c is GeoNode => !!c),
        };
      }
      if (isVec3(n.from) && isVec3(n.to)) {
        return { name: n.name, kind: 'cube', origin: v3(n.origin), rotation: v3(n.rotation), from: v3(n.from), to: v3(n.to), inflate: typeof n.inflate === 'number' ? n.inflate : 0 };
      }
      if (typeof Mesh !== 'undefined' && n instanceof Mesh) {
        const o = v3(n.origin); // mesh vertices are relative to its origin
        const points = Object.values((n as any).vertices || {}).map((p: any) => [p[0] + o[0], p[1] + o[1], p[2] + o[2]] as Vec3);
        return { name: n.name, kind: 'point', origin: o, rotation: v3(n.rotation), points };
      }
      if (isVec3(n.position)) return { name: n.name, kind: 'point', origin: v3(n.position), rotation: [0, 0, 0], points: [v3(n.position)] };
      return null;
    };
    // The rotations above a node, nearest group first.
    const chainAbove = (n: any): Frame[] => {
      const chain: Frame[] = [];
      for (let p = n.parent; p && isGroupEl(p); p = p.parent) chain.push({ origin: v3(p.origin), rotation: v3(p.rotation) });
      return chain;
    };
    const worldBoxOf = (n: any): Box | null => {
      const g = toGeoNode(n);
      return g ? boxOf(worldPoints(g, chainAbove(n))) : null;
    };
    const subtreeOf = (n: any): any[] => [n, ...(n.children || []).flatMap(subtreeOf)];
    const shiftNode = (n: any, d: Vec3) => {
      const add = (v: any) => { if (isVec3(v)) for (let i = 0; i < 3; i++) v[i] = Math.round((v[i] + d[i]) * 1e4) / 1e4; };
      if (isGroupEl(n)) add(n.origin);
      else if (isVec3(n.from) && isVec3(n.to)) { add(n.from); add(n.to); add(n.origin); }
      else if (isVec3(n.position)) add(n.position);
      else add(n.origin); // meshes: the vertices are relative to the origin
    };
    // Every cube of a part must stay inside the format's coordinate range after a move.
    const moveRangeError = (nodes: any[], d: Vec3): string | null => {
      const rules = currentRules();
      for (const n of nodes) {
        if (!isVec3(n.from) || !isVec3(n.to)) continue;
        const err = checkBounds(rules, n.from.map((v: number, i: number) => v + d[i]) as Vec3, n.to.map((v: number, i: number) => v + d[i]) as Vec3, `Cube "${n.name}"`);
        if (err) return err;
      }
      return null;
    };
    const commitShift = (nodes: any[], d: Vec3, label: string) => {
      const groups = nodes.filter(isGroupEl), elements = nodes.filter((n) => !isGroupEl(n));
      const aspects: any = { elements, groups, outliner: groups.length > 0 };
      Undo.initEdit(aspects);
      nodes.forEach((n) => shiftNode(n, d));
      Undo.finishEdit(label, aspects);
      if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
    };
    // A move by a fraction of a unit (e.g. centring 3 wide on 4) leaves the part between whole pixels.
    const gridNote = (worldDelta: Vec3) => worldDelta.some((v) => Math.abs(v - Math.round(v)) > 1e-4)
      ? 'it moved by a fraction of a unit, so it now sits between whole pixels — fine for geometry, but pixel textures line up best on whole units (nudge with offset).'
      : undefined;

    // Move a whole part by a world offset, or put its pivot at a world point.
    const moveElement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const part = input.target ? findElementAny(String(input.target)) : null;
        if (!part) return { ok: false, error: `Element or group "${input.target}" not found.` };
        if (isVec3(input.offset) === isVec3(input.to)) return { ok: false, error: "Give exactly one of 'offset' [x,y,z] (move by) or 'to' [x,y,z] (where the pivot goes) — both must be 3 finite numbers." };
        const chain = chainAbove(part);
        const pivot = throughChain(v3(isVec3(part.origin) ? part.origin : part.position), chain);
        const world: Vec3 = isVec3(input.offset) ? v3(input.offset) : roundVec([0, 1, 2].map((i) => input.to[i] - pivot[i]));
        const d = toModelDelta(world, chain);
        const nodes = subtreeOf(part);
        const rangeError = moveRangeError(nodes, d);
        if (rangeError) return { ok: false, error: rangeError };
        const before = worldBoxOf(part);
        const after = before && shiftBox(before, world);
        if (input.dry_run) return { ok: true, dry_run: true, name: part.name, delta: world, moved: nodes.length, box: after };
        commitShift(nodes, d, 'Move element via MCP');
        logToHistory(`moved "${part.name}" by [${world.join(', ')}]`);
        return { ok: true, name: part.name, delta: world, moved: nodes.length, box: worldBoxOf(part), warning: gridNote(world) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // Put a part against a side of another ("the head on top of the body, centred").
    const placeRelative = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const part = input.target ? findElementAny(String(input.target)) : null;
        if (!part) return { ok: false, error: `Element or group "${input.target}" not found.` };
        const ref = input.ref ? findElementAny(String(input.ref)) : null;
        if (!ref) return { ok: false, error: `Reference "${input.ref}" not found.` };
        if (part === ref || isDescendantOf(ref, part)) return { ok: false, error: `"${ref.name}" is inside "${part.name}" and would move with it — place against a part outside it.` };
        if (!(SIDES as readonly string[]).includes(input.side)) return { ok: false, error: `side must be one of ${SIDES.join(', ')}.` };
        const align = input.align ?? 'center';
        if (!(ALIGNS as readonly string[]).includes(align)) return { ok: false, error: `align must be one of ${ALIGNS.join(', ')}.` };
        const gap = typeof input.gap === 'number' && isFinite(input.gap) ? input.gap : 0;
        const box = worldBoxOf(part), refBox = worldBoxOf(ref);
        if (!box) return { ok: false, error: `"${part.name}" has no geometry to place.` };
        if (!refBox) return { ok: false, error: `Reference "${ref.name}" has no geometry to place against.` };
        const world = placementDelta(box, refBox, input.side as Side, { gap, align: align as Align, offset: isVec3(input.offset) ? v3(input.offset) : undefined });
        const d = toModelDelta(world, chainAbove(part));
        const nodes = subtreeOf(part);
        const rangeError = moveRangeError(nodes, d);
        if (rangeError) return { ok: false, error: rangeError };
        const after = shiftBox(box, world);
        const result = { name: part.name, ref: ref.name, side: input.side, delta: world, ref_box: refBox };
        if (input.dry_run) return { ok: true, dry_run: true, ...result, box: after };
        commitShift(nodes, d, 'Place element via MCP');
        logToHistory(`placed "${part.name}" ${input.side} "${ref.name}"`);
        return { ok: true, ...result, box: worldBoxOf(part), warning: gridNote(world) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // Mirror a copied node across the plane `center` on `axis` (as Blockbench's Flip does):
    // coordinates mirrored, the other two rotation axes turned around, box UV mirrored.
    const mirrorNode = (n: any, axis: number, center: number) => {
      if (isGroupEl(n)) {
        n.origin[axis] = mirrorCoord(n.origin[axis], center);
        for (let i = 0; i < 3; i++) if (i !== axis && n.rotation) n.rotation[i] = -n.rotation[i] + 0;
      } else if (typeof n.flip === 'function') {
        n.flip(axis, center, false); // cubes: coordinates, rotation, UV / mirror_uv
      } else if (isVec3(n.position)) {
        n.position[axis] = mirrorCoord(n.position[axis], center);
      }
    };

    // Uses Blockbench's own duplicate(), which copies every property (per-face UV,
    // textures, …) and every child type (cubes, meshes, locators, groups). The old
    // hand-written clone lost face data, offset meshes twice (their vertices are
    // relative to the origin), gave newName to every child (duplicate names), and
    // put groups in the Undo "elements" aspect, which throws in Blockbench 5
    // after the copy was already made (all seen live on 5.2.1).
    // `mirror` makes the copy the mirror image across a plane (left arm → right arm,
    // names swapped); `count` makes a row of copies, each `offset` further on.
    const duplicateElement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.id) return { ok: false, error: 'id is required.' };
        const element = findElementAny(input.id);
        if (!element) return { ok: false, error: `Element "${input.id}" not found.` };
        if (typeof (element as any).duplicate !== 'function') return { ok: false, error: `"${element.name}" cannot be duplicated.` };
        const offset: number[] = isVec3(input.offset) ? input.offset : [0, 0, 0];
        const count = input.count === undefined ? 1 : Number(input.count);
        if (!Number.isInteger(count) || count < 1 || count > 64) return { ok: false, error: 'count must be a whole number from 1 to 64.' };
        const axis = input.mirror === undefined ? null : ['x', 'y', 'z'].indexOf(String(input.mirror));
        if (axis === -1) return { ok: false, error: "mirror must be 'x', 'y' or 'z'." };
        const center = typeof input.mirror_center === 'number' && isFinite(input.mirror_center)
          ? input.mirror_center : ((Format as any)?.centered_grid ? 0 : 8);
        const topName = (k: number): string | null => {
          if (!input.newName) return null;
          return count > 1 ? String(input.newName).replace('{i}', String(k)) : String(input.newName);
        };
        if (input.newName && count > 1 && !String(input.newName).includes('{i}')) return { ok: false, error: "With count > 1, newName needs '{i}' for the copy number (e.g. 'spike_{i}') so every name is unique." };
        for (let k = 1; k <= count; k++) {
          const n = topName(k);
          if (n && nameTaken(n)) return { ok: false, error: `Name "${n}" already exists. Names must be unique (rule #4).` };
        }

        const uniqueCopyName = (base: string): string => {
          let n = `${base}_copy`;
          let i = 1;
          while (nameTaken(n)) n = `${base}_copy${i++}`;
          return n;
        };
        // A mirrored copy takes the other side's name ("left_arm" → "right_arm") when free.
        const pickName = (src: any, top: boolean, k: number): string => {
          const given = top ? topName(k) : null;
          if (given) return given;
          if (axis !== null) {
            const flipped = mirroredName(src.name, axis);
            if (flipped !== src.name && !nameTaken(flipped)) return flipped;
          }
          return uniqueCopyName(src.name);
        };
        const copies: any[] = [];
        // Walk source and copy side by side (duplicate() keeps the child order).
        const adjust = (src: any, cp: any, top: boolean, k: number) => {
          copies.push(cp);
          // Pick the name first: Blockbench's flip() renames the copy itself (left → right),
          // which would make that name look taken.
          const name = pickName(src, top, k);
          if (axis !== null) mirrorNode(cp, axis, center);
          cp.name = name;
          shiftNode(cp, offset.map((v) => v * k) as Vec3);
          (src.children || []).forEach((child: any, i: number) => { if (cp.children?.[i]) adjust(child, cp.children[i], false, k); });
        };

        // Same aspects as Blockbench's own "Duplicate group": new groups go in "groups",
        // everything else in "elements" — with outliner alone, undo left new groups behind.
        Undo.initEdit({ elements: [], groups: [], outliner: true, selection: true } as any);
        const made: any[] = [];
        try {
          for (let k = 1; k <= count; k++) {
            const copy = (element as any).duplicate();
            made.push(copy);
            adjust(element, copy, true, k);
          }
        } catch (e: any) {
          for (const copy of made) { try { copy.remove(); } catch { /* best effort */ } }
          Undo.cancelEdit(false);
          return { ok: false, error: `duplicate_element failed, nothing was kept: ${e?.message || String(e)}` };
        }
        Undo.finishEdit('Duplicate element via MCP', {
          elements: copies.filter((n) => !isGroupEl(n)),
          groups: copies.filter(isGroupEl),
          outliner: true,
          selection: true,
        } as any);
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`duplicated "${element.name}" → ${made.map((c) => `"${c.name}"`).join(', ')} (${copies.length} element(s))`);
        return {
          ok: true, source: element.name, name: made[0].name, uuid: made[0].uuid, count: copies.length,
          copies: made.map((c) => c.name), names: copies.map((n) => n.name),
          ...(axis !== null ? { mirrored: { axis: ['x', 'y', 'z'][axis], center } } : {}),
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const findElementsByCriteria = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const type = input.type || 'any';
        const needle = input.name_contains ? String(input.name_contains).toLowerCase() : null;
        let regex: RegExp | null = null;
        if (input.name_pattern) { try { regex = new RegExp(input.name_pattern); } catch { /* ignore bad pattern */ } }
        const limit = typeof input.limit === 'number' ? input.limit : 100;
        let parentScope: any = null;
        if (input.parent_group) {
          parentScope = findGroupByNameOrUuid(input.parent_group);
          if (!parentScope) return { ok: false, error: `Parent group "${input.parent_group}" not found.` };
        }
        const selOnly = !!input.selected_only;
        const cubes = selOnly ? ((Cube as any).selected || []) : allCubes();
        const meshes = selOnly ? (typeof Mesh !== 'undefined' ? ((Mesh as any).selected || []) : []) : allMeshes();
        const groups = selOnly ? allGroups().filter((g: any) => g.selected) : allGroups();
        const candidates = [...cubes, ...meshes, ...groups];
        const matches: any[] = [];
        for (const el of candidates) {
          if (matches.length >= limit) break;
          const t = elementType(el); if (!t) continue;
          if (type !== 'any' && t !== type) continue;
          if (regex && !regex.test(el.name)) continue;
          if (needle && !el.name.toLowerCase().includes(needle)) continue;
          if (parentScope && !isDescendantOf(el, parentScope)) continue;
          if (t === 'cube' && (input.min_size || input.max_size)) {
            const size = [el.to[0] - el.from[0], el.to[1] - el.from[1], el.to[2] - el.from[2]];
            const min = input.min_size, max = input.max_size;
            if (min && size.some((v: number, i: number) => v < (min[i] ?? -Infinity))) continue;
            if (max && size.some((v: number, i: number) => v > (max[i] ?? Infinity))) continue;
          }
          matches.push({ uuid: el.uuid, name: el.name, type: t, parent: parentName(el) });
        }
        return { ok: true, count: matches.length, truncated: matches.length >= limit, matches };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const selectAllOfType = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const type = input.type || 'cube';
        let parentScope: any = null;
        if (input.parent_group) {
          parentScope = findGroupByNameOrUuid(input.parent_group);
          if (!parentScope) return { ok: false, error: `Parent group "${input.parent_group}" not found.` };
        }
        const pool = type === 'cube' ? allCubes() : type === 'mesh' ? allMeshes() : allGroups();
        const targets = parentScope ? pool.filter((el: any) => isDescendantOf(el, parentScope)) : pool;
        if (!input.add_to_selection) {
          allCubes().forEach((c: any) => { if (c.selected) c.unselect?.(); });
          allMeshes().forEach((m: any) => { if (m.selected) m.unselect?.(); });
          allGroups().forEach((g: any) => { if (g.selected) g.selected = false; });
        }
        for (const el of targets) {
          if (typeof Group !== 'undefined' && el instanceof Group) { el.selected = true; continue; }
          el.select?.({ shiftKey: true });
        }
        if (typeof updateSelection === 'function') (updateSelection as any)();
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, type, selected: targets.length, parent_group: parentScope ? parentScope.name : null };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const filterByMaterial = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.texture) return { ok: false, error: 'texture is required.' };
        const tex = findTexture(input.texture);
        if (!tex) return { ok: false, error: `Texture "${input.texture}" not found.` };
        const matches: any[] = [];
        const scan = (els: any[], t: string) => {
          for (const el of els) {
            const keys: string[] = [];
            for (const [key, face] of Object.entries(el.faces || {})) {
              const fid = (face as any).texture;
              if (fid === tex.uuid || fid === tex.id) keys.push(key);
            }
            if (keys.length) matches.push({ uuid: el.uuid, name: el.name, type: t, ...(input.include_face_keys ? { faces: keys } : {}) });
          }
        };
        scan(allCubes(), 'cube');
        scan(allMeshes(), 'mesh');
        return { ok: true, texture: { uuid: tex.uuid, name: tex.name }, count: matches.length, matches };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const getSelection = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const cubes = ((Cube as any).selected || []).map((c: any) => ({ uuid: c.uuid, name: c.name, type: 'cube' }));
        const meshes = (typeof Mesh !== 'undefined' ? ((Mesh as any).selected || []) : []).map((m: any) => ({ uuid: m.uuid, name: m.name, type: 'mesh' }));
        const groups = allGroups().filter((g: any) => g.selected).map((g: any) => ({ uuid: g.uuid, name: g.name, type: 'group' }));
        const at = (typeof Texture !== 'undefined' && (Texture as any).selected)
          ? { uuid: (Texture as any).selected.uuid, id: (Texture as any).selected.id, name: (Texture as any).selected.name }
          : null;
        return { ok: true, counts: { cubes: cubes.length, meshes: meshes.length, groups: groups.length }, cubes, meshes, groups, active_texture: at };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // PBR materials (texture.ts PBR subset) + face material instances
    // (material-instances.ts). Bedrock/RTX-specific; guarded for formats
    // that lack TextureGroup/material_config.
    // ---------------------------------------------------------------------
    const FACE_KEYS = ['north', 'south', 'east', 'west', 'up', 'down'];

    const findTextureGroup = (id: string): any => {
      const all = (typeof TextureGroup !== 'undefined' && (TextureGroup as any).all) ? (TextureGroup as any).all : [];
      return all.find((g: any) => g.uuid === id || g.name === id);
    };
    const channelInfo = (textures: any[], channel: string) => {
      const t = textures.find((x: any) => x.pbr_channel === channel);
      return t ? { name: t.name, uuid: t.uuid } : null;
    };

    const createPbrMaterial = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (typeof TextureGroup === 'undefined') return { ok: false, error: 'PBR materials (TextureGroup) not available in this format.' };
        if (!input.name) return { ok: false, error: 'name is required.' };
        Undo.initEdit({ texture_groups: [], textures: [] } as any);
        const tg: any = new (TextureGroup as any)({ name: input.name, is_material: true });
        if (tg.material_config) {
          if (input.color_value) tg.material_config.color_value = input.color_value;
          if (input.mer_value) tg.material_config.mer_value = input.mer_value;
          if (input.subsurface_value !== undefined) tg.material_config.subsurface_value = input.subsurface_value;
          tg.material_config.saved = false;
        }
        tg.add();
        const assign = (texId: string | undefined, channel: string) => {
          if (!texId) return;
          const tex = findTexture(texId);
          if (tex) tex.extend({ group: tg.uuid, pbr_channel: channel });
        };
        assign(input.color_texture, 'color');
        assign(input.normal_texture, 'normal');
        assign(input.height_texture, 'height');
        assign(input.mer_texture, 'mer');
        if (typeof tg.updateMaterial === 'function') tg.updateMaterial();
        Undo.finishEdit('Create PBR material via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`created PBR material "${tg.name}"`);
        return { ok: true, name: tg.name, uuid: tg.uuid };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const configureMaterial = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tg = findTextureGroup(input.material);
        if (!tg) return { ok: false, error: `Material "${input.material}" not found.` };
        const textures = tg.getTextures ? tg.getTextures() : [];
        Undo.initEdit({ texture_groups: [tg], textures } as any);
        const setChannel = (val: string | undefined, channel: string) => {
          if (val === 'none') textures.filter((t: any) => t.pbr_channel === channel).forEach((t: any) => (t.group = ''));
          else if (val) { const tex = findTexture(val); if (tex) tex.extend({ group: tg.uuid, pbr_channel: channel }); }
        };
        setChannel(input.color_texture, 'color');
        setChannel(input.normal_texture, 'normal');
        setChannel(input.height_texture, 'height');
        setChannel(input.mer_texture, 'mer');
        if (tg.material_config) {
          if (input.color_value) tg.material_config.color_value = input.color_value;
          if (input.mer_value) tg.material_config.mer_value = input.mer_value;
          if (input.subsurface_value !== undefined) tg.material_config.subsurface_value = input.subsurface_value;
          tg.material_config.saved = false;
        }
        if (typeof tg.updateMaterial === 'function') tg.updateMaterial();
        Undo.finishEdit('Configure material via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, name: tg.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const listMaterials = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const all = (typeof TextureGroup !== 'undefined' && (TextureGroup as any).all) ? (TextureGroup as any).all : [];
        const materials = all.filter((g: any) => g.is_material).map((g: any) => {
          const textures = g.getTextures ? g.getTextures() : [];
          return {
            name: g.name, uuid: g.uuid,
            channels: { color: channelInfo(textures, 'color'), normal: channelInfo(textures, 'normal'), height: channelInfo(textures, 'height'), mer: channelInfo(textures, 'mer') },
            config: g.material_config ? { color_value: g.material_config.color_value, mer_value: g.material_config.mer_value, subsurface_value: g.material_config.subsurface_value, saved: g.material_config.saved } : null,
          };
        });
        return { ok: true, materials };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const getMaterialInfo = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tg = findTextureGroup(input.material);
        if (!tg) return { ok: false, error: `Material "${input.material}" not found.` };
        const textures = tg.getTextures ? tg.getTextures() : [];
        let textureSetJson = null;
        try { if (tg.material_config && tg.material_config.compileForBedrock) textureSetJson = tg.material_config.compileForBedrock(); } catch { /* format may not support it */ }
        return {
          ok: true,
          info: {
            name: tg.name, uuid: tg.uuid, is_material: tg.is_material,
            textures: textures.map((t: any) => ({ name: t.name, uuid: t.uuid, pbr_channel: t.pbr_channel, width: t.width, height: t.height })),
            config: tg.material_config ? { color_value: tg.material_config.color_value, mer_value: tg.material_config.mer_value, subsurface_value: tg.material_config.subsurface_value, saved: tg.material_config.saved, file_path: tg.material_config.getFilePath ? tg.material_config.getFilePath() : null } : null,
            texture_set_json: textureSetJson,
          },
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const importTextureSet = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        if (!input.path || !String(input.path).endsWith('.texture_set.json')) return { ok: false, error: "path must end with '.texture_set.json'." };
        const rnm = (globalThis as any).requireNativeModule;
        const fs = (typeof rnm === 'function') ? rnm('fs') : null;
        if (!fs || !fs.existsSync(input.path)) return { ok: false, error: `File not found or fs unavailable: ${input.path}` };
        const fn = (globalThis as any).importTextureSet;
        if (typeof fn !== 'function') return { ok: false, error: 'importTextureSet not available in this Blockbench version.' };
        fn({ path: input.path, name: input.path.split(/[\/\\]/).pop() });
        return { ok: true, path: input.path };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const assignTextureChannel = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tg = findTextureGroup(input.material);
        if (!tg) return { ok: false, error: `Material "${input.material}" not found.` };
        const tex = findTexture(input.texture);
        if (!tex) return { ok: false, error: `Texture "${input.texture}" not found.` };
        Undo.initEdit({ texture_groups: [tg], textures: [tex] } as any);
        const existing = tg.getTextures ? tg.getTextures() : [];
        existing.filter((t: any) => t.pbr_channel === input.channel && t.uuid !== tex.uuid).forEach((t: any) => (t.pbr_channel = 'color'));
        tex.extend({ group: tg.uuid, pbr_channel: input.channel });
        if (tg.material_config) tg.material_config.saved = false;
        if (typeof tg.updateMaterial === 'function') tg.updateMaterial();
        Undo.finishEdit('Assign texture channel via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, texture: tex.name, channel: input.channel, material: tg.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const saveMaterialConfig = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tg = findTextureGroup(input.material);
        if (!tg) return { ok: false, error: `Material "${input.material}" not found.` };
        if (!tg.material_config) return { ok: false, error: 'Material has no material_config.' };
        const filePath = tg.material_config.getFilePath ? tg.material_config.getFilePath() : null;
        if (!filePath) return { ok: false, error: 'Cannot save: material needs a color texture with a valid file path.' };
        tg.material_config.save();
        return { ok: true, file_path: filePath };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const getFaceMaterialInstances = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const cube = input.cube_id ? findCubeByNameOrUuid(input.cube_id) : ((Cube as any).selected || [])[0];
        if (!cube) return { ok: false, error: 'No cube found.' };
        const facesToCheck = (input.faces && input.faces.length) ? input.faces : FACE_KEYS;
        const result: any = {};
        for (const f of facesToCheck) {
          const face = cube.faces[f];
          if (face) result[f] = { material_name: face.material_name || '', texture: face.texture ? (face.getTexture?.()?.name || String(face.texture)) : null };
        }
        return { ok: true, cube: { name: cube.name, uuid: cube.uuid }, faces: result };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const setFaceMaterialInstance = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        let cubes: any[];
        if (input.cube_id) { const c = findCubeByNameOrUuid(input.cube_id); if (!c) return { ok: false, error: `Cube "${input.cube_id}" not found.` }; cubes = [c]; }
        else { cubes = (Cube as any).selected || []; if (!cubes.length) return { ok: false, error: 'No cube_id and nothing selected.' }; }
        if (input.material_name === undefined) return { ok: false, error: 'material_name is required (use "" to clear).' };
        const faces = (input.faces && input.faces.length) ? input.faces : FACE_KEYS;
        Undo.initEdit({ elements: cubes, uv_only: true } as any);
        let n = 0;
        for (const cube of cubes) for (const f of faces) { const face = cube.faces[f]; if (face) { face.extend({ material_name: input.material_name }); n++; } }
        Undo.finishEdit('Set material instances via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, material_name: input.material_name, faces: n, cubes: cubes.length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const listMaterialInstances = (): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const map: any = {};
        for (const cube of allCubes()) for (const f of FACE_KEYS) {
          const face = cube.faces[f];
          if (face && face.material_name) (map[face.material_name] ??= []).push({ cube_name: cube.name, cube_uuid: cube.uuid, face: f });
        }
        const instances = Object.entries(map).map(([name, usages]: any) => ({ name, usage_count: usages.length, usages }));
        return { ok: true, total_unique_instances: instances.length, material_instances: instances };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const bulkSetMaterialInstances = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const assignments = input.assignments || [];
        if (!assignments.length) return { ok: false, error: 'assignments are required.' };
        const cache: any = {};
        const cubesToEdit: any[] = [];
        for (const a of assignments) { if (!cache[a.cube_id]) { const c = findCubeByNameOrUuid(a.cube_id); if (!c) return { ok: false, error: `Cube "${a.cube_id}" not found.` }; cache[a.cube_id] = c; cubesToEdit.push(c); } }
        Undo.initEdit({ elements: cubesToEdit, uv_only: true } as any);
        let n = 0;
        for (const a of assignments) { const c = cache[a.cube_id]; for (const f of a.faces) { const face = c.faces[f]; if (face) { face.extend({ material_name: a.material_name }); n++; } } }
        Undo.finishEdit('Bulk set material instances via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, assignments: assignments.length, faces: n, cubes: cubesToEdit.length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const clearMaterialInstances = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        let cubes: any[];
        if (input.all_cubes) cubes = allCubes();
        else if (input.cube_id) { const c = findCubeByNameOrUuid(input.cube_id); if (!c) return { ok: false, error: `Cube "${input.cube_id}" not found.` }; cubes = [c]; }
        else { cubes = (Cube as any).selected || []; if (!cubes.length) return { ok: false, error: 'No cube_id, nothing selected, and all_cubes is false.' }; }
        if (!cubes.length) return { ok: true, cleared: 0, cubes: 0 };
        const faces = (input.faces && input.faces.length) ? input.faces : FACE_KEYS;
        Undo.initEdit({ elements: cubes, uv_only: true } as any);
        let n = 0;
        for (const cube of cubes) for (const f of faces) { const face = cube.faces[f]; if (face && face.material_name) { face.extend({ material_name: '' }); n++; } }
        Undo.finishEdit('Clear material instances via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, cleared: n, cubes: cubes.length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // Painting tools (ported from upstream paint.ts — core subset: fill,
    // draw_shape, gradient, color_picker). Enough to paint a texture atlas.
    // ---------------------------------------------------------------------
    const getAndActivateTexture = (id?: string): any => {
      if (!id) {
        const active = (Texture as any).selected ?? ((Texture as any).getDefault ? (Texture as any).getDefault() : null);
        if (!active) throw new Error('No texture available. Use create_texture first or pass texture_id.');
        if ((Texture as any).selected?.uuid !== active.uuid) active.select();
        return active;
      }
      const tex = findTexture(id);
      if (!tex) throw new Error(`Texture "${id}" not found.`);
      if ((Texture as any).selected?.uuid !== tex.uuid) tex.select();
      return tex;
    };
    const setBarItemValue = (id: string, value: any): void => {
      const item: any = (typeof BarItems !== 'undefined') ? (BarItems as any)[id] : null;
      if (!item) return;
      if (typeof item.set === 'function') { try { item.set(value); return; } catch { /* fall through */ } }
      if ('value' in item) item.value = value;
    };

    // Optional named-layer targeting (T2): when a paint tool gets `layer`, paint
    // into that named TextureLayer (non-destructive) instead of the flat texture —
    // enables separate base/shade/highlight/detail passes. After this selects the
    // layer, texture.edit() writes into THAT layer's canvas. Returns the layer, or
    // null (flat paint) when no layer is requested or the format lacks layers.
    const resolveTextureLayer = (texture: any, layerName?: string): any => {
      if (!layerName || typeof TextureLayer === 'undefined') return null;
      if (!texture.layers_enabled && typeof texture.activateLayers === 'function') texture.activateLayers(true);
      let layer = (texture.layers || []).find((l: any) => l.name === layerName);
      if (!layer) {
        layer = new (TextureLayer as any)({ name: layerName }, texture);
        if (typeof layer.setSize === 'function') layer.setSize(texture.width, texture.height);
        layer.addForEditing();
      } else if (typeof layer.select === 'function') {
        layer.select();
      }
      return layer;
    };

    // Pixel-art-safe painting: write DIRECTLY to the texture canvas (the same
    // approach as paint_pixel_matrix). The Painter UI API (Painter.useShapeTool
    // /useGradientTool + BarItems.<tool>.select) no-ops when driven headlessly
    // over the socket — it depends on paint-mode UI state and real mouse events,
    // so it returned ok:true but never modified the bitmap (LIVE 2026-06-15).
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = String(hex || '#000000').replace('#', '').trim();
      const s = (h.length === 3 ? h.split('').map((c) => c + c).join('') : h).slice(0, 6).padEnd(6, '0');
      const n = parseInt(s, 16) || 0;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };

    const paintFillTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        const sx = Math.round(input.x), sy = Math.round(input.y);
        const [fr, fg, fb] = hexToRgb(input.color);
        const fa = input.opacity !== undefined ? Math.max(0, Math.min(255, Math.round(input.opacity))) : 255;
        const tol = ((input.tolerance ?? 0) / 100) * 255;
        const connected = input.fill_mode !== 'color'; // 'color' = replace all matching pixels; else flood from the point
        let painted = 0;
        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          const W = canvas.width, H = canvas.height;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
          const img = ctx.getImageData(0, 0, W, H);
          const d = img.data;
          const t0 = (sy * W + sx) * 4;
          const tr = d[t0], tg = d[t0 + 1], tb = d[t0 + 2], ta = d[t0 + 3];
          const match = (i: number) =>
            Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol &&
            Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;
          const put = (i: number) => { d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = fa; painted++; };
          if (connected) {
            const seen = new Uint8Array(W * H);
            const stack = [sy * W + sx];
            while (stack.length) {
              const p = stack.pop() as number;
              if (p < 0 || p >= W * H || seen[p] || !match(p * 4)) continue;
              seen[p] = 1; put(p * 4);
              const px = p % W, py = (p / W) | 0;
              if (px + 1 < W) stack.push(p + 1);
              if (px - 1 >= 0) stack.push(p - 1);
              if (py + 1 < H) stack.push(p + W);
              if (py - 1 >= 0) stack.push(p - W);
            }
          } else {
            for (let p = 0; p < W * H; p++) if (match(p * 4)) put(p * 4);
          }
          ctx.putImageData(img, 0, 0);
        }, { edit_name: 'Fill tool' });
        Undo.finishEdit('Fill tool via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`fill (${sx},${sy}) on "${texture.name}" — ${painted}px`);
        return { ok: true, x: sx, y: sy, painted, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const drawShapeTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        const shape = String(input.shape || 'rectangle');
        const hollow = shape.endsWith('_h');
        const isEllipse = shape.startsWith('ellipse');
        const lw = Math.max(1, Math.round(input.line_width ?? 1));
        const x0 = Math.round(Math.min(input.start.x, input.end.x));
        const y0 = Math.round(Math.min(input.start.y, input.end.y));
        const x1 = Math.round(Math.max(input.start.x, input.end.x));
        const y1 = Math.round(Math.max(input.start.y, input.end.y));
        let painted = 0;
        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          ctx.save();
          ctx.globalAlpha = input.opacity !== undefined ? Math.max(0, Math.min(255, input.opacity)) / 255 : 1;
          ctx.fillStyle = input.color || '#000000';
          const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
          const rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
          const irx = rx - lw, iry = ry - lw;
          // Per-pixel fillRect keeps shapes crisp (no canvas anti-aliasing).
          for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
              let on: boolean;
              if (isEllipse) {
                const ex = (px + 0.5 - cx) / rx, ey = (py + 0.5 - cy) / ry;
                on = ex * ex + ey * ey <= 1;
                if (on && hollow && irx > 0 && iry > 0) {
                  const ix = (px + 0.5 - cx) / irx, iy = (py + 0.5 - cy) / iry;
                  if (ix * ix + iy * iy <= 1) on = false;
                }
              } else if (hollow) {
                on = (px - x0) < lw || (x1 - px) < lw || (py - y0) < lw || (y1 - py) < lw;
              } else {
                on = true;
              }
              if (on) { ctx.fillRect(px, py, 1, 1); painted++; }
            }
          }
          ctx.restore();
        }, { edit_name: 'Draw shape' });
        Undo.finishEdit('Draw shape via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`drew ${shape} on "${texture.name}" — ${painted}px`);
        return { ok: true, shape, painted, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const gradientTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          ctx.save();
          ctx.globalAlpha = input.opacity !== undefined ? Math.max(0, Math.min(255, input.opacity)) / 255 : 1;
          const g = ctx.createLinearGradient(input.start.x, input.start.y, input.end.x, input.end.y);
          g.addColorStop(0, input.start_color);
          g.addColorStop(1, input.end_color);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }, { edit_name: 'Gradient' });
        Undo.finishEdit('Gradient via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`gradient on "${texture.name}"`);
        return { ok: true, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const colorPickerTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        (Painter as any).colorPicker(texture, input.x, input.y, { button: input.set_as_secondary ? 2 : 0 });
        const color = (ColorPanel as any).get();
        return { ok: true, color, x: input.x, y: input.y, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // Mesh tools (ported from upstream mesh.ts). Freeform geometry: spheres,
    // cylinders, vertices/faces, extrude/subdivide/merge/knife.
    // ---------------------------------------------------------------------
    const resolveOutlinerGroup = (group?: string): any =>
      (!group || group === 'root') ? 'root' : (findGroupByNameOrUuid(group) ?? 'root');
    const meshOrSelected = (id?: string): any => {
      const m = id ? findMesh(id) : (((Mesh as any).selected || [])[0] || allMeshes().find((x: any) => x.selected));
      if (!m) throw new Error(id ? `Mesh "${id}" not found.` : 'No mesh selected.');
      return m;
    };

    const placeMesh = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tex = input.texture ? findTexture(input.texture) : ((Texture as any).getDefault?.());
        const outlinerGroup = resolveOutlinerGroup(input.group);
        Undo.initEdit({ elements: [], outliner: true } as any);
        const meshes = (input.elements || []).map((el: any) => {
          const mesh = new Mesh({ name: el.name, vertices: {}, origin: el.position, rotation: el.rotation || [0, 0, 0] } as any).init();
          (el.vertices || []).forEach((v: any) => mesh.addVertices(v));
          mesh.addTo(outlinerGroup);
          if (tex) mesh.applyTexture(tex);
          return mesh;
        });
        Undo.finishEdit('Place meshes via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, meshes: meshes.map((m: any) => ({ name: m.name, uuid: m.uuid })) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const createSphere = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tex = input.texture ? findTexture(input.texture) : ((Texture as any).getDefault?.());
        const outlinerGroup = resolveOutlinerGroup(input.group);
        Undo.initEdit({ elements: [], outliner: true } as any);
        const made = (input.elements || []).map((element: any) => {
          const mesh = new Mesh({ name: element.name, vertices: {}, origin: element.position, rotation: element.rotation || [0, 0, 0] } as any).init();
          const radius = (element.diameter ?? 16) / 2;
          const elSides = element.sides ?? 12;
          const sides = Math.round(elSides / 2) * 2;
          const [bottom] = mesh.addVertices([0, -radius, 0]);
          const [top] = mesh.addVertices([0, radius, 0]);
          const rings: string[][] = [];
          const off = element.align_edges === false ? 0 : 0.5;
          for (let i = 0; i < elSides; i++) {
            const cx = Math.sin(((i + off) / elSides) * Math.PI * 2);
            const cz = Math.cos(((i + off) / elSides) * Math.PI * 2);
            const verts: string[] = [];
            for (let j = 1; j < sides / 2; j++) {
              const sx = Math.sin((j / sides) * Math.PI * 2) * radius;
              verts.push(...mesh.addVertices([cx * sx, Math.cos((j / sides) * Math.PI * 2) * radius, cz * sx]));
            }
            rings.push(verts);
          }
          for (let i = 0; i < elSides; i++) {
            const tr = rings[i];
            const nr = rings[i + 1] || rings[0];
            for (let j = 0; j < sides / 2; j++) {
              if (j === 0) { mesh.addFaces(new MeshFace(mesh, { vertices: [tr[j], nr[j], top], uv: {} } as any)); continue; }
              if (!tr[j]) { mesh.addFaces(new MeshFace(mesh, { vertices: [nr[j - 1], tr[j - 1], bottom], uv: {} } as any)); continue; }
              mesh.addFaces(new MeshFace(mesh, { vertices: [tr[j], nr[j], tr[j - 1], nr[j - 1]], uv: {} } as any));
            }
          }
          mesh.addTo(outlinerGroup);
          if (tex) mesh.applyTexture(tex);
          return mesh;
        });
        Undo.finishEdit('Create spheres via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, meshes: made.map((m: any) => ({ name: m.name, uuid: m.uuid })) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const createCylinder = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const tex = input.texture ? findTexture(input.texture) : ((Texture as any).getDefault?.());
        const outlinerGroup = resolveOutlinerGroup(input.group);
        Undo.initEdit({ elements: [], outliner: true } as any);
        const made = (input.elements || []).map((element: any) => {
          const mesh = new Mesh({ name: element.name, vertices: {}, origin: element.position, rotation: element.rotation || [0, 0, 0] } as any).init();
          const radius = (element.diameter ?? 16) / 2;
          const height = element.height ?? 16;
          const sides = Math.round(element.sides ?? 12);
          const topCenter = mesh.addVertices([0, height / 2, 0])[0];
          const bottomCenter = mesh.addVertices([0, -height / 2, 0])[0];
          const topRing: any[] = [], bottomRing: any[] = [];
          for (let i = 0; i < sides; i++) {
            const ang = (i / sides) * Math.PI * 2;
            const x = Math.cos(ang) * radius, z = Math.sin(ang) * radius;
            topRing.push(mesh.addVertices([x, height / 2, z])[0]);
            bottomRing.push(mesh.addVertices([x, -height / 2, z])[0]);
          }
          for (let i = 0; i < sides; i++) {
            const next = (i + 1) % sides;
            mesh.addFaces(new MeshFace(mesh, { vertices: [bottomRing[i], bottomRing[next], topRing[next], topRing[i]], uv: {} } as any));
            if (element.capped !== false) {
              mesh.addFaces(new MeshFace(mesh, { vertices: [topRing[i], topRing[next], topCenter], uv: {} } as any));
              mesh.addFaces(new MeshFace(mesh, { vertices: [bottomRing[next], bottomRing[i], bottomCenter], uv: {} } as any));
            }
          }
          mesh.addTo(outlinerGroup);
          if (tex) mesh.applyTexture(tex);
          return mesh;
        });
        Undo.finishEdit('Create cylinders via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, meshes: made.map((m: any) => ({ name: m.name, uuid: m.uuid })) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const extrudeMesh = (input: any): any => {
      try {
        const mesh = meshOrSelected(input.mesh_id);
        const tool = (BarItems as any).extrude_mesh_selection;
        if (!tool) return { ok: false, error: 'Extrude tool not available.' };
        tool.click({}, input.distance ?? 1);
        return { ok: true, mesh: mesh.name, mode: input.mode || 'faces', distance: input.distance ?? 1 };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const subdivideMesh = (input: any): any => {
      try {
        const mesh = meshOrSelected(input.mesh_id);
        const tool = (BarItems as any).loop_cut;
        if (!tool) return { ok: false, error: 'Loop cut tool not available.' };
        tool.click({}, undefined, undefined, input.cuts ?? 1);
        return { ok: true, mesh: mesh.name, cuts: input.cuts ?? 1 };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const deleteMeshElements = (input: any): any => {
      try {
        const mesh = meshOrSelected(input.mesh_id);
        const tool = (BarItems as any).delete_mesh_selection;
        if (!tool) return { ok: false, error: 'Delete mesh selection tool not available.' };
        tool.click({}, input.keep_vertices ?? false);
        return { ok: true, mesh: mesh.name, mode: input.mode || 'faces' };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const moveMeshVertices = (input: any): any => {
      try {
        const mesh = meshOrSelected(input.mesh_id);
        if (!isVec3(input.offset)) return { ok: false, error: "'offset' must be 3 numbers." };
        Undo.initEdit({ elements: [mesh], element_aspects: { geometry: true, uv: true, faces: true } } as any);
        const verts = input.vertices || mesh.getSelectedVertices();
        verts.forEach((vk: string) => {
          if (mesh.vertices[vk]) { mesh.vertices[vk][0] += input.offset[0]; mesh.vertices[vk][1] += input.offset[1]; mesh.vertices[vk][2] += input.offset[2]; }
        });
        mesh.preview_controller.updateGeometry(mesh);
        Undo.finishEdit('Move mesh vertices via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, mesh: mesh.name, moved: verts.length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const mergeMeshVertices = (input: any): any => {
      try {
        const mesh = findMesh(input.mesh_id);
        if (!mesh) return { ok: false, error: `Mesh "${input.mesh_id}" not found.` };
        const threshold = input.threshold ?? 0.1;
        Undo.initEdit({ elements: [mesh], element_aspects: { geometry: true, uv: true, faces: true } } as any);
        const toCheck = (input.selected_only !== false) ? mesh.getSelectedVertices() : Object.keys(mesh.vertices);
        let merged = 0;
        const map: Record<string, string> = {};
        for (let i = 0; i < toCheck.length; i++) {
          const a = toCheck[i]; if (map[a]) continue;
          for (let j = i + 1; j < toCheck.length; j++) {
            const b = toCheck[j]; if (map[b]) continue;
            const v1 = mesh.vertices[a], v2 = mesh.vertices[b];
            const d = Math.sqrt((v1[0] - v2[0]) ** 2 + (v1[1] - v2[1]) ** 2 + (v1[2] - v2[2]) ** 2);
            if (d <= threshold) { map[b] = a; merged++; }
          }
        }
        Object.entries(map).forEach(([oldK, newK]) => {
          for (const fk in mesh.faces) {
            const face = mesh.faces[fk];
            const idx = face.vertices.indexOf(oldK);
            if (idx !== -1) { face.vertices[idx] = newK; face.uv[newK] = face.uv[oldK] || [0, 0]; delete face.uv[oldK]; }
          }
          delete mesh.vertices[oldK];
        });
        mesh.preview_controller.updateGeometry(mesh);
        Undo.finishEdit('Merge mesh vertices via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, mesh: mesh.name, merged };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const createMeshFace = (input: any): any => {
      try {
        const mesh = meshOrSelected(input.mesh_id);
        if (!input.vertices || input.vertices.length < 3) return { ok: false, error: 'Provide 3 or 4 vertex keys.' };
        const tex = input.texture ? findTexture(input.texture) : null;
        Undo.initEdit({ elements: [mesh], element_aspects: { geometry: true, uv: true, faces: true } } as any);
        const face = new MeshFace(mesh, { vertices: input.vertices, texture: tex ? tex.uuid : undefined } as any);
        const [faceKey] = mesh.addFaces(face);
        if (typeof UVEditor !== 'undefined') (UVEditor as any).setAutoSize(null, true, [faceKey]);
        mesh.preview_controller.updateGeometry(mesh);
        mesh.preview_controller.updateUV(mesh);
        Undo.finishEdit('Create mesh face via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, mesh: mesh.name, face: faceKey };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const selectMeshElements = (input: any): any => {
      try {
        const mesh = findMesh(input.mesh_id);
        if (!mesh) return { ok: false, error: `Mesh "${input.mesh_id}" not found.` };
        Undo.initEdit({ elements: [mesh], selection: true } as any);
        if ((BarItems as any).selection_mode?.set) (BarItems as any).selection_mode.set(input.mode);
        const sel = ((Project as any)?.mesh_selection?.[mesh.uuid]) ?? { vertices: [], edges: [], faces: [] };
        const action = input.action || 'select';
        if (action === 'select') { sel.vertices = []; sel.edges.length = 0; sel.faces = []; }
        const els = input.elements;
        if (!els || !els.length) {
          if (input.mode === 'vertex') sel.vertices = Object.keys(mesh.vertices);
          else if (input.mode === 'face') sel.faces = Object.keys(mesh.faces);
        } else {
          els.forEach((e: any) => {
            const k = String(e);
            const arr = input.mode === 'vertex' ? sel.vertices : input.mode === 'face' ? sel.faces : null;
            if (!arr) return;
            if (action === 'add' || action === 'select') { if (!arr.includes(k)) arr.push(k); }
            else if (action === 'remove') { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); }
            else if (action === 'toggle') { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); else arr.push(k); }
          });
        }
        if ((Project as any).mesh_selection) (Project as any).mesh_selection[mesh.uuid] = sel;
        mesh.select();
        Undo.finishEdit('Select mesh elements via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, mesh: mesh.name, mode: input.mode, selected: { vertices: sel.vertices.length, edges: sel.edges.length, faces: sel.faces.length } };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const knifeTool = (input: any): any => {
      try {
        const mesh = findMesh(input.mesh_id);
        if (!mesh) return { ok: false, error: `Mesh "${input.mesh_id}" not found.` };
        if (typeof (globalThis as any).KnifeToolContext === 'undefined') return { ok: false, error: 'KnifeToolContext not available in this Blockbench version.' };
        Undo.initEdit({ elements: [mesh], element_aspects: { geometry: true, uv: true, faces: true } } as any);
        const ctx = new (globalThis as any).KnifeToolContext(mesh);
        (input.points || []).forEach((p: any) => {
          ctx.points.push({ position: new (globalThis as any).THREE.Vector3(...p.position), fkey: p.face, type: p.face ? 'face' : 'edge' });
        });
        ctx.apply();
        Undo.finishEdit('Knife cut via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, mesh: mesh.name, points: (input.points || []).length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // UI + import tools (ported from upstream ui.ts + import.ts). Power tools:
    // trigger any Blockbench action, fill dialogs, eval (escape hatch), import geo.
    // ---------------------------------------------------------------------
    // Discovery companion for trigger_action: without it, trigger_action is a blind
    // string interface (no way to know valid BarItems ids). Returns the action list,
    // filterable by a search substring, with a `triggerable` flag per entry.
    const listActions = (input: any): any => {
      try {
        if (typeof BarItems === 'undefined' || !BarItems) return { ok: false, error: 'BarItems not available in this Blockbench build.' };
        const q = (typeof input?.search === 'string' ? input.search : '').toLowerCase();
        const limit = (typeof input?.limit === 'number' && input.limit > 0) ? Math.floor(input.limit) : 200;
        const all = Object.keys(BarItems as any).map((id) => {
          const a: any = (BarItems as any)[id];
          const kb = (a?.keybind && typeof a.keybind.label === 'string' && a.keybind.label) ? a.keybind.label : undefined;
          return {
            id,
            name: a?.name ?? undefined,
            description: a?.description ?? undefined,
            type: a?.constructor?.name ?? undefined,
            category: a?.category ?? undefined,
            keybind: kb,
            triggerable: !!(a && (typeof a.trigger === 'function' || typeof a.click === 'function')),
          };
        });
        const matched = q
          ? all.filter((a) => a.id.toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
          : all;
        const total = matched.length;
        const actions = matched.slice(0, limit);
        return { ok: true, count: total, truncated: total > actions.length, actions };
      } catch (e: any) {
        console.error('[MCP Plugin] listActions failed:', e);
        return { ok: false, error: e?.message || String(e) };
      }
    };

    const triggerAction = async (input: any): Promise<any> => {
      try {
        if (typeof BarItems === 'undefined' || !(input.action in (BarItems as any))) {
          return { ok: false, error: `Action "${input.action}" not found. Use list_actions (optionally with a search) to discover valid action ids.` };
        }
        let parsedArgs: any = {};
        if (input.confirmEvent) { try { parsedArgs = JSON.parse(input.confirmEvent); } catch { return { ok: false, error: 'Invalid JSON in confirmEvent.' }; } }
        Undo.initEdit({ elements: [], outliner: true } as any);
        const barItem: any = (BarItems as any)[input.action];
        const { event, ...rest } = parsedArgs;
        if (barItem && typeof Action !== 'undefined' && barItem instanceof Action) {
          barItem.trigger(new Event(event || 'click', { ...rest }));
        } else if (barItem && typeof barItem.trigger === 'function') {
          barItem.trigger(new Event(event || 'click'));
        } else if (barItem && typeof barItem.click === 'function') {
          barItem.click();
        }
        if (input.confirmDialog !== false && typeof Dialog !== 'undefined' && (Dialog as any).open) (Dialog as any).open.confirm?.();
        Undo.finishEdit('Trigger action via MCP');
        const shot = await captureAppScreenshot();
        return shot.ok ? { ok: true, action: input.action, data_url: shot.data_url } : { ok: true, action: input.action, message: `Action "${input.action}" executed.` };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const riskyEval = async (input: any): Promise<any> => {
      try {
        if (!input.code) return { ok: false, error: 'code is required.' };
        Undo.initEdit({ elements: [], outliner: true } as any);
        let result: any;
        try {
          // eslint-disable-next-line no-eval
          result = await eval(String(input.code).trim());
        } finally {
          Undo.finishEdit('Eval via MCP');
        }
        return { ok: true, result: result !== undefined ? (typeof result === 'string' ? result : JSON.stringify(result)) : '(Code executed; no result returned.)' };
      } catch (e: any) { return { ok: false, error: 'Error executing code: ' + (e?.message || String(e)) }; }
    };

    const emulateClicks = async (input: any): Promise<any> => {
      try {
        const { x, y, button } = input.position || {};
        const btn = button === 'right' ? 2 : 0;
        document.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, button: btn }));
        if (input.drag) {
          const to = input.drag.to;
          const dur = input.drag.duration ?? 100;
          document.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: btn }));
          await new Promise((r) => setTimeout(r, dur));
          document.dispatchEvent(new MouseEvent('mouseup', { clientX: to.x, clientY: to.y, button: btn }));
        }
        const shot = await captureAppScreenshot();
        return shot.ok ? { ok: true, data_url: shot.data_url } : { ok: true, message: 'Clicks emulated.' };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const fillDialog = (input: any): any => {
      try {
        if (typeof Dialog === 'undefined' || !(Dialog as any).stack?.length) return { ok: false, error: 'No open dialog.' };
        if (!(Dialog as any).open) (Dialog as any).stack[(Dialog as any).stack.length - 1]?.focus?.();
        let parsed: any;
        try { parsed = JSON.parse(input.values); } catch (e: any) { return { ok: false, error: 'Invalid JSON in values.' }; }
        const keys = Object.keys((Dialog as any).open?.getFormResult?.() ?? {});
        const toFill: any = {};
        for (const [k, v] of Object.entries(parsed)) if (keys.includes(k)) toFill[k] = v;
        (Dialog as any).open?.setFormValues?.(toFill, true);
        if (input.confirm !== false) (Dialog as any).open?.confirm?.(); else (Dialog as any).open?.cancel?.();
        return { ok: true, stack_depth: (Dialog as any).stack.length };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const fromGeoJson = async (input: any): Promise<any> => {
      try {
        let geojson = String(input.geojson || '');
        if (!geojson.startsWith('{') && !geojson.startsWith('[')) {
          let url: URL;
          try { url = new URL(geojson); } catch { return { ok: false, error: `Invalid URL or inline GeoJSON: "${geojson}".` }; }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `Unsupported protocol "${url.protocol}".` };
          const res = await fetch(url.href);
          if (!res.ok) return { ok: false, error: `Failed to fetch: ${res.status} ${res.statusText}` };
          geojson = await res.text();
        }
        if (typeof Codecs === 'undefined' || !(Codecs as any).bedrock?.parse) return { ok: false, error: 'Bedrock codec parse not available.' };
        (Codecs as any).bedrock.parse(JSON.parse(geojson), '');
        await new Promise((r) => setTimeout(r, 1500));
        const shot = await captureAppScreenshot();
        return shot.ok ? { ok: true, data_url: shot.data_url } : { ok: true, message: 'Imported GeoJSON.' };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // Armature tools (ported from upstream armature.ts). Newer Blockbench
    // feature (skeletal rig + vertex weights); guarded for formats/versions
    // that lack Armature/ArmatureBone.
    // ---------------------------------------------------------------------
    const armSupported = (): boolean => typeof Armature !== 'undefined' && typeof ArmatureBone !== 'undefined';
    const findArmature = (id: string): any => armSupported() ? (Armature as any).all.find((a: any) => a.uuid === id || a.name === id || a.uuid.startsWith(id)) : undefined;
    const findArmBone = (id: string): any => armSupported() ? (ArmatureBone as any).all.find((b: any) => b.uuid === id || b.name === id || b.uuid.startsWith(id)) : undefined;
    const serArmature = (a: any) => ({ uuid: a.uuid, name: a.name, type: a.type, visibility: a.visibility, locked: a.locked, export: a.export, origin: a.origin, childCount: (a.children || []).length, boneCount: (a.getAllBones?.() || []).length });
    const serBone = (b: any) => {
      const a = b.getArmature?.();
      return { uuid: b.uuid, name: b.name, armature: a ? { uuid: a.uuid, name: a.name } : null, origin: b.origin, rotation: b.rotation, length: b.length, width: b.width, connected: b.connected, color: b.color, visibility: b.visibility, locked: b.locked, parentBone: (typeof ArmatureBone !== 'undefined' && b.parent instanceof ArmatureBone) ? { uuid: b.parent.uuid, name: b.parent.name } : null, childCount: (b.children || []).length, vertexWeightCount: Object.keys(b.vertex_weights || {}).length };
    };
    const armMeshOr = (id?: string): any => id ? findMesh(id) : ((Mesh as any).selected || [])[0];
    const guardArm = () => armSupported() ? null : { ok: false, error: 'Armatures are not available in this Blockbench version/format.' };

    const listArmatures = (): any => { const g = guardArm(); if (g) return g; return { ok: true, data: { count: (Armature as any).all.length, armatures: (Armature as any).all.map(serArmature) } }; };
    const getArmature = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const a = findArmature(input.id); if (!a) return { ok: false, error: `Armature "${input.id}" not found.` };
      const data: any = serArmature(a);
      if (input.include_bones !== false) data.bones = (a.getAllBones?.() || []).map(serBone);
      return { ok: true, data };
    };
    const addArmature = (input: any): any => {
      const g = guardArm(); if (g) return g;
      if (!(Format as any)?.armature_rig) return { ok: false, error: 'Current format does not support armatures (no armature_rig).' };
      try {
        Undo.initEdit({ outliner: true, elements: [] } as any);
        const a = new (Armature as any)({ name: input.name || 'armature', visibility: input.visibility !== false, locked: !!input.locked });
        a.addTo((Outliner as any).root); a.isOpen = true; a.createUniqueName?.(); a.init();
        if (input.add_initial_bone !== false) { const b = new (ArmatureBone as any)({ name: 'bone' }); b.addTo(a); b.init(); }
        Undo.finishEdit('Add armature via MCP');
        if (Canvas.updateAll) Canvas.updateAll();
        return { ok: true, message: `Created armature "${a.name}"`, armature: serArmature(a) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };
    const removeArmature = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const a = findArmature(input.id); if (!a) return { ok: false, error: `Armature "${input.id}" not found.` };
      Undo.initEdit({ outliner: true, elements: [] } as any); const n = a.name; a.remove(); Undo.finishEdit('Remove armature via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Removed armature "${n}"` };
    };
    const updateArmature = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const a = findArmature(input.id); if (!a) return { ok: false, error: `Armature "${input.id}" not found.` };
      Undo.initEdit({ outliner: true, elements: [a] } as any);
      if (input.name !== undefined) a.name = input.name;
      if (input.visibility !== undefined) a.visibility = input.visibility;
      if (input.locked !== undefined) a.locked = input.locked;
      if (input.export !== undefined) a.export = input.export;
      a.updateElement?.(); Undo.finishEdit('Update armature via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Updated armature "${a.name}"`, armature: serArmature(a) };
    };
    const listArmatureBones = (input: any): any => {
      const g = guardArm(); if (g) return g;
      let bones: any[];
      if (input.armature_id) { const a = findArmature(input.armature_id); if (!a) return { ok: false, error: `Armature "${input.armature_id}" not found.` }; bones = a.getAllBones?.() || []; }
      else bones = (ArmatureBone as any).all;
      return { ok: true, data: { count: bones.length, bones: bones.map(serBone) } };
    };
    const getArmatureBone = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.id); if (!b) return { ok: false, error: `Bone "${input.id}" not found.` };
      const data: any = serBone(b);
      if (input.include_weights) data.vertex_weights = b.vertex_weights;
      return { ok: true, data };
    };
    const addArmatureBone = (input: any): any => {
      const g = guardArm(); if (g) return g;
      let parent: any = findArmature(input.parent_id) || findArmBone(input.parent_id);
      if (!parent) return { ok: false, error: `Parent "${input.parent_id}" not found (armature or bone).` };
      try {
        const defOrigin = (typeof ArmatureBone !== 'undefined' && parent instanceof ArmatureBone) ? [0, parent.length ?? 8, 0] : [0, 0, 0];
        Undo.initEdit({ outliner: true, elements: [] } as any);
        const b = new (ArmatureBone as any)({ name: input.name || 'bone', origin: input.origin ?? defOrigin, rotation: input.rotation ?? [0, 0, 0], length: input.length ?? 8, width: input.width ?? 2, connected: input.connected !== false, color: input.color });
        b.addTo(parent); b.isOpen = true;
        if ((Format as any)?.bone_rig) b.createUniqueName?.();
        b.init();
        Undo.finishEdit('Add armature bone via MCP'); if (Canvas.updateAll) Canvas.updateAll();
        return { ok: true, message: `Created bone "${b.name}"`, bone: serBone(b) };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };
    const removeArmatureBone = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.id); if (!b) return { ok: false, error: `Bone "${input.id}" not found.` };
      const n = b.name;
      Undo.initEdit({ outliner: true, elements: [] } as any);
      if (input.remove_children === false && (b.children || []).length) { for (const c of [...b.children]) c.addTo(b.parent); }
      b.remove(); Undo.finishEdit('Remove armature bone via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Removed bone "${n}"` };
    };
    const updateArmatureBone = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.id); if (!b) return { ok: false, error: `Bone "${input.id}" not found.` };
      Undo.initEdit({ outliner: true, elements: [b] } as any);
      if (input.name !== undefined) b.name = input.name;
      if (input.origin !== undefined) b.origin.V3_set ? b.origin.V3_set(input.origin) : (b.origin = input.origin);
      if (input.rotation !== undefined) b.rotation.V3_set ? b.rotation.V3_set(input.rotation) : (b.rotation = input.rotation);
      if (input.length !== undefined) b.length = input.length;
      if (input.width !== undefined) b.width = input.width;
      if (input.connected !== undefined) b.connected = input.connected;
      if (input.color !== undefined) b.setColor?.(input.color);
      if (input.visibility !== undefined) b.visibility = input.visibility;
      if (input.locked !== undefined) b.locked = input.locked;
      b.preview_controller?.updateTransform?.(b); b.updateElement?.();
      Undo.finishEdit('Update armature bone via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Updated bone "${b.name}"`, bone: serBone(b) };
    };
    const updateArmatureBonesBatch = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const bones = (input.ids || []).map((id: string) => findArmBone(id)).filter(Boolean);
      Undo.initEdit({ outliner: true, elements: bones } as any);
      for (const b of bones) {
        if (input.visibility !== undefined) b.visibility = input.visibility;
        if (input.locked !== undefined) b.locked = input.locked;
        if (input.color !== undefined) b.setColor?.(input.color);
        b.updateElement?.();
      }
      Undo.finishEdit('Update armature bones (batch) via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Updated ${bones.length} bone(s)`, bones: bones.map(serBone) };
    };
    const selectArmatureBones = (input: any): any => {
      const g = guardArm(); if (g) return g;
      if (input.clear_selection !== false && typeof unselectAllElements === 'function') (unselectAllElements as any)();
      let bones: any[] = [];
      if (input.armature_id) { const a = findArmature(input.armature_id); if (!a) return { ok: false, error: `Armature "${input.armature_id}" not found.` }; bones = a.getAllBones?.() || []; }
      else if (input.ids?.length) {
        for (const id of input.ids) { const b = findArmBone(id); if (b) { bones.push(b); if (input.include_descendants) b.forEachChild?.((c: any) => { if (c instanceof ArmatureBone) bones.push(c); }); } }
      }
      for (const b of bones) b.select?.();
      if (typeof updateSelection === 'function') (updateSelection as any)();
      return { ok: true, message: `Selected ${bones.length} bone(s)`, bones: bones.map((b: any) => ({ uuid: b.uuid, name: b.name })) };
    };
    const getVertexWeights = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const mesh = armMeshOr(input.mesh_id); if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
      const armature = mesh.getArmature?.(); if (!armature) return { ok: false, error: `Mesh "${mesh.name}" has no armature.` };
      const bones = input.bone_id ? [findArmBone(input.bone_id)].filter(Boolean) : (armature.getAllBones?.() || []);
      const weights: any = {};
      for (const b of bones) { const bw: any = {}; for (const vk in mesh.vertices) { const w = b.getVertexWeight?.(mesh, vk) || 0; if (w > 0) bw[vk] = w; } if (Object.keys(bw).length) weights[b.name] = bw; }
      return { ok: true, data: { mesh: { uuid: mesh.uuid, name: mesh.name }, armature: { uuid: armature.uuid, name: armature.name }, weights } };
    };
    const setVertexWeight = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.bone_id); if (!b) return { ok: false, error: `Bone "${input.bone_id}" not found.` };
      const mesh = armMeshOr(input.mesh_id); if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
      if (!(input.vertex_key in mesh.vertices)) return { ok: false, error: `Vertex "${input.vertex_key}" not found.` };
      Undo.initEdit({ elements: [b] } as any); b.setVertexWeight?.(mesh, input.vertex_key, input.weight); Undo.finishEdit('Set vertex weight via MCP');
      if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Set weight ${input.weight} on "${b.name}" vertex ${input.vertex_key}` };
    };
    const setVertexWeightsBatch = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.bone_id); if (!b) return { ok: false, error: `Bone "${input.bone_id}" not found.` };
      const mesh = armMeshOr(input.mesh_id); if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
      Undo.initEdit({ elements: [b] } as any);
      let count = 0;
      for (const [vk, w] of Object.entries(input.weights || {})) { if (vk in mesh.vertices) { b.setVertexWeight?.(mesh, vk, w); count++; } }
      Undo.finishEdit('Set vertex weights (batch) via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Set ${count} vertex weights on "${b.name}"` };
    };
    const clearVertexWeights = (input: any): any => {
      const g = guardArm(); if (g) return g;
      const b = findArmBone(input.bone_id); if (!b) return { ok: false, error: `Bone "${input.bone_id}" not found.` };
      const mesh = armMeshOr(input.mesh_id); if (!mesh) return { ok: false, error: 'No mesh found/selected.' };
      Undo.initEdit({ elements: [b] } as any);
      let count = 0; const prefix = mesh.uuid.substring(0, 6) + ':';
      for (const k in (b.vertex_weights || {})) { if (k.startsWith(prefix)) { delete b.vertex_weights[k]; count++; } }
      Undo.finishEdit('Clear vertex weights via MCP'); if (Canvas.updateAll) Canvas.updateAll();
      return { ok: true, message: `Cleared ${count} vertex weights from "${b.name}"` };
    };

    // ---------------------------------------------------------------------
    // Remaining paint tools (ported from upstream paint.ts).
    // ---------------------------------------------------------------------
    const copyBrushTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        Undo.initEdit({ textures: [texture], bitmap: true } as any);
        if (input.brush_size !== undefined) setBarItemValue('slider_brush_size', input.brush_size);
        if (input.opacity !== undefined) setBarItemValue('slider_brush_opacity', input.opacity);
        if (input.mode) setBarItemValue('copy_brush_mode', input.mode);
        (BarItems as any).copy_brush.select();
        (Painter as any).startPaintTool(texture, input.source.x, input.source.y, {}, { ctrlOrCmd: true });
        (Painter as any).startPaintTool(texture, input.target.x, input.target.y, {}, { shiftKey: false });
        (Painter as any).stopPaintTool();
        Undo.finishEdit('Copy brush via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const eraserTool = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        const coords = input.coordinates || [];
        if (!coords.length) return { ok: false, error: 'coordinates are required.' };
        Undo.initEdit({ textures: [texture], bitmap: true } as any);
        if (input.brush_size !== undefined) setBarItemValue('slider_brush_size', input.brush_size);
        if (input.opacity !== undefined) setBarItemValue('slider_brush_opacity', input.opacity);
        if (input.softness !== undefined) setBarItemValue('slider_brush_softness', input.softness);
        if (input.shape !== undefined) setBarItemValue('brush_shape', input.shape);
        (BarItems as any).eraser.select();
        for (let i = 0; i < coords.length; i++) {
          if (i === 0 || input.connect_strokes === false) (Painter as any).startPaintTool(texture, coords[i].x, coords[i].y, {}, { shiftKey: false });
          else (Painter as any).movePaintTool(texture, coords[i].x, coords[i].y, {});
        }
        (Painter as any).stopPaintTool();
        Undo.finishEdit('Erase via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, erased: coords.length, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const paintSettings = (input: any): any => {
      try {
        const applied: string[] = [];
        const bbSettings: any = (globalThis as any).settings;
        if (input.mirror_painting !== undefined) {
          setBarItemValue('mirror_painting', input.mirror_painting.enabled);
          (Painter as any).mirror_painting = input.mirror_painting.enabled;
          applied.push('mirror_painting');
          const opts = (Painter as any).mirror_painting_options;
          if (input.mirror_painting.enabled && opts) {
            (input.mirror_painting.axis || []).forEach((ax: string) => { opts[ax] = true; });
            if (input.mirror_painting.texture !== undefined) opts.texture = input.mirror_painting.texture;
            if (input.mirror_painting.texture_center) opts.texture_center = [input.mirror_painting.texture_center.x, input.mirror_painting.texture_center.y];
          }
        }
        if (input.lock_alpha !== undefined) { (Painter as any).lock_alpha = input.lock_alpha; applied.push('lock_alpha'); }
        if (input.pixel_perfect !== undefined) { setBarItemValue('pixel_perfect_drawing', input.pixel_perfect); applied.push('pixel_perfect'); }
        if (input.color_erase_mode !== undefined) { setBarItemValue('color_erase_mode', input.color_erase_mode); (Painter as any).erase_mode = input.color_erase_mode; applied.push('color_erase_mode'); }
        for (const key of ['paint_side_restrict', 'brush_opacity_modifier', 'brush_size_modifier', 'paint_with_stylus_only', 'pick_color_opacity', 'pick_combined_color']) {
          if (input[key] !== undefined && bbSettings && bbSettings[key]) { bbSettings[key].value = input[key]; applied.push(key); }
        }
        return { ok: true, applied };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const paintWithBrush = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        const coords = input.coordinates || [];
        const bs = input.brush_settings || {};
        Undo.initEdit({ textures: [texture], bitmap: true } as any);
        const hex = bs.color ?? '#000000';
        const r = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        const a = bs.opacity ?? 255, size = bs.size ?? 1, softness = bs.softness ?? 0, shape = bs.shape ?? 'square';
        setBarItemValue('slider_brush_size', size); setBarItemValue('slider_brush_opacity', a);
        setBarItemValue('slider_brush_softness', softness); setBarItemValue('brush_shape', shape);
        (ColorPanel as any).set(hex);
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          for (const c of coords) {
            const fn = () => ({ r, g: gg, b, a });
            if (shape === 'circle') (Painter as any).editCircle(ctx, c.x, c.y, size, softness, fn);
            else (Painter as any).editSquare(ctx, c.x, c.y, size, softness, fn);
          }
        }, { edit_name: 'Paint with brush' });
        Undo.finishEdit('Paint with brush via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        return { ok: true, painted: coords.length, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const createBrushPreset = (input: any): any => {
      try {
        const StateMemory = (globalThis as any).StateMemory; // runtime global, not in the typings
        if (!StateMemory) return { ok: false, error: 'StateMemory not available.' };
        const preset = { name: input.name, size: input.size ?? null, opacity: input.opacity ?? null, softness: input.softness ?? null, shape: input.shape || 'square', color: input.color || null, blend_mode: input.blend_mode || 'default', pixel_perfect: input.pixel_perfect || false };
        StateMemory.brush_presets.push(preset);
        StateMemory.save('brush_presets');
        return { ok: true, name: input.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const loadBrushPreset = (input: any): any => {
      try {
        const StateMemory = (globalThis as any).StateMemory; // runtime global, not in the typings
        if (!StateMemory) return { ok: false, error: 'StateMemory not available.' };
        const preset = StateMemory.brush_presets.find((p: any) => p.name === input.preset_name);
        if (!preset) return { ok: false, error: `Brush preset "${input.preset_name}" not found.` };
        (Painter as any).loadBrushPreset(preset);
        return { ok: true, name: input.preset_name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const textureSelection = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        Undo.initEdit({ textures: [texture], bitmap: true } as any);
        const sel = texture.selection;
        const c = input.coordinates;
        switch (input.action) {
          case 'select_rectangle':
            if (!c) return { ok: false, error: 'coordinates required.' };
            sel.clear(); sel.start_x = c.x1; sel.start_y = c.y1; sel.end_x = c.x2; sel.end_y = c.y2; sel.is_custom = false; break;
          case 'select_ellipse': {
            if (!c) return { ok: false, error: 'coordinates required.' };
            sel.clear(); sel.is_custom = true;
            const cx = (c.x1 + c.x2) / 2, cy = (c.y1 + c.y2) / 2, rx = Math.abs(c.x2 - c.x1) / 2, ry = Math.abs(c.y2 - c.y1) / 2;
            for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) { const dx = (x - cx) / rx, dy = (y - cy) / ry; if (dx * dx + dy * dy <= 1) sel.set(x, y, true); }
            break;
          }
          case 'select_all': sel.clear(); sel.start_x = 0; sel.start_y = 0; sel.end_x = texture.width; sel.end_y = texture.height; sel.is_custom = false; break;
          case 'clear_selection': sel.clear(); break;
          case 'invert_selection': sel.invert(); break;
          case 'expand_selection': if (input.radius === undefined) return { ok: false, error: 'radius required.' }; sel.expand(input.radius); break;
          case 'contract_selection': if (input.radius === undefined) return { ok: false, error: 'radius required.' }; sel.contract(input.radius); break;
          case 'feather_selection': if (input.radius === undefined) return { ok: false, error: 'radius required.' }; sel.feather(input.radius); break;
          default: return { ok: false, error: `Unknown action "${input.action}".` };
        }
        if (typeof UVEditor !== 'undefined' && (UVEditor as any).vue?.updateTexture) (UVEditor as any).vue.updateTexture();
        Undo.finishEdit('Texture selection via MCP');
        return { ok: true, action: input.action, texture: texture.name };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    const textureLayerManagement = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const texture = getAndActivateTexture(input.texture_id);
        if (typeof TextureLayer === 'undefined') return { ok: false, error: 'TextureLayer not available.' };
        Undo.initEdit({ textures: [texture], layers: texture.layers, bitmap: true } as any);
        let result = '';
        const selected = () => (TextureLayer as any).selected;
        switch (input.action) {
          case 'create_layer': {
            if (!texture.layers_enabled) texture.activateLayers(true);
            const nl = new (TextureLayer as any)({ name: input.layer_name || `Layer ${texture.layers.length + 1}` }, texture);
            nl.setSize(texture.width, texture.height); nl.addForEditing(); result = `Created layer "${nl.name}"`; break;
          }
          case 'delete_layer': { if (!selected()) return { ok: false, error: 'No layer selected.' }; const l = selected(); l.remove(); result = `Deleted layer "${l.name}"`; break; }
          case 'duplicate_layer': { if (!selected()) return { ok: false, error: 'No layer selected.' }; const d = selected().duplicate(); d.name = `${selected().name} copy`; result = `Duplicated layer`; break; }
          case 'merge_down': { if (!selected()) return { ok: false, error: 'No layer selected.' }; selected().mergeDown(true); result = 'Merged layer down'; break; }
          case 'set_opacity': { if (!selected()) return { ok: false, error: 'No layer selected.' }; if (input.opacity === undefined) return { ok: false, error: 'opacity required.' }; selected().opacity = input.opacity / 100; texture.updateChangesAfterEdit(); result = `Set opacity ${input.opacity}%`; break; }
          case 'set_blend_mode': { if (!selected()) return { ok: false, error: 'No layer selected.' }; if (!input.blend_mode) return { ok: false, error: 'blend_mode required.' }; selected().blend_mode = input.blend_mode; texture.updateChangesAfterEdit(); result = `Set blend mode ${input.blend_mode}`; break; }
          case 'move_layer': { if (!selected()) return { ok: false, error: 'No layer selected.' }; if (input.target_index === undefined) return { ok: false, error: 'target_index required.' }; const lm = selected(); texture.layers.remove(lm); texture.layers.splice(input.target_index, 0, lm); result = `Moved layer to ${input.target_index}`; break; }
          case 'rename_layer': { if (!selected()) return { ok: false, error: 'No layer selected.' }; if (!input.layer_name) return { ok: false, error: 'layer_name required.' }; selected().name = input.layer_name; result = `Renamed layer`; break; }
          case 'flatten_layers': { if (!texture.layers_enabled) return { ok: false, error: 'No layers to flatten.' }; texture.flattenLayers(); result = 'Flattened layers'; break; }
          default: return { ok: false, error: `Unknown action "${input.action}".` };
        }
        texture.updateChangesAfterEdit();
        Undo.finishEdit('Layer management via MCP');
        if (typeof updateInterfacePanels === 'function') (updateInterfacePanels as any)();
        return { ok: true, action: input.action, message: result };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // Pixel-art shading: render an index-matrix to a texture using a
    // hue-shifted palette. Indices 0-4 only (palette-locked → no muddy colors,
    // no anti-aliasing). The matrix carries the noise/AO/directional-light.
    // ---------------------------------------------------------------------
    const paintPixelMatrix = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const pal = getPalette(input.palette);
        if (!pal) return { ok: false, error: `Unknown palette "${input.palette}". Use list_palettes to see options.` };
        const rows: string[] = input.pixels || [];
        if (!rows.length) return { ok: false, error: 'pixels (array of index-string rows) is required.' };
        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        const ox = input.origin?.x ?? 0;
        const oy = input.origin?.y ?? 0;

        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        let painted = 0;
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          for (let r = 0; r < rows.length; r++) {
            const row = String(rows[r]);
            for (let c = 0; c < row.length; c++) {
              const ch = row[c];
              if (ch === '.' || ch === ' ' || ch === '-' || ch === '_') continue; // transparent
              const idx = parseInt(ch, 10);
              if (isNaN(idx) || idx < 0 || idx > 4) continue;
              ctx.fillStyle = pal[idx];
              ctx.fillRect(ox + c, oy + r, 1, 1);
              painted++;
            }
          }
        }, { edit_name: 'Paint pixel matrix' });
        Undo.finishEdit('Paint pixel matrix via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`painted ${painted}px (${input.palette}) on "${texture.name}"`);
        return { ok: true, texture: texture.name, palette: input.palette, painted, origin: [ox, oy], size: [Math.max(...rows.map((r: string) => String(r).length)), rows.length] };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // pack_uv: give EVERY cube its own non-overlapping atlas region and size
    // the texture to fit the model. THE fix for "all cubes' UVs sit at [0,0],
    // so any paint pass overwrites the others → garbage texture".
    // Mode-agnostic: sets box-UV uv_offset (+autouv:0) AND writes the explicit
    // per-face uv rects, so it works whether the format uses box-UV or per-face.
    // Run AFTER building geometry, BEFORE create_texture / apply_texture / painting.
    // ---------------------------------------------------------------------
    const packUv = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        let cubes: any[] = [];
        if (input.target) {
          const g = findGroupByName(input.target);
          if (g) { const collect = (grp: any) => { for (const ch of grp.children || []) { if (typeof Cube !== 'undefined' && ch instanceof Cube) cubes.push(ch); else if (typeof Group !== 'undefined' && ch instanceof Group) collect(ch); } }; collect(g); }
          else { const c = findCubeByNameOrUuid(input.target); if (c) cubes = [c]; else return { ok: false, error: `"${input.target}" is not a group or cube.` }; }
        } else { cubes = allCubes(); }
        if (!cubes.length) return { ok: false, error: 'No cubes to pack.' };

        const pad = Math.max(0, Math.round(input.padding ?? 1));
        // Each cube's box-UV net is 2*(w+d) wide × (h+d) tall.
        const items = cubes.map((c: any) => {
          const w = Math.abs(c.to[0] - c.from[0]), h = Math.abs(c.to[1] - c.from[1]), d = Math.abs(c.to[2] - c.from[2]);
          return { cube: c, w, h, d, fw: Math.max(1, Math.ceil(2 * (w + d))), fh: Math.max(1, Math.ceil(h + d)) };
        });
        const noResize = input.resize_texture === false;
        const existW = (typeof Project !== 'undefined' && (Project as any).texture_width) || 0;
        const existH = (typeof Project !== 'undefined' && (Project as any).texture_height) || 0;
        const totalArea = items.reduce((s, it) => s + (it.fw + pad) * (it.fh + pad), 0);
        const maxW = items.reduce((m, it) => Math.max(m, it.fw), 0);
        // When NOT resizing, pack within the EXISTING texture width so UVs don't run
        // off the texture; otherwise pick a square-ish width and resize to fit.
        const targetW = noResize ? Math.max(maxW, existW || 16) : Math.max(maxW, Math.ceil(Math.sqrt(totalArea)));
        const sorted = [...items].sort((a, b) => b.fh - a.fh); // tallest first (shelf pack)

        // Standard box-UV net face rects for a cube placed at atlas origin (U,V).
        const boxFaces = (U: number, V: number, w: number, h: number, d: number): Record<string, number[]> => ({
          north: [U + d, V + d, U + d + w, V + d + h],
          east:  [U, V + d, U + d, V + d + h],
          south: [U + 2 * d + w, V + d, U + 2 * d + 2 * w, V + d + h],
          west:  [U + d + w, V + d, U + 2 * d + w, V + d + h],
          up:    [U + d + w, V + d, U + d, V],
          down:  [U + d + 2 * w, V, U + d + w, V + d],
        });

        let x = 0, y = 0, shelfH = 0, packedW = 0;
        Undo.initEdit({ elements: cubes, uv_only: true } as any);
        for (const it of sorted) {
          if (x > 0 && x + it.fw > targetW) { x = 0; y += shelfH + pad; shelfH = 0; }
          const U = x, V = y;
          it.cube.uv_offset = [U, V];
          try { it.cube.autouv = 0; } catch { /* */ }
          const rects = boxFaces(U, V, it.w, it.h, it.d);
          for (const fk of Object.keys(rects)) {
            const face = it.cube.faces && it.cube.faces[fk];
            if (face) { try { face.uv = rects[fk]; } catch { /* */ } }
          }
          x += it.fw + pad; shelfH = Math.max(shelfH, it.fh); packedW = Math.max(packedW, x - pad);
        }
        const packedH = y + shelfH;
        Undo.finishEdit('Pack UV via MCP', { elements: cubes });

        const pow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };
        let texW: number, texH: number, warning: string | null = null;
        if (noResize) {
          // Keep the existing texture size; report if the packed content overflows it.
          texW = existW || Math.max(16, packedW); texH = existH || Math.max(16, packedH);
          if (packedW > texW || packedH > texH) {
            warning = `Packed content (${packedW}x${packedH}) exceeds the texture (${texW}x${texH}) — some UVs are out of bounds. Re-run with resize_texture:true, or enlarge the texture.`;
          }
        } else {
          texW = Math.max(16, packedW); texH = Math.max(16, packedH);
          if (input.power_of_two) { texW = pow2(texW); texH = pow2(texH); }
          setTextureResolution(texW, texH);
        }
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        logToHistory(`packed UV for ${cubes.length} cube(s) → ${texW}x${texH}${warning ? ' [overflow]' : ''}`);
        return {
          ok: true, cubes: cubes.length, texture_width: texW, texture_height: texH,
          packed_width: packedW, packed_height: packedH, fits: !warning, warning,
          box_uv: !!(items[0] && items[0].cube.box_uv),
          layout: sorted.map((it) => ({ name: it.cube.name, uv_offset: [...(it.cube.uv_offset || [0, 0])], footprint: [it.fw, it.fh] })),
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // validate_uv: gate BEFORE any painting. Detects the #1 texturing failure
    // (multiple cubes sharing the same atlas area → paint passes overwrite each
    // other), plus out-of-bounds / null / zero-size UVs, and reports the UV mode
    // (box_uv / per_face / mixed). Works regardless of format. If not valid →
    // run pack_uv and re-validate before texturing.
    // ---------------------------------------------------------------------
    const validateUv = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        let cubes: any[] = [];
        if (input.target) {
          const g = findGroupByName(input.target);
          if (g) { const collect = (grp: any) => { for (const ch of grp.children || []) { if (typeof Cube !== 'undefined' && ch instanceof Cube) cubes.push(ch); else if (typeof Group !== 'undefined' && ch instanceof Group) collect(ch); } }; collect(g); }
          else { const c = findCubeByNameOrUuid(input.target); if (c) cubes = [c]; else return { ok: false, error: `"${input.target}" not found.` }; }
        } else { cubes = allCubes(); }
        const texW = (typeof Project !== 'undefined' && (Project as any).texture_width) || 16;
        const texH = (typeof Project !== 'undefined' && (Project as any).texture_height) || 16;

        let faceCount = 0, nullUv = 0, zeroSize = 0, outOfBounds = 0, boxUvCount = 0;
        const rects: Array<{ cube: string; x0: number; y0: number; x1: number; y1: number }> = [];
        for (const c of cubes) {
          if (c.box_uv) boxUvCount++;
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, hasFace = false;
          for (const fk of Object.keys(c.faces || {})) {
            faceCount++;
            const uv = c.faces[fk] && c.faces[fk].uv;
            if (!uv || uv.length < 4) { nullUv++; continue; }
            const x0 = Math.min(uv[0], uv[2]), y0 = Math.min(uv[1], uv[3]), x1 = Math.max(uv[0], uv[2]), y1 = Math.max(uv[1], uv[3]);
            if (x1 - x0 <= 0 || y1 - y0 <= 0) { zeroSize++; continue; }
            if (x0 < 0 || y0 < 0 || x1 > texW || y1 > texH) outOfBounds++;
            bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1); hasFace = true;
          }
          if (hasFace) rects.push({ cube: c.name, x0: bx0, y0: by0, x1: bx1, y1: by1 });
        }
        // Pairwise overlap between DIFFERENT cubes' UV bounding boxes (strict, so
        // edge-touching packed nets do NOT count as overlap).
        let overlaps = 0; const overlapPairs: string[] = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) { overlaps++; if (overlapPairs.length < 20) overlapPairs.push(`${a.cube}~${b.cube}`); }
        }
        // VALID hinges on what pack_uv can fix and what corrupts a texture: overlaps
        // (paint bleed) and out-of-bounds UVs. null / zero-size faces come from flat
        // or sub-1-unit cubes — pack_uv cannot fix those, so marking them invalid
        // would send the AI into a pack/validate loop. They stay WARNINGS.
        const valid = overlaps === 0 && outOfBounds === 0;
        const warnings = nullUv > 0 || zeroSize > 0;
        const uvMode = cubes.length === 0 ? 'none' : boxUvCount === cubes.length ? 'box_uv' : boxUvCount === 0 ? 'per_face' : 'mixed';
        logToHistory(`validate_uv: ${cubes.length} cubes/${faceCount} faces, overlaps=${overlaps} oob=${outOfBounds} null=${nullUv} zero=${zeroSize}, mode=${uvMode}, tex=${texW}x${texH}`);
        return {
          ok: true, valid, warnings, cubes: cubes.length, faces: faceCount, uv_mode: uvMode, box_uv_cubes: boxUvCount,
          texture: [texW, texH], overlaps, overlapping_pairs: overlapPairs, out_of_bounds: outOfBounds, null_uv: nullUv, zero_size_uv: zeroSize,
          recommendation: !valid
            ? 'Run pack_uv (or set per-cube uv_offset) to fix overlapping/out-of-bounds UVs, then re-validate before painting/exporting.'
            : warnings
              ? 'Safe to paint — no overlaps. Null/zero-size faces come from flat or sub-1-unit cubes; pack_uv cannot fix them. If those faces look wrong in-game, thicken the cube to at least 1 unit.'
              : 'UV layout is valid — safe to paint / shade_cube.',
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // ---------------------------------------------------------------------
    // shade_cube(s): paint cube faces from ONE exact colour with the shared face
    // painter (packages/shared/src/facePainter.ts): a 9-shade hue-shifted palette, face
    // light (top bright, bottom dark), a soft gradient on the sides, lit and shaded
    // edges, and a material pattern (fur, stone, wood grain, …) — so the result
    // reads like hand-made pixel art instead of the old flat bands. Reads each face's
    // packed UV rect, so run pack_uv + validate_uv first.
    // ---------------------------------------------------------------------
    type ShadeSpec = {
      cubes: any[]; label: string;
      /** The exact colour (the painter builds the material's palettes from it) … */
      color: string | null;
      /** … or a hand-picked palette, dark → light. `ramp` is what the reply reports. */
      given: string[] | null; ramp: string[];
      edgeColor: string | null; sheen: boolean;
      material: Material; detail: number; lighting: number; smoothing: number | undefined;
    };

    // Resolve one shade request (cube_id or group target + colour) without painting.
    const resolveShadeSpec = (input: any): { error: string } | ShadeSpec => {
      let cubes: any[] = [];
      let label: string;
      if (input.cube_id) {
        const c = findCubeByNameOrUuid(input.cube_id);
        if (!c) return { error: `Cube "${input.cube_id}" not found.` };
        cubes = [c]; label = c.name;
      } else if (input.target) {
        const g = findGroupByName(input.target); if (!g) return { error: `"${input.target}" is not a group.` };
        const collect = (grp: any) => { for (const ch of grp.children || []) { if (typeof Cube !== 'undefined' && ch instanceof Cube) cubes.push(ch); else if (typeof Group !== 'undefined' && ch instanceof Group) collect(ch); } };
        collect(g); if (!cubes.length) return { error: `Group "${input.target}" has no descendant cubes.` };
        label = input.target;
      } else return { error: 'Provide cube_id (one cube) or target (a group of cubes).' };

      let given: string[] | null = null;
      if (Array.isArray(input.colors) && input.colors.length >= 3) given = input.colors.slice(0, 9).map((c: any) => String(c));
      else if (!input.color) return { error: 'Provide color (one hex → auto palette) or colors (3–9 hex, dark → light).' };
      if (input.material !== undefined && !(MATERIALS as readonly string[]).includes(input.material)) {
        return { error: `Unknown material "${input.material}". Use one of: ${MATERIALS.join(', ')}.` };
      }
      const level = (v: any, fallback: number) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(2, v)) : fallback);
      const color = given ? null : String(input.color);
      return {
        cubes, label, color, given,
        ramp: given || rampFromBase(color!),
        edgeColor: input.edge_color ? String(input.edge_color) : null,
        sheen: !!input.sheen,
        material: (input.material || 'generic') as Material,
        detail: level(input.detail, 1),
        lighting: level(input.lighting, 1),
        smoothing: typeof input.smoothing === 'number' && isFinite(input.smoothing) ? Math.max(0, Math.min(1, input.smoothing)) : undefined,
      };
    };

    // Paint one spec's cubes into an open texture canvas; returns pixels painted.
    // UV coordinates are in the texture's UV size, which can be smaller than its pixels (a
    // 32×32 texture on a 16×16 UV grid is 2 px per unit) — paint each face at pixel size.
    const uvScale = (texture: any, TW: number, TH: number): [number, number] => {
      const P: any = typeof Project !== 'undefined' ? Project : null;
      const uw = Number(P?.getUVWidth?.(texture) ?? texture?.uv_width ?? P?.texture_width) || TW;
      const uh = Number(P?.getUVHeight?.(texture) ?? texture?.uv_height ?? P?.texture_height) || TH;
      return [TW / uw, TH / uh];
    };
    const paintShadeSpec = (ctx: any, TW: number, TH: number, spec: ShadeSpec, [sx, sy]: [number, number] = [1, 1]): number => {
      let painted = 0;
      for (const cube of spec.cubes) {
        const seed = seedFrom(String(cube.name || cube.uuid || ''));
        for (const fk of Object.keys(cube.faces || {})) {
          const uv = cube.faces[fk] && cube.faces[fk].uv;
          if (!uv || uv.length < 4) continue;
          const x0 = Math.round(Math.min(uv[0], uv[2]) * sx), y0 = Math.round(Math.min(uv[1], uv[3]) * sy);
          const x1 = Math.round(Math.max(uv[0], uv[2]) * sx), y1 = Math.round(Math.max(uv[1], uv[3]) * sy);
          const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) continue;
          const face = fk as FaceKey;
          const thinSide = !!spec.edgeColor && (face === 'east' || face === 'west');
          const rows = paintFace(face, w, h, {
            ...(thinSide ? { color: spec.edgeColor! } : spec.given ? { ramp: spec.given } : { color: spec.color! }),
            material: spec.material,
            seed,
            detail: spec.detail,
            lighting: spec.lighting,
            smoothing: spec.smoothing,
            sheen: spec.sheen,
          });
          // A flipped UV rect (mirrored face) must get the painted face flipped too, so
          // the light stays on top and on the same side.
          const flipX = uv[0] > uv[2], flipY = uv[1] > uv[3];
          for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
            const px = x0 + lx, py = y0 + ly; if (px < 0 || py < 0 || px >= TW || py >= TH) continue;
            ctx.fillStyle = rows[flipY ? h - 1 - ly : ly][flipX ? w - 1 - lx : lx];
            ctx.fillRect(px, py, 1, 1); painted++;
          }
        }
      }
      return painted;
    };

    const shadeCube = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const spec = resolveShadeSpec(input);
        if ('error' in spec) return { ok: false, error: spec.error };

        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        let painted = 0;
        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        texture.edit((canvas: any) => {
          painted = paintShadeSpec(canvas.getContext('2d'), canvas.width, canvas.height, spec, uvScale(texture, canvas.width, canvas.height));
        }, { edit_name: 'Shade cube' });
        Undo.finishEdit('Shade cube via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
        logToHistory(`shaded ${spec.cubes.length} cube(s), ${painted}px on "${texture.name}"`);
        return { ok: true, cubes: spec.cubes.length, painted, texture: texture.name, ramp: spec.ramp, layer: layer ? layer.name : null };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    // Texture a whole model in ONE call: many parts, each with its own colour,
    // painted in a single texture edit and undo step. Items are validated first
    // (all-or-nothing) and painted in order, so a later item wins where two overlap.
    const shadeCubes = (input: any): any => {
      try {
        if (!hasProject()) return { ok: false, error: 'No project open.' };
        const items: any[] = Array.isArray(input.items) ? input.items : [];
        if (!items.length) return { ok: false, error: 'items[] is required (each: cube_id or target, plus color or colors).' };
        const specs: ShadeSpec[] = [];
        for (let i = 0; i < items.length; i++) {
          const spec = resolveShadeSpec(items[i] || {});
          if ('error' in spec) return { ok: false, error: `items[${i}]: ${spec.error}` };
          specs.push(spec);
        }

        const texture = getAndActivateTexture(input.texture_id);
        const layer = resolveTextureLayer(texture, input.layer);
        const perItem: number[] = [];
        Undo.initEdit({ textures: [texture], layers: layer ? texture.layers : undefined, bitmap: true } as any);
        texture.edit((canvas: any) => {
          const ctx = canvas.getContext('2d');
          const scale = uvScale(texture, canvas.width, canvas.height);
          for (const spec of specs) perItem.push(paintShadeSpec(ctx, canvas.width, canvas.height, spec, scale));
        }, { edit_name: 'Shade cubes' });
        Undo.finishEdit('Shade cubes via MCP');
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();

        const cubeCount = specs.reduce((a, s) => a + s.cubes.length, 0);
        const painted = perItem.reduce((a, n) => a + n, 0);
        logToHistory(`shaded ${specs.length} item(s) / ${cubeCount} cube(s), ${painted}px on "${texture.name}"`);
        return {
          ok: true, items: specs.length, cubes: cubeCount, painted, texture: texture.name, layer: layer ? layer.name : null,
          results: specs.map((s, i) => ({ target: s.label, cubes: s.cubes.length, painted: perItem[i] })),
        };
      } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    };

    socket.on("connect", () => {
      console.log("[MCP Plugin] Connected");
      commandHistory.push({
        timestamp: new Date(),
        type: 'sent',
        command: 'client_ready'
      });
      socket.emit("client_ready");
      updateCommandHistory();
    });

    const recentCalls = new Map<string, Promise<any>>();
    socket.on("tool_command", async (cmd: { tool: ToolType; input: any; call_id?: string }, ack?: (response: any) => void) => {
      commandHistory.push({
        timestamp: new Date(),
        type: 'received',
        command: 'tool_command',
        data: cmd
      });

      const handlers: Record<string, (input: any) => any> = {
        create_cube: createCube,
        create_cubes: createCubes,
        create_group: createGroup,
        set_origin: setOrigin,
        set_rotation: setRotation,
        get_scene_tree: getSceneTree,
        register_texture: registerTexture,
        apply_texture: applyTexture,
        create_animation: createAnimation,
        manage_keyframes: manageKeyframes,
        animation_graph_editor: animationGraphEditor,
        animation_timeline: animationTimeline,
        batch_keyframe_operations: batchKeyframeOperations,
        animation_copy_paste: animationCopyPaste,
        list_animations: listAnimations,
        manage_animation: manageAnimation,
        set_keyframes: setKeyframes,
        check_animation: checkAnimation,
        get_keyframes: getKeyframes,
        get_bone_pose: getBonePose,
        modify_cube: modifyCube,
        modify_cubes: modifyCubes,
        delete_element: deleteElement,
        reparent_element: reparentElement,
        list_export_formats: listExportFormats,
        export_model: exportModel,
        export_animations: exportAnimations,
        get_project_info: getProjectInfo,
        set_project: setProject,
        create_project: createProject,
        create_texture: createTexture,
        replace_texture: replaceTexture,
        list_textures: listTextures,
        get_texture: getTexture,
        activate_texture: activateTexture,
        add_texture_group: addTextureGroup,
        set_mesh_uv: setMeshUv,
        auto_uv_mesh: autoUvMesh,
        rotate_mesh_uv: rotateMeshUv,
        capture_screenshot: captureScreenshot,
        capture_app_screenshot: captureAppScreenshot,
        set_camera_angle: setCameraAngle,
        undo: undoTool,
        redo: redoTool,
        get_undo_stack: getUndoStack,
        save_checkpoint: saveCheckpoint,
        duplicate_element: duplicateElement,
        move_element: moveElement,
        place_relative: placeRelative,
        rename_element: renameElement,
        find_elements_by_criteria: findElementsByCriteria,
        select_all_of_type: selectAllOfType,
        filter_by_material: filterByMaterial,
        get_selection: getSelection,
        create_pbr_material: createPbrMaterial,
        configure_material: configureMaterial,
        list_materials: listMaterials,
        get_material_info: getMaterialInfo,
        import_texture_set: importTextureSet,
        assign_texture_channel: assignTextureChannel,
        save_material_config: saveMaterialConfig,
        get_face_material_instances: getFaceMaterialInstances,
        set_face_material_instance: setFaceMaterialInstance,
        list_material_instances: listMaterialInstances,
        bulk_set_material_instances: bulkSetMaterialInstances,
        clear_material_instances: clearMaterialInstances,
        paint_fill_tool: paintFillTool,
        draw_shape_tool: drawShapeTool,
        gradient_tool: gradientTool,
        color_picker_tool: colorPickerTool,
        place_mesh: placeMesh,
        create_sphere: createSphere,
        create_cylinder: createCylinder,
        extrude_mesh: extrudeMesh,
        subdivide_mesh: subdivideMesh,
        delete_mesh_elements: deleteMeshElements,
        move_mesh_vertices: moveMeshVertices,
        merge_mesh_vertices: mergeMeshVertices,
        create_mesh_face: createMeshFace,
        select_mesh_elements: selectMeshElements,
        knife_tool: knifeTool,
        list_actions: listActions,
        trigger_action: triggerAction,
        risky_eval: riskyEval,
        emulate_clicks: emulateClicks,
        fill_dialog: fillDialog,
        from_geo_json: fromGeoJson,
        list_armatures: listArmatures,
        get_armature: getArmature,
        add_armature: addArmature,
        remove_armature: removeArmature,
        update_armature: updateArmature,
        list_armature_bones: listArmatureBones,
        get_armature_bone: getArmatureBone,
        add_armature_bone: addArmatureBone,
        remove_armature_bone: removeArmatureBone,
        update_armature_bone: updateArmatureBone,
        update_armature_bones_batch: updateArmatureBonesBatch,
        select_armature_bones: selectArmatureBones,
        get_vertex_weights: getVertexWeights,
        set_vertex_weight: setVertexWeight,
        set_vertex_weights_batch: setVertexWeightsBatch,
        clear_vertex_weights: clearVertexWeights,
        copy_brush_tool: copyBrushTool,
        eraser_tool: eraserTool,
        paint_settings: paintSettings,
        paint_with_brush: paintWithBrush,
        create_brush_preset: createBrushPreset,
        load_brush_preset: loadBrushPreset,
        texture_selection: textureSelection,
        texture_layer_management: textureLayerManagement,
        paint_pixel_matrix: paintPixelMatrix,
        pack_uv: packUv,
        validate_uv: validateUv,
        shade_cube: shadeCube,
        shade_cubes: shadeCubes,
      };
      pluginToolCount = Object.keys(handlers).length;

      const run = async () => {
        const handler = handlers[cmd.tool];
        if (!handler) return { ok: false, error: `Unknown tool: ${cmd.tool}` };
        try {
          return await handler(cmd.input || {});
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
      };
      // A call relayed through a shared bridge carries an id and may arrive twice
      // (resent after the bridge owner died mid-call): answer the resend with the
      // first result instead of applying the edit again.
      let pending = cmd.call_id ? recentCalls.get(cmd.call_id) : undefined;
      if (!pending) {
        pending = run();
        if (cmd.call_id) {
          recentCalls.set(cmd.call_id, pending);
          if (recentCalls.size > 100) recentCalls.delete(recentCalls.keys().next().value as string);
        }
      }
      const response = await pending;

      updateCommandHistory();

      // Acknowledge back to the MCP server so it can report the result to Claude.
      if (typeof ack === "function") {
        ack(response);
      }
    });

    // Add a socket event listener to record all sent/received traffic
    const originalEmit = socket.emit;
    socket.emit = function(event: string, ...args: any[]) {
      commandHistory.push({
        timestamp: new Date(),
        type: 'sent',
        command: event,
        data: args.length > 0 ? args : undefined
      });
      updateCommandHistory();
      return originalEmit.call(this, event, ...args);
    };

    // Periodically refresh the panel (every 10 seconds)
    mcpInterval = setInterval(() => {
      if (commandHistory.length > 0) {
        updateCommandHistory();
      }
    }, 10000);
  },
  onunload: () => {
    // Disconnect the socket so reloading the plugin doesn't leave stale
    // connections behind (each one would otherwise keep creating cubes).
    if (mcpSocket) {
      mcpSocket.removeAllListeners();
      mcpSocket.disconnect();
      mcpSocket = null;
    }
    // Stop the periodic refresh timer.
    if (mcpInterval) {
      clearInterval(mcpInterval);
      mcpInterval = null;
    }
    // Clean up the Action
    if (BarItems.mcp_toggle_panel) {
      BarItems.mcp_toggle_panel.delete();
    }
    // Clean up the panel
    if (mcpPanel) {
      mcpPanel.delete();
    }
  },
  /**
   * Runs when the user manually installs the plugin
   */
  oninstall: () => {},
  /**
   * Runs when the user manually uninstalls the plugin
   */
  onuninstall: () => {},
};

(function () {
  // let pluginSettings: Setting[];

  BBPlugin.register("mcp_socketio_plugin", options);
})();
