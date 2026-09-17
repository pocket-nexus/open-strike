// SPDX-License-Identifier: MIT
import { compilePocketTarget, nativePocketContract } from "./pocket-contract.ts";
const target = process.platform === "darwin" ? "macos-app" : "linux-app";
const inputs = await compilePocketTarget(target);
const env = { ...process.env, ...nativePocketContract(inputs) };
const child = Bun.spawn(["cargo", "build", "--release", "--locked", "-p", "openstrike"], {
  cwd: new URL("..", import.meta.url).pathname, env, stdout: "inherit", stderr: "inherit",
});
if (await child.exited !== 0) process.exit(child.exitCode ?? 1);
