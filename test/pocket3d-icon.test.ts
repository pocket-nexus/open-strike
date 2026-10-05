// The app icon on every console is the Pocket3D icon in the PocketJS checkout
// (vendor/pocketjs/engine/pocket3d/icon/). This guard fails when the repository
// tracks an icon file of its own, or when a console build stops reading that
// directory. The procedure is vendor/pocketjs/skills/pocket3d-brand/SKILL.md.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { POCKET3D_ICON } from "../vendor/pocketjs/tools/pocket3d-icon.ts";
import {
  resolveVitaPackageAssets,
  VITA_ICON_VPK_PATH,
  VITA_REQUIRED_SYSTEM_ASSETS,
} from "../vendor/pocketjs/tools/vita-package.ts";

const root = resolve(import.meta.dir, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("Pocket3D app icon", () => {
  test("the pinned PocketJS checkout holds every console's icon", () => {
    for (const path of Object.values(POCKET3D_ICON)) {
      expect(path).toContain("/vendor/pocketjs/engine/pocket3d/icon/");
      expect(existsSync(path)).toBe(true);
    }
  });

  test("the repository tracks no icon file", () => {
    // The listing stops at the vendor/pocketjs gitlink, so the PocketJS
    // checkout's own files are not in it.
    const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
    expect(listing.exitCode).toBe(0);
    const tracked = listing.stdout.toString().split("\0").filter(Boolean);
    expect(tracked).toContain("pocket.json");
    // ICON0.png, icon0.png, a 3DS icon.png / icon-small.png / icon.svg, a
    // bundle's Icon.png / Icon@2x.png.
    const icons = tracked.filter((path) =>
      /^icon[^/]*\.(png|svg|jpe?g|gif|bmp|ico|icns)$/i.test(basename(path)),
    );
    expect(icons).toEqual([]);
  });

  test("PSP: Psp.toml names psp/ICON0.PNG as the XMB icon", () => {
    const manifest = "crates/openstrike-psp/Psp.toml";
    const icon = read(manifest).match(/^xmb_icon_png\s*=\s*"([^"]+)"/m)?.[1];
    expect(icon).toBeDefined();
    // cargo-psp reads the path from the crate directory.
    expect(resolve(root, dirname(manifest), icon!)).toBe(resolve(POCKET3D_ICON.psp));
  });

  test("PS Vita: the packager is given vita/icon0.png and the LiveArea stays complete", () => {
    expect(read("scripts/vita.ts")).toMatch(/\bicon:\s*POCKET3D_ICON\.vita\b/);
    expect(read("scripts/e2e-vita.ts")).toMatch(/\bPOCKET3D_ICON\.vita\b/);
    // The same resolver scripts/vita.ts packages through: it rejects an icon
    // that is not a 128 x 128 indexed PNG.
    const assets = resolveVitaPackageAssets({ icon: POCKET3D_ICON.vita });
    const destinations = new Set(assets.map((asset) => asset.destination));
    for (const path of VITA_REQUIRED_SYSTEM_ASSETS) expect(destinations.has(path)).toBe(true);
    expect(assets.find((asset) => asset.destination === VITA_ICON_VPK_PATH)?.source).toBe(
      POCKET3D_ICON.vita,
    );
  });

  test("Nintendo 3DS: the SMDH is built from both sizes", () => {
    const build = read("scripts/3ds.ts");
    expect(build).toMatch(/\bICON:\s*containerPath\(POCKET3D_ICON\.n3ds\)/);
    expect(build).toMatch(/\bSMALL_ICON:\s*containerPath\(POCKET3D_ICON\.n3dsSmall\)/);
  });

  test("iPod touch: the app descriptor names ios/Icon@2x.png and the bundle's icon is prerendered", () => {
    const descriptor = "hosts/ipodtouch4/ipodtouch4.json";
    const app = JSON.parse(read(descriptor)) as { projectRoot?: string; icon?: string };
    expect(app.icon).toBeDefined();
    // PocketJS's packager resolves `icon` against the descriptor's projectRoot.
    const projectRoot = resolve(root, dirname(descriptor), app.projectRoot ?? ".");
    expect(resolve(projectRoot, app.icon!)).toBe(resolve(POCKET3D_ICON.ios2x));
    // The bundle takes PocketJS's Info.plist with OpenStrike's identity substituted.
    expect(read("vendor/pocketjs/hosts/ipodtouch4/Info.plist")).toMatch(
      /<key>UIPrerenderedIcon<\/key>\s*<true\/>/,
    );
  });
});
