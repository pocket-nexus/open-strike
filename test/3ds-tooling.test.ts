import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prepareHost, threeDsManifest } from "../scripts/3ds.ts";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import {
  validateAndResolveBuildPlan,
  extractHostBuildInputs,
} from "@pocketjs/framework/manifest";
const source = JSON.parse(
  readFileSync(new URL("../pocket.json", import.meta.url), "utf8"),
);
describe("OpenStrike display capability contract", () => {
  test("the pinned upstream host accepts the native lifecycle patch", async () => {
    // This checks all patch context against the actual pinned source. An
    // upstream update cannot silently leave a partially integrated host.
    const path = await prepareHost();
    expect(readFileSync(`${path}/src/main.c`, "utf8")).toContain(
      "pocket_extension_prepare()",
    );
  });
  test("3DS projection retains product identity and native dual-screen geometry", () => {
    const before = JSON.stringify(source);
    const manifest = threeDsManifest(source);
    const plan = resolve3dsBuildPlan(manifest);
    expect(plan.app.id).toBe(source.id);
    expect(plan.features["display.auxiliary"]).toBe(true);
    expect(plan.features["input.touch.auxiliary"]).toBe(true);
    expect(plan.features["io.offload"]).not.toBe(true);
    expect(
      extractHostBuildInputs(plan, { expectedTarget: "3ds-dev" }).target,
    ).toBe("3ds-dev");
    expect(manifest.app.viewport.fixed.logical).toEqual([400, 240]);
    expect(manifest.app.surfaces.auxiliary.fixed.logical).toEqual([320, 240]);
    expect(JSON.stringify(source)).toBe(before);
  });
  for (const target of ["psp", "vita"])
    test(`${target} keeps its existing viewport with no auxiliary dependency`, () => {
      const result = validateAndResolveBuildPlan(source, { target });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(result.plan.features["display.auxiliary"]).toBe(false);
      expect(result.plan.features["input.touch.auxiliary"]).toBe(false);
    });
  test("auxiliary surface and capability cannot drift apart", () => {
    const manifest = threeDsManifest(source);
    delete (manifest.app as { surfaces?: unknown }).surfaces;
    expect(() => resolve3dsBuildPlan(manifest)).toThrow();
  });
});
