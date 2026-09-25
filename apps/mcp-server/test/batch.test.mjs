// run_batch through the real server and the mock plugin: steps run in order through the same
// schema checks and handlers as direct calls; stop / continue / rollback on a failed step.
import { startHarness } from "./harness.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const near = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const one = (s) => s.replace(/\n/g, " ⏎ ").slice(0, 260);

const h = await startHarness();
try {
  const node = (name) => { let r = null; const walk = (ns) => ns.forEach((n) => { if (n.name === name) r = n; if (n.children) walk(n.children); }); walk(h.scene.roots); return r; };
  const batch = async (args) => {
    const r = await h.rpc("tools/call", { name: "run_batch", arguments: args });
    const content = r.result?.content || [];
    return { isError: !!r.result?.isError, text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images: content.filter((c) => c.type === "image").length, raw: r };
  };

  const good = await batch({ steps: [
    { tool: "create_group", args: { name: "body", origin: [0, 12, 0] } },
    { tool: "create_cube", args: { name: "body_cube", parent: "body", from: [-4, 12, -2], to: [4, 24, 2] } },
    { tool: "create_group", args: { name: "head", origin: [0, 0, 0] } },
    { tool: "create_cube", args: { name: "head_cube", parent: "head", from: [-4, 0, -4], to: [4, 8, 4] } },
    { tool: "place_relative", args: { target: "head", ref: "body", side: "on_top" } },
  ] });
  check("five steps in one call, in order", !good.isError && /^Batch done: 5\/5/.test(good.text) && (good.text.match(/✓/g) || []).length === 5, one(good.text));
  check("the steps really ran (head placed on the body)", near(node("head_cube")?.from, [-4, 24, -4]));

  const stopped = await batch({ steps: [
    { tool: "create_group", args: { name: "a1" } },
    { tool: "set_origin", args: { target: "missing_group", origin: [0, 0, 0] } },
    { tool: "create_group", args: { name: "a3" } },
  ] });
  check("stop: the batch stops at the failed step and reports it", stopped.isError && /stopped: step 2 \(set_origin\) failed, 1 step\(s\) succeeded/.test(stopped.text) && !node("a3"), one(stopped.text));

  const cont = await batch({ on_error: "continue", steps: [
    { tool: "set_origin", args: { target: "missing_group", origin: [0, 0, 0] } },
    { tool: "create_group", args: { name: "c2" } },
  ] });
  check("continue: runs the rest and is not an error overall", !cont.isError && /finished with errors/.test(cont.text) && !!node("c2"), one(cont.text));

  const before = JSON.parse((await h.call("get_undo_stack", {})).text).index;
  const rolled = await batch({ on_error: "rollback", steps: [
    { tool: "save_checkpoint", args: { name: "one" } },
    { tool: "save_checkpoint", args: { name: "two" } },
    { tool: "set_origin", args: { target: "missing_group", origin: [0, 0, 0] } },
  ] });
  const after = JSON.parse((await h.call("get_undo_stack", {})).text).index;
  check("rollback: undoes exactly what the batch did", rolled.isError && /Rolled back: undid 2 step\(s\)/.test(rolled.text) && after === before, `${one(rolled.text)} (undo index ${before} → ${after})`);

  const bad = await batch({ steps: [{ tool: "place_relative", args: { target: "head", ref: "body", side: "above" } }] });
  check("a step's arguments are checked by that tool's schema", bad.isError && /Invalid arguments for place_relative: side/.test(bad.text), one(bad.text));
  const unknown = await batch({ steps: [{ tool: "make_it_pretty", args: {} }] });
  check("an unknown tool fails its step", unknown.isError && /Unknown tool "make_it_pretty"/.test(unknown.text));
  const nested = await batch({ steps: [{ tool: "run_batch", args: { steps: [{ tool: "get_project_info" }] } }] });
  check("run_batch cannot nest", nested.isError && /cannot run inside run_batch/.test(nested.text));
  const shots = await batch({ steps: [{ tool: "capture_screenshot", args: { views: ["front", "left"] } }, { tool: "get_scene_tree", args: { format: "outline" } }] });
  check("images from steps come back with the reply", !shots.isError && shots.images === 1 && /front \| left/.test(shots.text) && /body\/  pivot/.test(shots.text), one(shots.text));
} finally {
  h.stop();
}

console.log(`\n${failures === 0 ? "🎉 BATCH CHECKS PASSED" : "💥 " + failures + " BATCH CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
