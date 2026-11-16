// The app's side of the host channel's `files.*` and `store.*` (the engine's docs/RUNTIME.md "Files"), for a script
// that is the game's app (app.ts, the tests, shots.ts): a directory as the game's store, and "picks" scripted in
// advance in place of the player choosing a folder in a dialog.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const MAX_READ = 64 * 1024 * 1024;
const QUOTA = 1024 * 1024 * 1024;

type Msg = { t: string; id?: unknown; [k: string]: unknown };
type Body = Record<string, unknown>;

/** Whether a store path is one (relative, `/`-separated, `[A-Za-z0-9._-]` segments, no `.` or `..`, at most 200). */
export function storePathError(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "a store path is a non-empty string";
  if (path.length > 200) return "a store path is at most 200 characters";
  for (const seg of path.split("/")) {
    if (!seg || seg === "." || seg === "..") return `"${path}": no empty, "." or ".." segment`;
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return `"${path}": segments of A-Z a-z 0-9 . _ -`;
  }
  return null;
}

export class FilesHost {
  readonly store: string;
  /** What the next `files.pick` requests get, in order (a folder or a file each); none left: the picker is "canceled". */
  readonly picks: string[];
  private readonly grants = new Map<string, Map<string, string>>();
  private n = 0;
  /** Every request seen, by type (what a test checks the game asked for). */
  readonly seen: Record<string, number> = {};
  /** Bytes the game read of what was picked. */
  bytesRead = 0;

  constructor(o: { store: string; picks?: string[] }) {
    this.store = o.store;
    this.picks = [...(o.picks ?? [])];
    mkdirSync(this.store, { recursive: true });
  }

  /** The answer to a message of the game, or null when it is not one of these families. */
  answer(m: Msg): Msg | null {
    if (!m.t.startsWith("files.") && !m.t.startsWith("store.")) return null;
    this.seen[m.t] = (this.seen[m.t] ?? 0) + 1;
    const id = m.id;
    try {
      switch (m.t) {
        case "files.pick": return { t: "files.picked", id, ...this.pick(m) };
        case "files.read": return { t: "files.data", id, ...this.read(m) };
        case "store.write": return { t: "store.done", id, ...this.write(m) };
        case "store.read": return { t: "store.data", id, ...this.readStore(m) };
        case "store.list": return { t: "store.listed", id, ok: true, entries: this.list(typeof m.prefix === "string" ? m.prefix : "") };
        case "store.remove": return { t: "store.done", id, ...this.remove(m) };
      }
    } catch (e) {
      return { t: m.t.startsWith("files.") ? (m.t === "files.pick" ? "files.picked" : "files.data") : m.t === "store.read" ? "store.data" : m.t === "store.list" ? "store.listed" : "store.done", id, ok: false, reason: String(e instanceof Error ? e.message : e) };
    }
    return null;
  }

  private pick(m: Msg): Body {
    const next = this.picks.shift();
    if (next === undefined) return { ok: false, reason: "canceled" };
    if (!existsSync(next)) return { ok: false, reason: `${next}: not there` };
    const accept = Array.isArray(m.accept) ? m.accept.map((a) => String(a).toLowerCase()) : null;
    const ok = (name: string) => !accept || accept.some((a) => name.toLowerCase().endsWith(a));
    const files = new Map<string, string>();
    if (statSync(next).isFile() || m.mode === "files") {
      for (const f of statSync(next).isFile() ? [next] : readdirSync(next).map((x) => join(next, x)).filter((x) => statSync(x).isFile())) if (ok(basename(f))) files.set(basename(f), f);
    } else {
      const walk = (dir: string, depth: number) => {
        for (const name of readdirSync(dir).sort()) {
          if (name.startsWith(".") || files.size >= 4000) continue;
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) { if (depth < 6) walk(full, depth + 1); }
          else if (st.isFile() && ok(name)) files.set(relative(next, full).split(sep).join("/"), full);
        }
      };
      walk(next, 1);
    }
    // (As ThreeRT's apps do: a folder with nothing the game asked for is a failed pick, said in a sentence.)
    if (!files.size) return { ok: false, reason: `Nothing in ${basename(next)} is ${accept ? accept.join(", ") : "a file"}: choose the game's folder` };
    const pick = `pick${++this.n}`;
    this.grants.set(pick, files);
    return { ok: true, pick, name: basename(next), entries: [...files].map(([path, full]) => ({ path, size: statSync(full).size })) };
  }

  /** A whole file, or `length` bytes from `offset` (`size` is the whole file's, `offset` echoed). */
  private read(m: Msg): Body {
    const full = this.grants.get(String(m.pick))?.get(String(m.path));
    if (!full) return { ok: false, reason: "denied" };
    const size = statSync(full).size;
    const whole = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);
    if (!whole(m.offset) || !whole(m.length)) return { ok: false, reason: "offset and length are whole numbers of bytes" };
    const offset = (m.offset as number | undefined) ?? 0;
    if (offset > size) return { ok: false, reason: "out of range" };
    const end = m.length === undefined ? size : Math.min(size, offset + (m.length as number));
    if (end - offset > MAX_READ) return { ok: false, reason: "too large" };
    this.bytesRead += end - offset;
    const fd = openSync(full, "r");
    try {
      const buf = Buffer.alloc(end - offset);
      readSync(fd, buf, 0, buf.length, offset);
      return { ok: true, data: buf.toString("base64"), offset, size };
    } finally {
      closeSync(fd);
    }
  }

  private at(path: unknown): string {
    const e = storePathError(path);
    if (e) throw new Error(e);
    return join(this.store, String(path));
  }

  private used(): number {
    return this.list("").reduce((n, e) => n + e.size, 0);
  }

  private write(m: Msg): Body {
    const file = this.at(m.path);
    const data = typeof m.data === "string" ? Buffer.from(m.data, "base64") : Buffer.from(String(m.text ?? ""), "utf8");
    if (this.used() + data.length > QUOTA) return { ok: false, reason: "quota" };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
    return { ok: true };
  }

  private readStore(m: Msg): Body {
    const file = this.at(m.path);
    if (!existsSync(file) || !statSync(file).isFile()) return { ok: false, reason: "absent" };
    const data = readFileSync(file);
    return m.as === "base64" ? { ok: true, data: data.toString("base64"), size: data.length } : { ok: true, text: data.toString("utf8"), size: data.length };
  }

  list(prefix: string): { path: string; size: number }[] {
    const out: { path: string; size: number }[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (!name.endsWith(".tmp")) {
          const path = relative(this.store, full).split(sep).join("/");
          if (path.startsWith(prefix)) out.push({ path, size: statSync(full).size });
        }
      }
    };
    walk(this.store);
    return out;
  }

  private remove(m: Msg): Body {
    rmSync(this.at(m.path), { recursive: true, force: true });
    return { ok: true };
  }
}
