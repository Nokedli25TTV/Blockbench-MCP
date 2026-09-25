// Contact sheets for capture_screenshot: several angles and/or animation frames in one
// image. The named views follow the placement convention — the model faces north (−Z),
// so "front" looks at its north side and "left" at its own left (−X).
import type { Vec3 } from "./types";

export const VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso", "iso_back"] as const;
export type View = (typeof VIEWS)[number];

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Unit direction from the model's centre to the camera for a named view. */
export function viewDirection(view: View): Vec3 {
  switch (view) {
    case "front": return [0, 0, -1];
    case "back": return [0, 0, 1];
    case "left": return [-1, 0, 0];
    case "right": return [1, 0, 0];
    // Straight down / up, nudged toward the front so the camera's up axis stays defined
    // and the model's front is at the bottom of the picture.
    case "top": return unit([0, 1, -0.002]);
    case "bottom": return unit([0, -1, -0.002]);
    case "iso": return unit([-1, 0.8, -1]); // its front, its left side and the top
    case "iso_back": return unit([1, 0.8, 1]);
  }
}

/** How far a camera with a `fovDeg` view must stand to fit a sphere of `radius`, with a margin. */
export function fitDistance(radius: number, fovDeg: number, margin = 1.12): number {
  const fov = Math.max(10, Math.min(120, fovDeg || 45));
  return (Math.max(radius, 0.5) / Math.sin((fov * Math.PI) / 360)) * margin;
}

/**
 * Grid of a sheet: frames as rows and views as columns when both are given; otherwise one
 * row for up to three pictures and a near-square grid for more.
 */
export function sheetLayout(views: number, times: number): { cols: number; rows: number } {
  if (views > 0 && times > 0) return { cols: views, rows: times };
  const n = Math.max(views, times, 1);
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

/** Side of one square cell so the whole sheet stays within `maxSize` px. */
export function sheetCell(cols: number, rows: number, maxSize: number, gap = 4): number {
  const n = Math.max(cols, rows);
  return Math.max(64, Math.floor((maxSize - gap * (n + 1)) / n));
}
