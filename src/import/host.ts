// The app's files and store, over the host channel (the engine's docs/RUNTIME.md "Files"): what the player picks
// (read only) and the app's own storage for this game on this device. Requests are messages, answers come back as
// messages; a request is a `Pending` that the answer settles. Nothing here waits: a job (sliced.ts) yields the
// Pending and is stepped again once it is settled, so this works in a runtime that runs no promise callbacks too.
//
// An app lists the families it implements in its `launch` message (`caps`); a game must not wait for an answer an
// app will never give, so `can("files")` / `can("store")` come first.
import { host } from "@threert/gameplay";

/** A request to the app, settled by its answer. */
export class Pending<T> {
  done = false;
  ok = false;
  value: T | undefined;
  /** Why it failed: "canceled", "busy", "unsupported", "denied", "absent", "quota", "too large", or a sentence. */
  reason = "";

  settle(ok: boolean, value: T | undefined, reason = ""): void {
    if (this.done) return;
    this.done = true;
    this.ok = ok;
    this.value = value;
    this.reason = reason;
  }

  /** The answer; throws (with the reason) when the request failed. */
  result(): T {
    if (!this.done) throw new Error("not answered yet");
    if (!this.ok) throw new HostError(this.reason || "failed");
    return this.value as T;
  }
}

export class HostError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "HostError";
    this.reason = reason;
  }
}

export interface Entry { path: string; size: number }
export interface Picked { pick: string; name: string; entries: Entry[] }

type Answer = { t: string; id?: unknown; ok?: unknown; reason?: unknown; [k: string]: unknown };

const waiting = new Map<string, { p: Pending<any>; take: (m: Answer) => unknown }>();
let n = 0;
let launchCaps: string[] | null = null;

function answer(m: Answer): void {
  const key = String(m.id);
  const w = waiting.get(key);
  if (!w) return;
  waiting.delete(key);
  if (m.ok === true) w.p.settle(true, w.take(m));
  else w.p.settle(false, undefined, typeof m.reason === "string" && m.reason ? m.reason : `${m.t}: failed`);
}
for (const t of ["files.picked", "files.data", "store.done", "store.data", "store.listed"]) host.on(t, (m) => answer(m as Answer));
// (An engine whose `host` has no `caps` yet: the launch message says them all the same.)
host.on("launch", (m) => {
  const caps = (m as { caps?: unknown }).caps;
  if (Array.isArray(caps)) launchCaps = caps.filter((c): c is string => typeof c === "string");
});

/** The app implements this family of messages (its launch message listed it). */
export function can(family: "files" | "store"): boolean {
  const caps = (host as { caps?: unknown }).caps;
  const list = Array.isArray(caps) && caps.length ? caps : launchCaps;
  return Array.isArray(list) && list.includes(family);
}

function ask<T>(message: { t: string; [k: string]: unknown }, take: (m: Answer) => T): Pending<T> {
  const p = new Pending<T>();
  const id = `os${++n}`;
  waiting.set(id, { p, take });
  if (!host.post({ ...message, id })) {
    waiting.delete(id);
    p.settle(false, undefined, "unsupported");
  }
  return p;
}

const entries = (v: unknown): Entry[] =>
  (Array.isArray(v) ? v : []).filter((e): e is Entry => !!e && typeof e.path === "string" && typeof e.size === "number");

export const files = {
  /** The player chooses a folder (or files); `reason` "canceled" when they closed the picker. */
  pick(o: { mode: "folder" | "files"; accept?: string[]; title?: string }): Pending<Picked> {
    return ask({ t: "files.pick", ...o }, (m) => ({ pick: String(m.pick), name: String(m.name ?? ""), entries: entries(m.entries) }));
  },
  /** A picked file, whole, as base64 (decoded by the job, a slice at a time: bytes.ts `fromBase64`). */
  read(pick: string, path: string): Pending<string> {
    return ask({ t: "files.read", pick, path }, (m) => String(m.data ?? ""));
  },
};

export const store = {
  write(path: string, content: { data: string } | { text: string }): Pending<true> {
    return ask({ t: "store.write", path, ...content }, () => true as const);
  },
  readText(path: string): Pending<string> {
    return ask({ t: "store.read", path, as: "text" }, (m) => String(m.text ?? ""));
  },
  list(prefix?: string): Pending<Entry[]> {
    return ask({ t: "store.list", ...(prefix ? { prefix } : {}) }, (m) => entries(m.entries));
  },
  remove(path: string): Pending<true> {
    return ask({ t: "store.remove", path }, () => true as const);
  },
  /** The scene's name for a stored file. */
  uri(path: string): string {
    return `user:${path}`;
  },
};
