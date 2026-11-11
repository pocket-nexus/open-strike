import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { withDeviceLease } from "../vendor/pocketjs/tools/device-lease";

test("both 3DS deployment entry points inherit a parent lease and reject another worktree", async () => {
  const root=resolve(import.meta.dir,"..");
  await withDeviceLease("3ds:wire", async lease => {
    for(const command of [[process.execPath,"scripts/deploy-3ds.ts","--help"],["python3","scripts/deploy-3ds.py","--help"]]) {
      const blocked=Bun.spawnSync(command,{cwd:root,env:{...process.env,POCKET_DEVICE_LEASES:"{}"}});
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr.toString()).toContain("Device busy");
      const inherited=Bun.spawnSync(command,{cwd:root,env:lease.environment});
      expect(inherited.exitCode).toBe(0);
      expect(inherited.stdout.toString()).toContain("--host");
    }
    lease.assertHeld();
  });
});
