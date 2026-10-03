// One lease covers the complete FTP publication/readback, including the Python child.
import { resolve } from "node:path";
import { guardDeviceCommand } from "../vendor/pocketjs/tools/device-lease.ts";
const lease = await guardDeviceCommand("3ds:wire");
lease.assertHeld();
const child = Bun.spawn(["python3", resolve(import.meta.dir, "deploy-3ds.py"), "--under-device-lease", ...Bun.argv.slice(2)],
  { env: lease.environment, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", stop);
try { process.exitCode = await child.exited; lease.assertHeld(); }
finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("exit", stop); }
