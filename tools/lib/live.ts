// The game in the engine's headless runner (`threert-render live`), driven by a script: the script is the app of the
// host channel. It sends `launch` (the runner's --launch) and `input` messages, steps frames in lockstep, reads what
// the game posts (the HUD, sounds, `net.*`) and the game's `report` lines.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ENGINE, RENDERER, ROOT } from "./engine.ts";
import { FilesHost } from "./files.ts";
import { join, resolve } from "node:path";

let storeFlag: boolean | null = null;
/** The renderer resolves `user:` assets against a store directory it is given (`--store`; engines from the "Files" change on). */
export function rendererHasStore(): boolean {
  return (storeFlag ??= existsSync(RENDERER) && readFileSync(RENDERER).includes("--store"));
}

/** Where the game's `user:` assets are for this run: the renderer is told (an engine with the "Files" change). */
function storeArgs(store: string | undefined): string[] {
  if (!store) return [];
  if (!rendererHasStore()) throw new Error(`the renderer at ${RENDERER} has no --store: the game's store (imported maps) needs an engine with files and store (docs/RUNTIME.md "Files"); set THREERT_ENGINE to one`);
  return ["--store", resolve(store), "--caps", "files,store"];
}

export interface Post { t: string; [k: string]: any }
export interface Report {
  at: [number, number, number]; v: [number, number, number]; yaw: number; pitch: number; kick: [number, number]; grounded: boolean; crouched: boolean; ladder: boolean; eye: number;
  weapon: string; ammo: number; reserve: number; reloading: number; ads: number; bloom: number; clock: number;
  shots: number; claims: number; confirmed: number; rejects: Record<string, number>;
  status: string; notice: string | null; room: string; code: string | null; mode: string; map: string; time: number;
  me: { id: number; team: string | null; alive: boolean; health: number; kills: number; deaths: number };
  actors: { id: number; name: string; team: string | null; alive: boolean; health: number; kills: number; at: [number, number, number] | null; yaw: number; flags: number; weapon: number }[];
  round: { n: number; phase: string; end: number; winner?: number | string }; score: Record<string, number>; rtt: number;
}

export interface Live {
  p: ChildProcess;
  lines: string[];
  /** Everything the game posted on the host channel, in order. */
  posts: Post[];
  /** Called with each batch of posts as it arrives (a script that is the game's network answers here). */
  onPosts: ((posts: Post[]) => void) | null;
  /** The store and the scripted picks this script answers `files.*` and `store.*` from (with `files`). */
  files: FilesHost | null;
  send(cmd: object): void;
  wait(pred: (l: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Messages of the host channel to the game. */
  host(messages: object[]): void;
  /** An input message (what is held stays held until the next one). */
  input(m: object): void;
  /** Runs `n` frames (lockstep) and waits for them. */
  step(n?: number): Promise<void>;
  report(): Promise<Report>;
  /** The HUD as last described. */
  hud(): any;
  snapshot(path: string, frames?: number): Promise<void>;
  quit(): Promise<void>;
  errors(): string[];
}

/**
 * The game in the headless renderer. `files`: this script is also the app's files and store (a directory as the
 * store, scripted picks; files.ts): the renderer is told (`--caps files,store --store <dir>`) and the requests are
 * answered as they come.
 */
export async function startLive(bundle: string, o: { launch?: object; width?: number; height?: number; dt?: number; lockstep?: boolean; scale?: string; env?: Record<string, string>; args?: string[]; files?: { store: string; picks?: string[] } } = {}): Promise<Live> {
  const args = ["live", bundle, "--assets", ROOT, "--presets", join(ENGINE, "presets"), "--width", String(o.width ?? 640), "--height", String(o.height ?? 360), "--scale", o.scale ?? "0.5", ...storeArgs(o.files?.store), ...(o.args ?? [])];
  if (o.launch) args.push("--launch", JSON.stringify(o.launch));
  const p = spawn(RENDERER, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...o.env } });
  const lines: string[] = [];
  const posts: Post[] = [];
  let waiters: [(l: string) => boolean, (l: string) => void][] = [];
  const files = o.files ? new FilesHost(o.files) : null;
  const live = { onPosts: null, files } as unknown as Live;
  createInterface({ input: p.stdout! }).on("line", (line) => {
    try {
      const batch = (JSON.parse(line) as { host?: Post[] }).host ?? [];
      posts.push(...batch);
      const answers = files ? batch.map((q) => files.answer(q as never)).filter((a) => a !== null) : [];
      if (answers.length) p.stdin!.write(JSON.stringify({ cmd: "host", messages: answers }) + "\n");
      if (batch.length) live.onPosts?.(batch);
    } catch { /* not a line of ours */ }
  });
  createInterface({ input: p.stderr! }).on("line", (l) => {
    lines.push(l);
    waiters = waiters.filter(([pred, res]) => (pred(l) ? (res(l), false) : true));
  });
  const exited = new Promise<void>((r) => p.on("exit", () => r()));
  const wait = (pred: (l: string) => boolean, timeoutMs = 120_000) =>
    new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`live: timed out waiting (${lines.slice(-4).join(" | ")})`)), timeoutMs);
      waiters.push([pred, (l) => (clearTimeout(t), res(l))]);
      void exited.then(() => { clearTimeout(t); rej(new Error(`live: exited (${lines.slice(-6).join(" | ")})`)); });
    });
  const send = (c: object) => void p.stdin!.write(JSON.stringify(c) + "\n");
  let id = 0;
  const first = lines.find((l) => l.includes("fps on")) ? Promise.resolve("") : wait((l) => l.includes("fps on"));
  await first;
  if (o.lockstep !== false) send({ cmd: "lockstep", dt: o.dt ?? 1 / 60 });
  Object.assign(live, {
    p, lines, posts, send, wait,
    host: (messages: object[]) => send({ cmd: "host", messages }),
    input: (m: object) => send({ cmd: "host", messages: [{ t: "input", captured: true, ...m }] }),
    step: async (n = 1) => {
      const sync = `s${++id}`;
      const done = wait((l) => l.includes(`live: sync ${sync}`));
      send({ cmd: "frames", n, sync });
      await done;
    },
    report: async () => {
      const n = lines.length;
      send({ cmd: "event", type: "report" });
      await live.step(1);
      const line = lines.slice(n).map((l) => /osrt (\{.*\})/.exec(l)?.[1]).find((x) => x);
      if (!line) throw new Error(`no report (${lines.slice(-3).join(" | ")})`);
      return JSON.parse(line) as Report;
    },
    hud: () => posts.filter((q) => q.t === "hud").at(-1)?.hud ?? {},
    snapshot: async (path: string, frames = 1) => {
      const done = wait((l) => l.includes("live: snapshot"));
      send({ cmd: "frames", n: frames, snapshot: path });
      await done;
    },
    quit: async () => {
      send({ cmd: "quit" });
      const t = setTimeout(() => p.kill(), 8000);
      await exited;
      clearTimeout(t);
    },
    errors: () => lines.filter((l) => /frame script:|host messages failed|\[game error\]|Error:|error:/i.test(l) && !/osrt /.test(l)),
  });
  return live;
}

export function checker() {
  const failures: string[] = [];
  return {
    check(ok: boolean, what: string) {
      console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
      if (!ok) failures.push(what);
    },
    done(name: string): never {
      if (failures.length) { console.error(`${name}: ${failures.length} check(s) failed`); process.exit(1); }
      console.log(`${name}: all checks pass`);
      process.exit(0);
    },
  };
}
