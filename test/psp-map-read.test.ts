import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const optimized of [false, true]) {
  test(`PSP production map reader (${optimized ? "release" : "debug"})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "openstrike-map-read-"));
    try {
      const binary = join(dir, "map-read");
      const built = Bun.spawnSync([
        "rustc", "--edition=2021", "--test", "crates/openstrike-psp/src/maps/read.rs",
        ...(optimized ? ["-O"] : []), "-o", binary,
      ], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
      expect(built.exitCode, `${built.stdout}${built.stderr}`).toBe(0);
      const ran = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
      expect(ran.exitCode, `${ran.stdout}${ran.stderr}`).toBe(0);
      expect(ran.stdout.toString()).toContain("10 passed; 0 failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
