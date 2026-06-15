import type { SceneNode, SceneTree, Vec3 } from "./types";

// Pure, Blockbench-independent model validation so it can be unit-tested and run
// on the MCP server (over a scene tree fetched from the plugin). See
// MODELING_CONSTRAINTS.md for the rule numbers referenced below.

export interface ValidationIssue {
  severity: "error" | "warning";
  rule:
    | "duplicate-name"
    | "missing-pivot"
    | "invalid-origin"
    | "invalid-geometry"
    | "illegal-cube-rotation"
    | "cube-rotation"
    | "missing-texture"
    | "orphaned-group";
  node?: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  issues: ValidationIssue[];
}

const EPS = 1e-6;

const isFiniteVec3 = (v: any): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && isFinite(n));

const nonZeroAxes = (v: Vec3): number => v.filter((n) => Math.abs(n) > EPS).length;

export function validateScene(tree: SceneTree): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const textureIds = new Set((tree.textures || []).map((t) => t.uuid));
  const nameCounts = new Map<string, number>();

  const visit = (node: SceneNode) => {
    nameCounts.set(node.name, (nameCounts.get(node.name) || 0) + 1);

    if (node.type === "group") {
      if (!isFiniteVec3(node.origin)) {
        issues.push({
          severity: "error",
          rule: "invalid-origin",
          node: node.name,
          message: `Group "${node.name}" has a non-finite origin/pivot.`,
        });
      } else if (nonZeroAxes(node.rotation) > 0 && nonZeroAxes(node.origin) === 0) {
        // Rotating around the world origin almost always indicates a forgotten pivot.
        issues.push({
          severity: "warning",
          rule: "missing-pivot",
          node: node.name,
          message: `Group "${node.name}" is rotated but its pivot/origin is [0,0,0]. Set an explicit origin before rotating (rule #1).`,
        });
      }

      if (!node.children || node.children.length === 0) {
        issues.push({
          severity: "warning",
          rule: "orphaned-group",
          node: node.name,
          message: `Group "${node.name}" is empty (no children). Empty bones add animation ambiguity (rule #6).`,
        });
      }

      (node.children || []).forEach(visit);
    } else {
      // cube
      if (!isFiniteVec3(node.from) || !isFiniteVec3(node.to)) {
        issues.push({
          severity: "error",
          rule: "invalid-geometry",
          node: node.name,
          message: `Cube "${node.name}" has non-finite from/to.`,
        });
      } else {
        for (let i = 0; i < 3; i++) {
          if (node.to[i] < node.from[i]) {
            issues.push({
              severity: "error",
              rule: "invalid-geometry",
              node: node.name,
              message: `Cube "${node.name}" has inverted bounds on axis ${i} (to < from).`,
            });
            break;
          }
        }
      }

      const axes = isFiniteVec3(node.rotation) ? nonZeroAxes(node.rotation) : 0;
      if (axes > 1) {
        issues.push({
          severity: "error",
          rule: "illegal-cube-rotation",
          node: node.name,
          message: `Cube "${node.name}" is rotated on ${axes} axes. A single cube cannot be multi-axis rotated — use nested groups (rule #1).`,
        });
      } else if (axes === 1) {
        issues.push({
          severity: "warning",
          rule: "cube-rotation",
          node: node.name,
          message: `Cube "${node.name}" has a single-axis rotation. Prefer rotating a parent group/bone for animation safety (rule #1/#6).`,
        });
      }

      const faces = node.faces || {};
      for (const face of Object.keys(faces)) {
        const ref = faces[face] && faces[face].texture;
        if (ref && !textureIds.has(ref)) {
          issues.push({
            severity: "error",
            rule: "missing-texture",
            node: node.name,
            message: `Cube "${node.name}" face "${face}" references texture "${ref}" which is not registered (rule #2).`,
          });
        }
      }
    }
  };

  (tree.roots || []).forEach(visit);

  for (const [name, count] of nameCounts.entries()) {
    if (count > 1) {
      issues.push({
        severity: "error",
        rule: "duplicate-name",
        node: name,
        message: `Name "${name}" is used ${count} times. Names must be unique for GeckoLib binding (rule #4).`,
      });
    }
  }

  return issues;
}

export function buildReport(issues: ValidationIssue[]): ValidationReport {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings, issues };
}
