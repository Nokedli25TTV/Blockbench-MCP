# Átadás a PC-s Claude Code-nak — Blockbench-MCP, a 0.6.0 előtt

## Context

A felhős munkamenetben három új funkció és egy hibajavítás készült el a 0.5.0 után. Mind a 11 mock-tesztcsomag
zöld, de **egyik sincs kipróbálva valódi Blockbenchben vagy Minecraftban**; a felhőből ezek nem érhetők el.
A PC-s Claude Code dolga:
1. élőben letesztelni mindent;
2. kijavítani, amit a teszt talál;
3. kiadni a 0.6.0-t;
4. utána folytatni a fejlesztést.

---

## 1. Mi készült a felhős munkamenetben

Minden a `claude/zen-keller-h60dvg` ágon van (GitHub-fork), a v0.5.0-ra (59d9755) építve. A kód állapota
ca9ff55; utána már csak ez a `HANDOFF.md` került fel.

| Commit | Mi |
|---|---|
| 1f0a636 | **`export_bundle`**: modell (`.geo.json`) + animációk (`.animation.json`) + textúra (`.png`) egy hívással a mod `assets/<mod_id>` mappáiba, GeckoLib 4 vagy 5 szerint (részletek lent). Mellette a `validate_model for_export` ellenőrzése közös függvény lett (`exportPreflight`), és a híd 1 MB helyett 64 MB-os plugin-válaszokat fogad. |
| 547b59f | **`measure`**: részek világdoboza, és páronként az oldal, a rés, az érintkezés vagy az átfedés mélysége; `time`-mal az animáció adott pillanatában. **Új plugin-kezelő is.** |
| 7fe3517 | (a PC-n készült, a munkamenet alatt feltöltve) **`create_from_spec template`**: humanoid / quadruped / sword, `scale`-lel. |
| b1a68fc | A sablonok beolvasztása; két ütközés, mindkét oldal megmaradt. |
| 458c484 | **Lánc-sablon**: `template:"chain"` + `segments` (2–16): farok, csáp, kígyó. |
| ca9ff55 | README: az eszköztáblából a 0.5.0 óta hiányzó eszközök pótolva. |

**Az `export_bundle` röviden:**
- **Mappák:**
  - GeckoLib 4 (MC ≤ 1.21.4): `geo/<kind>/`, `animations/<kind>/`, `textures/<kind>/`.
  - GeckoLib 5 (MC ≥ 1.21.5): `geckolib/models/<kind>/`, `geckolib/animations/<kind>/`, a textúra marad.
  - A `minecraft_version` alapja a `BLOCKBENCH_MCP_MC_VERSION` (1.20.1). A `geckolib:"4"|"5"` felülírja.
- **`mod_dir`:** a mod projektje, a `src/main/resources`, vagy maga az `assets/<mod_id>`. A `mod_id`-t kitalálja,
  ha csak egy mod van benne (az `assets/minecraft` nem számít).
- **Fájlnév:** a `name`, vagy a geometry identifier.
- **Kapu:** hiba esetén semmit sem ír (a `force` átlép rajta). Ha egy meglévő fájl változna, nem ír (az
  `overwrite:true` felülírja); az azonos tartalmú fájl „unchanged”.
- **Írás:** a szerver írja ki a fájlokat, ideiglenes fájlon és átnevezésen keresztül.

**Új fájlok:**
- `packages/shared/src/modAssets.ts`, `measure.ts`, `templates.ts`;
- `apps/mcp-server/test/bundle.test.mjs`, `measure.test.mjs`.

**Módosult:**
- `apps/mcp-server/src/index.ts`;
- `apps/mcp-plugin/src/mcp_socketio_plugin.ts` (a `measure` kezelő);
- `test/harness.mjs` (mock), `test/spec.test.mjs`;
- CHANGELOG (Unreleased), README, ARCHITECTURE, skillek.

Eszközszám: `geckolib` profil 76, `full` 126.

---

## 2. Mit teszteljen a PC-s Claude Code

### 2.0 Előkészítés (cmd)

```
cd C:\Projekts\BlockBench\blockbench-mcp
git switch feat/blockbench-mcp-tool-port
git fetch github
git merge --ff-only github/claude/zen-keller-h60dvg
pnpm install
pnpm build
pnpm test
```

- **A `pnpm test` Windowson fontos.** A CI ezekre a commitokra még nem futott, mert csak a `main`-re és PR-re
  indul. Mind a 11 csomagnak „PASSED”-nek kell lennie; a `test:bundle` valódi Windows-mappákba ír.
- **Újraindítás:** a build után indítsd újra a Claude Code-ot, mert a szerver induláskor töltődik be. A
  Blockbenchben töltsd újra a plugint (File → Plugins), mert a plugin is változott (`measure`).
- **Ellenőrzés:** a `get_project_info` → `plugin_build` az új commitot mutatja, a `tool_count` eggyel nőtt.

### 2.1 Élő tesztforgatókönyv (a várt eredménnyel)

**A. Sablonok**
1. `create_project format:"geckolib" name:"test_mob" model_identifier:"test_mob"`.
2. `create_from_spec template:"humanoid"` → 6 csont / 6 kocka.
   Ellenőrzés: `capture_screenshot views:["front","left","iso"]` → a fej a testen, a karok vállmagasságban, a lábak alatta.
3. `dry_run`-nal:
   - `template:"quadruped" scale:0.5` → 7 csont;
   - `template:"sword"` → 4 csont;
   - `template:"chain" segments:5` → 5 csont, mindegyik „(in segment_k)”.
4. Farok a humanoidra:
   - `create_from_spec template:"chain" segments:4`;
   - `place_relative target:"segment_1" ref:"body" side:"back"`;
   - `measure targets:["segment_1_cube","body_cube"]` → „back, touching on z”;
   - `reparent_element id:"segment_1" parent:"body"`.

**B. measure (nyugalmi helyzet)**
5. `measure targets:["arm_left_cube","body_cube"]` → az `arm_left_cube` doboza `[-8, 12, -2]→[-4, 24, 2]`, és „left, touching on x”.
   A Blockbenchben kijelölve ugyanez a from/to.
6. `measure targets:["head","body"]` → a `body` csoport doboza tartalmazza a fejet: „head/ → body/: inside”.
7. `set_rotation target:"arm_left" rotation:[0,0,90]`, majd `measure targets:["arm_left_cube","body_cube"]`
   → `[-6, 22, -2]→[6, 26, 2]`, „OVERLAPPING — 2 deep on y”. Utána `undo`.
8. `measure` célpont nélkül → az egész modell doboza; egyezzen a 3D-nézettel.

**C. Animáció + measure `time`**
9. `pack_uv` → `validate_uv` → `create_texture name:"skin"` → `apply_texture` a gyökércsoportokra
   (body, leg_left, leg_right) → `shade_cubes`.
10. `generate_animation kind:"walk"`.
11. `measure targets:["leg_left_cube","body_cube"] time:0.25`, majd `time:0.75`:
    - a „Measured at …s of animation.walk” sorral kezdődik;
    - a láb doboza a két időpontban ellentétes irányba lendül;
    - utána az idővonal visszaáll oda, ahol volt.
12. Egy Java-projektben (`create_project format:"java"`) a `measure time:0.5` → `[FORMAT_UNSUPPORTED]`.

**D. Export**
13. `validate_model for_export:true` → READY; az utolsó sor: „Next: export_bundle …”.
14. `export_bundle mod_dir:"<a mod projektje>" dry_run:true` → mind „new”:
    - `assets/<modid>/geo/entity/test_mob.geo.json`;
    - `animations/entity/test_mob.animation.json`;
    - `textures/entity/test_mob.png`.
15. Élesben, majd a fájlok megnyitása:
    - a `.geo.json` identifierje `geometry.test_mob`;
    - az `.animation.json`-ben ott az `animation.walk`;
    - a `.png` a festett textúra.
16. Még egyszer → mind „unchanged”.
17. Egy második animáció után (`generate_animation kind:"idle"`):
    - az `export_bundle` `[DUPLICATE_NAME]` hibát ad, és csak az `.animation.json`-t sorolja fel;
    - `overwrite:true`-val lecseréli („replaced”).
18. A Blockbench saját exportja (File → Export → Bedrock Geometry) egyezzen a `.geo.json`-nal.
19. `capture_screenshot max_size:0` → nincs timeout és szétkapcsolás (az 1 MB-os javítás).

**E. Játékban (Forge 1.20.1, GeckoLib 4.7)**
20. A modban egy entitás renderere
    `new DefaultedEntityGeoModel<>(new ResourceLocation(MODID, "test_mob"))`-t használ, és a kontroller az
    `animation.walk`-ot játssza. `runClient` → megidézve textúrázott, és sétál.

### 2.2 Amit különösen figyelj

- **Rétegzett textúra:** az `export_bundle` a `get_texture` data URL-jét írja ki. Rétegzett textúránál ellenőrizd, hogy a PNG az összes réteget tartalmazza.
- **Ha a játékban furán mozog az animáció** (tükrözött forgás):
  - hasonlítsd össze az `.animation.json`-t egy, a GeckoLib Blockbench-pluginnal exportálttal;
  - az a fájl `"geckolib_format_version": 2`-t tartalmazhat, a mi `export_animations`-ünk nem ír ilyet;
  - ez nincs ellenőrizve, csak gyanú.
- **Animate fül:** a `measure time` (a `get_bone_pose`-hoz hasonlóan) átvált az Animate fülre. Ez várt mellékhatás.
- **Windows-útvonalak:** a mappakeresés (`resolveModAssets` az `index.ts`-ben) a `node:path`-ra épül. A
  `mod_dir`-t a mod valódi útvonalával próbáld ki, `C:\...` formában is.

### 2.3 Ha valami hibás

Javítsd a `feat/blockbench-mcp-tool-port` ágon:
- mock-teszttel, ha reprodukálható;
- `pnpm build && pnpm typecheck && pnpm test`;
- a commit üzenetébe: „Live on Blockbench 5.x: …”;
- push: `git push github feat/blockbench-mcp-tool-port`.

---

## 3. Hogyan folytassa

### 3.1 Kiadás 0.6.0 (ha az élő teszt rendben van)

```
git rm HANDOFF.md
git commit -m "Remove the 0.6.0 handoff"
git status
pnpm bump minor --dry-run
pnpm bump minor
git push github HEAD:main --follow-tags
git push github --delete rig-templates claude/zen-keller-h60dvg
```

- A `git status` legyen üres; a bump a nyomon nem követett fájlokra is megáll.
- A GitHubon a Release workflow elkészíti a v0.6.0 **draft** kiadást; átnézés után *Publish*.

### 3.2 Munkarend (a repó szokásai)

**Git:**
- A munka a `feat/blockbench-mcp-tool-port` ágon folyik.
- **Push csak a `github` remote-ra** (a fork). Az `origin` az eredeti projekt (enfp-dev-studio), a helyi
  `main` is azt követi: oda soha nem megy push.

**Új eszköz:**
- A `registerTool` az `apps/mcp-server/src/index.ts`-ben (ha kell, `READ_ONLY_TOOLS` / `TOOL_TIMEOUTS` is).
- Ha Blockbench kell hozzá: plugin-kezelő + dispatch-bejegyzés az `apps/mcp-plugin/src/mcp_socketio_plugin.ts`-ben,
  és a `ToolType` a `packages/shared/src/types.ts`-ben.
- A csak szerveroldali eszközök meglévő plugin-parancsokat hívnak (minta: `export_bundle`, `create_from_spec`,
  `generate_animation`).

**Tiszta logika és tesztek:**
- A tiszta logika a `packages/shared/src/*.ts`-be kerül. Egymást `.ts` kiterjesztéssel importálják, mert a
  tesztek Node-ban közvetlenül futtatják.
- Minden modulhoz saját teszt tartozik: `apps/mcp-server/test/<x>.test.mjs`. A `test:<x>` szkriptet **mindkét**
  `package.json`-be fel kell venni (a gyökér `test` láncába is). A mock kezelő a `test/harness.mjs`-ben van.

**Hibaüzenetek:** a `[KÓD]`-ot az `errorCode()` a szövegből képzi:
- „not found” → NOT_FOUND;
- „must be” / „required” / „invalid” → INVALID_INPUT;
- „already exists” → DUPLICATE_NAME;
- „unsupported” / „does not support” → FORMAT_UNSUPPORTED.

**Minden változásnál:**
- egy sor a CHANGELOG `[Unreleased]` alá;
- új eszköznél a README eszköztábla és az eszközszámok, az ARCHITECTURE eszközszám, és a skillek
  (`blockbench-use`, `blockbench-mcp-overview`, a szakterületi skill).

**Ellenőrzés:**
- `pnpm build && pnpm typecheck && pnpm test`.
- Élőben: ha a szerver változott, a kliens újraindítása; ha a plugin, a plugin újratöltése; utána a `plugin_build` ellenőrzése.

**Verziók:** új eszköz vagy paraméter → minor; javítás → patch (`pnpm bump`).

### 3.3 Következő funkciók

A „tool plan” rangsora ezzel teljes. A tudatosan kihagyottak: lock_uvs, uv_snapshot, repair_uvs,
validate_animation, rotate_multiaxis, normalize_rotations, export_manifest, create_glowmask.

Javaslatok; a sorrendről a felhasználó dönt:
1. **`generate_animation` új fajtái:** `attack` (egyszer lejátszva: kar- vagy fejcsapás) és `death` (eldőlés, az utolsó kocka marad).
2. **`import_bundle`:** a mod `.geo.json` + `.animation.json` + `.png` fájljai vissza egy új GeckoLib-projektbe
   szerkesztésre — az `export_bundle` párja.
3. **Az `export_bundle` Java block/item modellekre:** `models/block|item/<név>.json` + textúra, a textúra-hivatkozás `<modid>:block/<név>`.
4. Apró dokumentációs adósság: a `MODELING_CONSTRAINTS.md` „Tool roadmap” táblája elavult (`list_outliner`, `set_uv`).
