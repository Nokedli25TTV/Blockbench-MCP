// Rig templates for create_from_spec: ready part lists (humanoid, quadruped, sword) scaled
// to whole units. The model faces north (−Z) with its own left at −X; limbs pivot at their
// top (hip, shoulder), heads at the neck. Extra parts can attach to the template's parts.
import type { SpecPart } from "./spec.ts"; // with the extension: the tests run this file in Node directly
import type { Vec3 } from "./types";

export const TEMPLATES = ["humanoid", "quadruped", "sword"] as const;
export type Template = (typeof TEMPLATES)[number];

/** The template's parts at `scale` (1 = Minecraft proportions: a 32-unit humanoid). */
export function templateParts(template: Template, scale = 1): SpecPart[] {
  const s = (n: number) => Math.max(1, Math.round(n * scale));
  const v = (x: number, y: number, z: number): Vec3 => [s(x), s(y), s(z)];
  switch (template) {
    case "humanoid": {
      const body = v(8, 12, 4);
      return [
        { name: "body", size: body, from: [-body[0] / 2, s(12), -body[2] / 2], pivot: "bottom" },
        { name: "head", size: v(8, 8, 8), parent: "body", attach: { to: "body", side: "on_top" }, pivot: "bottom" },
        { name: "arm_left", size: v(4, 12, 4), parent: "body", attach: { to: "body", side: "left", align: { y: "max" } }, pivot: "top", mirror: "x" },
        { name: "leg_left", size: v(4, 12, 4), attach: { to: "body", side: "below", align: { x: "min" } }, pivot: "top", mirror: "x" },
      ];
    }
    case "quadruped": {
      const body = v(8, 8, 16), leg = v(3, 8, 3);
      return [
        { name: "body", size: body, from: [-body[0] / 2, leg[1], -body[2] / 2], pivot: "center" },
        { name: "head", size: v(6, 6, 6), parent: "body", attach: { to: "body", side: "front", align: { y: "max" }, gap: -1 }, pivot: "back" },
        { name: "leg_front_left", size: leg, attach: { to: "body", side: "below", align: { x: "min", z: "min" } }, pivot: "top", mirror: "x" },
        { name: "leg_back_left", size: leg, attach: { to: "body", side: "below", align: { x: "min", z: "max" } }, pivot: "top", mirror: "x" },
        { name: "tail", size: v(2, 2, 6), parent: "body", attach: { to: "body", side: "back", align: { y: "max" } }, pivot: "front" },
      ];
    }
    case "sword": {
      const grip = v(2, 6, 2);
      return [
        { name: "grip", size: grip, from: [-grip[0] / 2, 0, -grip[2] / 2], pivot: "center" },
        { name: "guard", size: v(8, 1, 2), parent: "grip", attach: { to: "grip", side: "on_top" }, pivot: "center" },
        { name: "blade", size: v(2, 16, 1), parent: "grip", attach: { to: "guard", side: "on_top" }, pivot: "bottom" },
        { name: "pommel", size: v(4, 2, 4), parent: "grip", attach: { to: "grip", side: "below" }, pivot: "center" },
      ];
    }
  }
}
