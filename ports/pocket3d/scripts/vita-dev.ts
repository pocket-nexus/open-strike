// OpenStrike's native build and PocketJS's shared USB debugging CLI.
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const command = args[0];
if (!command || args.includes("--help")) {
  console.log(`OpenStrike wired development
  bun run vita:dev build [--mod path/to/mod.json]
  bun run vita:dev install --mount /Volumes/PSV
  bun run vita:dev serve
  bun run vita:dev status|push|watch|capture|reload|reset|menu|native

Install stages the VPK; install it in VitaShell and launch OpenStrike.
L + R + SELECT opens the native menu. Native replacement preserves eboot.bin.
Additional flags are passed to PocketJS's shared vita-dev client.`);
} else {
  const argv = command === "build"
    ? ["bun", resolve(root, "scripts/vita.ts"), "--release", ...args.slice(1)]
    : ["bun", resolve(root, "vendor/pocketjs/tools/vita-dev.ts"), ...args,
      "--runtime", resolve(root, "dist/vita/OpenStrike.runtime.json"),
      "--project-root", root,
      "--dir", resolve(root, ".pocket-build/vita-usb/share"),
      "--watch-dir", resolve(root, "game")];
  const child = Bun.spawn(argv, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.exitCode = await child.exited;
}
