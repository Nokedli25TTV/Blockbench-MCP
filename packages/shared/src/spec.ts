// create_from_spec: a rig described part by part — its size, what it rests against, where
// its pivot is, which parts get a mirrored twin — planned into ONE create_cubes call (one
// undo step, all-or-nothing). Every part becomes a bone holding one cube. Positions are
// computed at rest, before any bone rotation. Pure, so it is tested without Blockbench.
import type { Vec3, SceneNode, SceneTree } from "./types";
import {
  placementDelta, anchorPoint, mirroredName, mirrorCoord, roundVec, worldPoints, boxOf, isAlignSpec, SIDES, ALIGNS, ANCHORS,
} from "./placement.ts"; // with the extension: the tests run this file in Node directly
import type { Box, Side, AlignSpec, Anchor, Frame, GeoNode } from "./placement.ts";

export interface SpecPart {
  name: string;
  size: Vec3;
  parent?: string;
  /** Rest it against an earlier part (or an existing element), as place_relative does. */
  attach?: { to: string; side: Side; gap?: number; align?: AlignSpec; offset?: Vec3 };
  /** Or an explicit lower corner; default: centred on the origin, standing on y = 0. */
  from?: Vec3;
  /** An anchor of the part's own box (default "center") or a point. */
  pivot?: Anchor | Vec3;
  rotation?: Vec3;
  /** Also build the mirrored twin (left ↔ right). */
  mirror?: "x";
  cube_name?: string;
}

export interface SpecPlan {
  groups: { name: string; parent?: string; origin: Vec3; rotation?: Vec3 }[];
  cubes: { name: string; parent: string; from: Vec3; to: Vec3 }[];
  boxes: Record<string, Box>;
}

/**
 * Plan the parts in order. `existing` holds the world boxes of elements already in the
 * project (attach targets), `existingGroups` the group names a part may be parented to.
 * `mirrorCenter` is 0 on a centred grid, 8 in Java block/item models.
 */
export function planSpec(parts: SpecPart[], existing: Record<string, Box> = {}, existingGroups: Set<string> = new Set(), mirrorCenter = 0): SpecPlan | { error: string } {
  const plan: SpecPlan = { groups: [], cubes: [], boxes: {} };
  const used = new Set<string>();
  const twinOf: Record<string, string> = {};
  const claim = (n: string): string | null => {
    if (used.has(n)) return `"${n}" is used twice`;
    if (existing[n] || existingGroups.has(n)) return `"${n}" already exists in the project`;
    used.add(n);
    return null;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const where = `parts[${i}]${p?.name ? ` ("${p.name}")` : ""}`;
    if (!p?.name) return { error: `${where}: name is required.` };
    if (!Array.isArray(p.size) || p.size.length !== 3 || p.size.some((v) => !(typeof v === "number" && v > 0))) return { error: `${where}: size must be 3 positive numbers.` };
    if (p.attach && p.from) return { error: `${where}: give attach or from, not both.` };
    if (p.parent && !plan.boxes[p.parent] && !existingGroups.has(p.parent)) return { error: `${where}: parent "${p.parent}" is neither an earlier part nor an existing group.` };

    let min: Vec3;
    if (p.attach) {
      const ref = plan.boxes[p.attach.to] ?? existing[p.attach.to];
      if (!ref) return { error: `${where}: attach.to "${p.attach.to}" is neither an earlier part nor an existing element.` };
      if (!(SIDES as readonly string[]).includes(p.attach.side)) return { error: `${where}: attach.side must be one of ${SIDES.join(", ")}.` };
      if (p.attach.align !== undefined && !isAlignSpec(p.attach.align)) return { error: `${where}: attach.align must be one of ${ALIGNS.join(", ")}, or per axis like { y: "min" }.` };
      min = placementDelta({ min: [0, 0, 0], max: p.size }, ref, p.attach.side, { gap: p.attach.gap, align: p.attach.align, offset: p.attach.offset });
    } else if (p.from) min = p.from;
    else min = [-p.size[0] / 2, 0, -p.size[2] / 2];
    const box: Box = { min: roundVec(min), max: roundVec(min.map((v, k) => v + p.size[k])) };
    if (typeof p.pivot === "string" && !(ANCHORS as readonly string[]).includes(p.pivot)) return { error: `${where}: pivot must be an anchor (${ANCHORS.join(", ")}) or [x,y,z].` };
    const pivot: Vec3 = Array.isArray(p.pivot) ? roundVec(p.pivot) : anchorPoint(box, (p.pivot as Anchor) ?? "center");
    const cube = p.cube_name || `${p.name}_cube`;
    const clash = claim(p.name) || claim(cube);
    if (clash) return { error: `${where}: ${clash}.` };
    plan.groups.push({ name: p.name, ...(p.parent ? { parent: p.parent } : {}), origin: pivot, ...(p.rotation ? { rotation: p.rotation } : {}) });
    plan.cubes.push({ name: cube, parent: p.name, from: box.min, to: box.max });
    plan.boxes[p.name] = box;

    if (p.mirror === "x") {
      const twin = mirroredName(p.name, 0);
      if (twin === p.name) return { error: `${where}: mirror needs a side in the name (left/right, L/R) so the twin gets its own name.` };
      const twinCube = p.cube_name ? mirroredName(p.cube_name, 0) : `${twin}_cube`;
      if (twinCube === cube) return { error: `${where}: cube_name needs a side in it too, so the twin's cube gets its own name.` };
      const twinClash = claim(twin) || claim(twinCube);
      if (twinClash) return { error: `${where}: twin ${twinClash}.` };
      const tbox: Box = {
        min: [mirrorCoord(box.max[0], mirrorCenter), box.min[1], box.min[2]],
        max: [mirrorCoord(box.min[0], mirrorCenter), box.max[1], box.max[2]],
      };
      const tparent = p.parent ? (twinOf[p.parent] ?? p.parent) : undefined;
      plan.groups.push({
        name: twin, ...(tparent ? { parent: tparent } : {}), origin: [mirrorCoord(pivot[0], mirrorCenter), pivot[1], pivot[2]],
        ...(p.rotation ? { rotation: [p.rotation[0], -p.rotation[1] + 0, -p.rotation[2] + 0] as Vec3 } : {}),
      });
      plan.cubes.push({ name: twinCube, parent: twin, from: tbox.min, to: tbox.max });
      plan.boxes[twin] = tbox;
      twinOf[p.name] = twin;
    }
  }
  return plan;
}

/** World boxes of every group and cube in a scene tree, by name (rotations included). */
export function sceneBoxes(tree: Pick<SceneTree, "roots">): Record<string, Box> {
  const out: Record<string, Box> = {};
  const toGeo = (n: SceneNode): GeoNode => n.type === "group"
    ? { name: n.name, kind: "group", origin: n.origin, rotation: n.rotation, children: (n.children || []).map(toGeo) }
    : { name: n.name, kind: "cube", origin: n.origin, rotation: n.rotation, from: n.from, to: n.to };
  const walk = (n: SceneNode, chain: Frame[]) => {
    const box = boxOf(worldPoints(toGeo(n), chain));
    if (box) out[n.name] = box;
    if (n.type === "group") for (const c of n.children || []) walk(c, [{ origin: n.origin, rotation: n.rotation }, ...chain]);
  };
  for (const n of tree.roots || []) walk(n, []);
  return out;
}
