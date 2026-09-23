#!/usr/bin/env node
// Usage report for the Blockbench MCP server, read from the logs Claude already writes.
//
//   pnpm report                          # default log locations
//   pnpm report --since 2026-09-01
//   node tools/usage-report.mjs <file|dir> …   # .log = Claude app, .jsonl = Claude Code
//
// Two sources:
// - Claude app: mcp-server-blockbench.log, every JSON-RPC message of its server. Older
//   app versions logged whole messages (tool names, error text); since ~2026-06-27 it
//   logs only `method="tools/call" id=N`, so per-tool numbers come from older entries.
//   Our own stderr ([MCP] …) lands here too: port conflicts, relay joins, takeovers.
// - Claude Code: claude-cli-nodejs/Cache/<project>/mcp-logs-blockbench/*.jsonl, one
//   "Calling MCP tool: X" / "Tool 'X' completed … | failed …" pair per call.
// Latency = request → reply as seen by the client (bridge + Blockbench included).
// Think gap = reply → next call in the same log (gaps over 30 min count as a break).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--");
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? new Date(args[sinceIdx + 1]) : null;
if (since && isNaN(since)) {
  console.error("--since expects a date, e.g. 2026-09-01");
  process.exit(2);
}
const explicit = args.filter((a, i) => !a.startsWith("--") && !(sinceIdx >= 0 && i === sinceIdx + 1));

const listDir = (d, test) => {
  try { return readdirSync(d).filter(test).map((f) => path.join(d, f)); } catch { return []; }
};
const expand = (p) => (existsSync(p) && statSync(p).isDirectory() ? listDir(p, (f) => f.endsWith(".log") || f.endsWith(".jsonl")) : [p]);

function defaultLogs() {
  const home = os.homedir();
  const appDirs = [], cacheRoots = [];
  if (process.platform === "win32") {
    for (const v of [process.env.APPDATA, process.env.LOCALAPPDATA]) if (v) appDirs.push(path.join(v, "Claude", "logs"));
    if (process.env.LOCALAPPDATA) cacheRoots.push(path.join(process.env.LOCALAPPDATA, "claude-cli-nodejs", "Cache"));
  } else if (process.platform === "darwin") {
    appDirs.push(path.join(home, "Library", "Logs", "Claude"));
    cacheRoots.push(path.join(home, "Library", "Caches", "claude-cli-nodejs"));
  } else {
    appDirs.push(path.join(home, ".config", "Claude", "logs"));
    cacheRoots.push(path.join(home, ".cache", "claude-cli-nodejs"));
  }
  const app = appDirs.map((d) => path.join(d, "mcp-server-blockbench.log"));
  const code = cacheRoots.flatMap((root) =>
    listDir(root, () => true).flatMap((proj) => listDir(path.join(proj, "mcp-logs-blockbench"), (f) => f.endsWith(".jsonl")))
  );
  return [...app, ...code];
}

const files = (explicit.length ? explicit.flatMap(expand) : defaultLogs()).filter((f) => existsSync(f));
if (!files.length) {
  console.error("No log found. Pass mcp-server-blockbench.log or a Claude Code mcp-logs-blockbench folder.");
  process.exit(1);
}

const calls = []; // { start, end, tool, error, file, source }
const events = { starts: 0, fatalPort: 0, fatalOther: 0, relayJoins: 0, takeovers: 0 };
let logFirst = null, logLast = null;
const seen = (ts) => {
  if (!logFirst || ts < logFirst) logFirst = ts;
  if (!logLast || ts > logLast) logLast = ts;
};
const codeOf = (text) => (/^\[([A-Z_]+)\]/.exec(text || "") || [])[1] || (/timed out/i.test(text || "") ? "TIMEOUT" : "ERROR");

// ---- Claude app log ----
const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[[^\]]+\] \[(\w+)\] (.*)$/;
const stripMeta = (s) => s.replace(/ \{ metadata: undefined \}$/, "");
function parseAppLog(file) {
  let open = new Map(); // id -> call; ids restart with each server start
  let lineTs = null; // our stderr lines have no timestamp: use the previous line's
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (raw.startsWith("[MCP] ")) {
      if (since && (!lineTs || lineTs < since)) continue;
      if (/FATAL: bridge port .*(already in use|in use by a program)/.test(raw)) events.fatalPort++;
      else if (raw.includes("FATAL")) events.fatalOther++;
      if (raw.includes("joined it as a relay")) events.relayJoins++;
      if (raw.includes("took over from the previous owner")) events.takeovers++;
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) continue;
    const ts = new Date(m[1]);
    lineTs = ts;
    if (since && ts < since) continue;
    seen(ts);
    const msg = m[3];
    if (msg.startsWith("Initializing server")) {
      events.starts++;
      open = new Map();
    } else if (msg.startsWith("Message from client:")) {
      const body = stripMeta(msg.slice(20).trim());
      let id, tool = null;
      if (body.startsWith("{")) {
        let j;
        try { j = JSON.parse(body); } catch { continue; }
        if (j.method !== "tools/call") continue;
        id = j.id;
        tool = j.params?.name ?? null;
      } else {
        const mm = /method="tools\/call" id=(\d+)/.exec(body);
        if (!mm) continue;
        id = Number(mm[1]);
      }
      const c = { start: ts, end: null, tool, error: null, file, source: "app" };
      open.set(id, c);
      calls.push(c);
    } else if (msg.startsWith("Message from server:")) {
      const body = stripMeta(msg.slice(20).trim());
      let id, error = null;
      if (body.startsWith("{")) {
        let j;
        try { j = JSON.parse(body); } catch { continue; }
        id = j.id;
        if (j.error) error = "RPC_ERROR";
        else if (j.result?.isError) error = codeOf(j.result.content?.[0]?.text);
      } else {
        const mm = /^id=(\d+) (\w+)/.exec(body);
        if (!mm) continue;
        id = Number(mm[1]);
        if (mm[2] === "error") error = "RPC_ERROR";
      }
      const c = open.get(id);
      if (!c) continue;
      open.delete(id);
      c.end = ts;
      c.error = error;
    }
  }
}

// ---- Claude Code log ----
function parseCodeLog(file) {
  const open = new Map(); // tool -> [calls] (FIFO; parallel calls of one tool pair in order)
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!raw.startsWith("{")) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    const text = j.debug || j.error || "";
    const ts = new Date(j.timestamp);
    if (isNaN(ts) || (since && ts < since)) continue;
    seen(ts);
    let m;
    if ((m = /^Calling MCP tool: (\S+)/.exec(text))) {
      const c = { start: ts, end: null, tool: m[1], error: null, file, source: "code" };
      (open.get(c.tool) || open.set(c.tool, []).get(c.tool)).push(c);
      calls.push(c);
    } else if ((m = /^Tool '([^']+)' (completed successfully|failed)/.exec(text))) {
      const c = (open.get(m[1]) || []).shift();
      if (!c) continue;
      c.end = ts;
      if (m[2] === "failed") c.error = codeOf(text.replace(/^Tool '[^']+' failed after [^:]*: /, ""));
    }
  }
}

for (const f of files) (f.endsWith(".jsonl") ? parseCodeLog : parseAppLog)(f);
calls.sort((a, b) => a.start - b.start);

// ---- Report ----
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmtMs = (ms) => (isNaN(ms) ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const day = (d) => (d ? d.toISOString().slice(0, 10) : "–");
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const done = calls.filter((c) => c.end);
const lat = done.map((c) => c.end - c.start);
const gaps = [];
const byFile = new Map();
for (const c of calls) (byFile.get(c.file) || byFile.set(c.file, []).get(c.file)).push(c);
for (const list of byFile.values()) {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    if (prev.end && cur.start > prev.end && cur.start - prev.end < 30 * 60_000) gaps.push(cur.start - prev.end);
  }
}
const lastUse = (src) => day(calls.filter((c) => c.source === src).at(-1)?.start);
const count = (src) => calls.filter((c) => c.source === src).length;

console.log(`Blockbench MCP usage report${since ? ` since ${day(since)}` : ""}`);
console.log(`Logs: ${files.length} file(s) · covering ${day(logFirst)} … ${day(logLast)}`);
console.log(`Claude app: ${count("app")} calls (last ${lastUse("app")}) · Claude Code: ${count("code")} calls (last ${lastUse("code")})`);
console.log("");
console.log(`Tool calls: ${calls.length} (${calls.length - done.length} without a reply)`);
console.log(`Latency   p50 ${fmtMs(pct(lat, 50))} · p90 ${fmtMs(pct(lat, 90))} · p99 ${fmtMs(pct(lat, 99))} · max ${fmtMs(lat.length ? Math.max(...lat) : NaN)} · total ${fmtMs(sum(lat))}`);
console.log(`Think gap p50 ${fmtMs(pct(gaps, 50))} · p90 ${fmtMs(pct(gaps, 90))} · total ${fmtMs(sum(gaps))}`);
const errs = done.filter((c) => c.error);
const byCode = {};
for (const c of errs) byCode[c.error] = (byCode[c.error] || 0) + 1;
console.log(`Errors: ${errs.length}${errs.length ? " — " + Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") : ""}`);
console.log(`Bridge (Claude app log): server starts ${events.starts} · port-conflict exits ${events.fatalPort} · other fatal ${events.fatalOther} · relay joins ${events.relayJoins} · takeovers ${events.takeovers}`);

const named = done.filter((c) => c.tool);
if (named.length) {
  const per = new Map();
  for (const c of named) {
    const e = per.get(c.tool) || { n: 0, lat: [], err: 0 };
    e.n++;
    e.lat.push(c.end - c.start);
    if (c.error) e.err++;
    per.set(c.tool, e);
  }
  console.log("");
  console.log(`Per tool (${named.length} calls with a known name):`);
  console.log("  calls  p50      p90      errors  tool");
  for (const [tool, e] of [...per].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${String(e.n).padStart(5)}  ${fmtMs(pct(e.lat, 50)).padEnd(8)} ${fmtMs(pct(e.lat, 90)).padEnd(8)} ${String(e.err).padStart(6)}  ${tool}`);
  }
}
