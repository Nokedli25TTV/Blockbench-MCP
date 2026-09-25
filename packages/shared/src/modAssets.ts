// export_bundle: where a GeckoLib model's files go in a mod. GeckoLib's defaulted models
// (DefaultedEntityGeoModel, DefaultedItemGeoModel, DefaultedBlockGeoModel) find them by kind
// and name under assets/<mod_id>/. GeckoLib 5 (Minecraft 1.21.5+) moved models and animations
// into geckolib/; textures stayed where vanilla keeps them. Pure, so it is tested without
// Blockbench or a disk.
import type { SceneNode, SceneTexture, SceneTree } from "./types";
import { versionParts, versionBefore } from "./formatRules.ts"; // with the extension: the tests run this file in Node directly

export const BUNDLE_KINDS = ["entity", "item", "block"] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];
export const BUNDLE_PARTS = ["model", "animations", "texture"] as const;
export type BundlePart = (typeof BUNDLE_PARTS)[number];

/** The GeckoLib class that finds a kind's files from "<mod_id>:<name>". */
export const DEFAULTED_MODEL: Record<BundleKind, string> = {
  entity: "DefaultedEntityGeoModel",
  item: "DefaultedItemGeoModel",
  block: "DefaultedBlockGeoModel",
};

/** GeckoLib's major version on a Minecraft version: 5 from 1.21.5 (GeckoLib 5.0), 4 before. */
export function geckolibFor(minecraftVersion: string): 4 | 5 | null {
  const v = versionParts(minecraftVersion);
  return v ? (versionBefore(v, [1, 21, 5]) ? 4 : 5) : null;
}

/** Each part's path inside assets/<mod_id>/, with "/" between folders. */
export function bundlePaths(geckolib: 4 | 5, kind: BundleKind, name: string): Record<BundlePart, string> {
  const models = geckolib === 5 ? "geckolib/models" : "geo";
  const animations = geckolib === 5 ? "geckolib/animations" : "animations";
  return {
    model: `${models}/${kind}/${name}.geo.json`,
    animations: `${animations}/${kind}/${name}.animation.json`,
    texture: `textures/${kind}/${name}.png`,
  };
}

/** The files' name: the given one, else the geometry identifier — without "geometry." or an extension. */
export function bundleName(name: string | undefined, modelIdentifier: string | null | undefined): string | null {
  const raw = (name ?? modelIdentifier ?? "").trim();
  return raw.replace(/^geometry\./, "").replace(/\.(geo\.json|animation\.json|png)$/, "") || null;
}

// Minecraft refuses a resource location with any other character (a capital, a space) when it loads.
const SEGMENT = /^[a-z0-9_.-]+$/;

/**
 * Why `value` can't name a resource — lowercase a-z, 0-9, _ - . and, with `folders`, / between
 * folders — or null. "." and ".." are refused too: they would climb out of the folder.
 */
export function resourceNameError(value: string, label: string, folders = true): string | null {
  const segments = value.split("/");
  const ok = (folders || segments.length === 1) && segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
  return ok ? null : `${label} "${value}" must be lowercase a-z, 0-9, _ - .${folders ? " (and / between folders)" : ""} — Minecraft refuses other characters in resource names.`;
}

/**
 * The texture to ship. GeckoLib draws a model with ONE texture: the named one (`wanted`: name,
 * name without ".png", or uuid), the only one, or else the one on the most faces. `others` are
 * the textures left out.
 */
export function pickTexture(tree: SceneTree, wanted?: string): { texture: SceneTexture | null; faces: number; others: SceneTexture[] } | { error: string } {
  const textures = tree.textures || [];
  const uses = new Map<string, number>();
  const walk = (nodes: SceneNode[]) => nodes.forEach((n) => {
    if (n.type === "group") return walk(n.children || []);
    for (const f of Object.values(n.faces || {})) if (f && f.texture) uses.set(f.texture, (uses.get(f.texture) || 0) + 1);
  });
  walk(tree.roots || []);
  let texture: SceneTexture | null = null;
  if (wanted !== undefined) {
    texture = textures.find((t) => t.uuid === wanted || t.name === wanted || t.name === `${wanted}.png`) || null;
    if (!texture) return { error: `Texture "${wanted}" not found — the project has ${textures.length ? textures.map((t) => `"${t.name}"`).join(", ") : "no texture"}.` };
  } else {
    for (const t of textures) if (!texture || (uses.get(t.uuid) || 0) > (uses.get(texture.uuid) || 0)) texture = t;
  }
  return { texture, faces: texture ? uses.get(texture.uuid) || 0 : 0, others: textures.filter((t) => t !== texture) };
}
