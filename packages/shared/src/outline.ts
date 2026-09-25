// get_scene_tree format "outline": the hierarchy as indented lines, one per group or cube,
// instead of pretty-printed JSON that spends a line on every coordinate.
import type { SceneTree } from "./types";

const num = (n: number) => String(Math.round(n * 1e4) / 1e4 + 0);
const vec = (v?: number[]) => `[${(v || [0, 0, 0]).map(num).join(", ")}]`;
const rotated = (r?: number[]) => !!r && r.some((x) => Math.abs(x) > 1e-9);

/**
 * One line per node: groups end in "/" with their pivot (and rotation, if any); cubes show
 * from→to, their size, a rotation with its pivot, and the box-UV offset when there is one.
 */
export function outlineText(tree: SceneTree & { requested_bones_not_found?: string[] }): string {
  const lines: string[] = [];
  let groups = 0, cubes = 0;
  const walk = (n: any, depth: number) => {
    const pad = "  ".repeat(depth);
    if (n.type === "group") {
      groups++;
      const hidden = n.truncated_children ? `  (+${n.truncated_children} not shown: max_depth)` : "";
      lines.push(`${pad}${n.name}/  pivot ${vec(n.origin)}${rotated(n.rotation) ? `  rot ${vec(n.rotation)}` : ""}${hidden}`);
      for (const c of n.children || []) walk(c, depth + 1);
      return;
    }
    cubes++;
    const size = [0, 1, 2].map((i) => num(Math.abs((n.to?.[i] ?? 0) - (n.from?.[i] ?? 0)))).join("×");
    const rot = rotated(n.rotation) ? `  rot ${vec(n.rotation)} about ${vec(n.origin)}` : "";
    const uv = Array.isArray(n.uv_offset) ? `  uv ${vec(n.uv_offset)}` : "";
    lines.push(`${pad}${n.name}  ${vec(n.from)}→${vec(n.to)}  ${size}${rot}${uv}`);
  };
  for (const n of tree.roots || []) walk(n, 0);
  const format = tree.format?.id ? `${tree.format.id} · ` : "";
  const meshes = tree.mesh_count ? `, ${tree.mesh_count} mesh(es) not listed` : "";
  const out = [`${format}${groups} group(s), ${cubes} cube(s)${meshes}`, ...lines];
  const textures = (tree.textures || []).map((t) => t.name);
  out.push(`textures: ${textures.length ? textures.join(", ") : "(none)"}`);
  if (tree.requested_bones_not_found?.length) out.push(`not found: ${tree.requested_bones_not_found.join(", ")}`);
  return out.join("\n");
}
