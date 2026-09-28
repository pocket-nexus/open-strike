/** Physical-device test driver. Uses the shared toolchain and a fresh USB tunnel;
 * UIKit receives real multi-contact events through a test-only helper process. */
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import {
  ipodtouch4CacheRoot,
  ipodtouch4SysrootPath,
} from "../vendor/pocketjs/tools/ipodtouch4-toolchain.ts";
import {
  shellQuote as q,
  IPOD_INSTALLER,
  parseInstalledIPodApp,
} from "../vendor/pocketjs/tools/ipodtouch4-installation.ts";
const root = resolve(import.meta.dir, "..");
const command = process.argv[2] ?? "read";
const run = (args: string[], input?: string) => {
  const r = Bun.spawnSync(args, {
    cwd: root,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode)
    throw new Error(
      `${args[0]} failed: ${r.stderr.toString()}${r.stdout.toString()}`,
    );
  return r.stdout.toString().trim();
};
const devices = run(["idevice_id", "-l"]).split(/\s+/).filter(Boolean);
const udid =
  process.env.POCKETJS_IPODTOUCH4_UDID ??
  (devices.length === 1 ? devices[0] : undefined);
if (
  !udid ||
  !devices.includes(udid) ||
  run(["ideviceinfo", "-u", udid, "-k", "ProductType"]) !== "iPod4,1"
)
  throw new Error("Select the connected iPod4,1 with POCKETJS_IPODTOUCH4_UDID");
const server = createServer();
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
await new Promise<void>((done) => server.close(() => done()));
const tunnel = Bun.spawn(["iproxy", "-u", udid, `${port}:22`], {
  stdout: "ignore",
  stderr: "ignore",
});
const sshArgs = [
  "-i",
  process.env.POCKETJS_IPODTOUCH4_KEY ??
    join(ipodtouch4CacheRoot(), "ssh/id_rsa"),
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=3",
  "-o",
  "HostKeyAlias=[127.0.0.1]:2224",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${process.env.POCKETJS_IPODTOUCH4_KNOWN_HOSTS ?? join(ipodtouch4CacheRoot(), "ssh/known_hosts")}`,
  "-o",
  "HostKeyAlgorithms=+ssh-rsa",
  "-o",
  "PubkeyAcceptedAlgorithms=+ssh-rsa",
];
const remote = (cmd: string, input?: string) =>
  run(["ssh", ...sshArgs, "-p", String(port), "root@127.0.0.1", cmd], input);
try {
  for (let i = 0; ; i++) {
    try {
      remote("true");
      break;
    } catch (e) {
      if (i === 15) throw e;
      await Bun.sleep(100);
    }
  }
  if (remote("uname -m") !== "iPod4,1")
    throw new Error("USB tunnel model mismatch");
  const app = parseInstalledIPodApp(
    remote(`${IPOD_INSTALLER} lookup dev.pocket-stack.openstrike.ipod`),
    "dev.pocket-stack.openstrike.ipod",
    "OpenStrike.app",
  );
  const base = app.Container;
  if (command === "read")
    console.log(
      remote(
        `cat ${q(base + "/tmp/pocketjs.status")} ${q(base + "/tmp/openstrike-game.json")}`,
      ),
    );
  else {
    const out = resolve(root, ".pocket-build/validation/ipod-touch/input");
    mkdirSync(out, { recursive: true });
    const native = resolve(
      root,
      "vendor/pocketjs/.pocket-build/ipodtouch4/openstrike/runtime",
    );
    const obj = join(out, "contacts.o"),
      binary = join(out, "contacts");
    run([
      "xcrun",
      "clang",
      "-target",
      "armv7-apple-ios6.0",
      "-march=armv7",
      "-Os",
      "-fno-stack-protector",
      "-fno-builtin",
      "-isysroot",
      run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]),
      "-Wno-incompatible-sysroot",
      "-c",
      "test/fixtures/ipod-contacts.c",
      "-o",
      obj,
    ]);
    run([
      "xcrun",
      "ld-classic",
      "-arch",
      "armv7",
      "-syslibroot",
      ipodtouch4SysrootPath(),
      "-L/usr/lib",
      "-iphoneos_version_min",
      "6.0",
      "-no_pie",
      "-no_uuid",
      "-no_function_starts",
      "-no_data_in_code_info",
      "-no_source_version",
      "-no_compact_unwind",
      "-no_adhoc_codesign",
      "-no_encryption",
      "-e",
      "start",
      "-o",
      binary,
      join(native, "csu-start.o"),
      join(native, "csu-dyld-glue.o"),
      join(native, "crt_globals.o"),
      obj,
      "-lSystem",
      "-lgcc_s.1",
    ]);
    run(["ldid", "-S", binary]);
    const device = "/var/root/Library/PocketJS/openstrike-ipod-contacts";
    run([
      "scp",
      "-O",
      ...sshArgs,
      "-P",
      String(port),
      binary,
      `root@127.0.0.1:${device}`,
    ]);
    remote(`chmod 755 ${device}`);
    if (command === "verify") {
      const { verifyIPod } = await import("./ipod-check.ts");
      await verifyIPod({
        base,
        udid,
        remote,
        play: (frames) => {
          remote(device, frames);
        },
      });
    } else {
      let frames: string;
      if (command === "tap") {
        const [x, y, ms = 150] = process.argv.slice(3).map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error("tap x y [hold_ms]");
        frames = `0 1 0 ${x} ${y} 1\n${ms} 1 0 ${x} ${y} 0\n`;
      } else if (command === "sequence")
        frames = readFileSync(resolve(process.argv[3]!), "utf8");
      else
        throw new Error(
          "Usage: ipod-device.ts read | tap x y [hold_ms] | sequence <contact-frames.txt>",
        );
      console.log(remote(device, frames));
    }
  }
} finally {
  tunnel.kill();
  await tunnel.exited;
}
