// The player's own maps: those in the app's store on this device (loaded when the game starts), the folder they picked
// to import from, the imports under way (one at a time, a few milliseconds a frame), and removing one. The Maps menu
// (src/menu.ts) drives it; the game reads what it says (`notice`, `progress`) into the HUD.
import { addUserMap, isShippedId, mapById, removeUserMap } from "../maps/index.ts";
import type { MapData } from "../maps/types.ts";
import { ImportError } from "./bsp.ts";
import { type Entry, HostError, type Pending, type Picked, can, files, store } from "./host.ts";
import { ACCEPT, type Found, type Imported, baseName, idOf, importMap, loadStored, scan, storePaths } from "./job.ts";
import { type Progress, Sliced } from "./sliced.ts";
import type { Wad } from "./wad.ts";

/** Milliseconds of import work a frame. */
export const BUDGET_MS = 8;
/** How long the game waits for the store's list of maps before it goes on without it. */
const LOAD_WAIT_MS = 4000;

export interface Notice { text: string; tone: "default" | "good" | "warn" | "bad" | "dim" }
/** One import as it went: for the HUD, the tests and the measurements. */
export interface Done { id: string; ok: boolean; ms: number; busy: number; frames: number; longest: number; longestAt?: string; slow?: string[]; warnings: string[]; error?: string; triangles?: number; textures?: number; missing?: number }

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Library {
  /** The store's maps: not asked for yet, being read, read (or there is no store). */
  status: "waiting" | "loading" | "ready" = "waiting";
  /** The last folder picked, and what is in it. */
  found: Found | null = null;
  notice: Notice | null = null;
  private noticeAt = 0;
  readonly done: Done[] = [];
  /** Called when a map is added or taken away (the game unmounts a removed map). */
  onChange: (id: string, added: MapData | null) => void = () => {};
  private loading: Sliced<{ maps: MapData[]; problems: string[] }> | null = null;
  private loadSince = 0;
  private picking: Pending<Picked> | null = null;
  private removing: { id: string; p: Pending<true> }[] = [];
  private job: Sliced<Imported> | null = null;
  private current: { entry: Entry; id: string; t0: number } | null = null;
  private readonly queue: { entry: Entry; id: string }[] = [];
  private wadCache = new Map<string, Wad | null>();

  /** The app can let the player pick files, and keep them. */
  get canImport(): boolean {
    return can("files") && can("store");
  }

  /** Reads the store's maps (once the app's launch message has said whether there is a store). */
  begin(now: number): void {
    if (this.status !== "waiting") return;
    this.loadSince = now;
    if (!can("store")) { this.status = "ready"; return; }
    this.status = "loading";
    this.loading = new Sliced(loadStored());
  }

  /** The game may start: the store's maps are known (or are taking too long to matter). */
  ready(now: number): boolean {
    return this.status === "ready" || (this.status === "loading" && now - this.loadSince > LOAD_WAIT_MS);
  }

  /** What the import under way is at, if one is. */
  get progress(): (Progress & { queued: number }) | null {
    if (!this.job || !this.current) return null;
    return { ...this.job.progress, queued: this.queue.length };
  }

  get busy(): boolean {
    return !!this.job || this.queue.length > 0;
  }

  get pickPending(): boolean {
    return !!this.picking && !this.picking.done;
  }

  /** Asks the app for a folder to import from. */
  pick(): void {
    if (!this.canImport) { this.say("This app cannot open your files: importing needs a newer ThreeRT", "warn"); return; }
    if (this.pickPending) return;
    this.picking = files.pick({ mode: "folder", accept: ACCEPT, title: "Your Counter-Strike or Half-Life folder" });
  }

  /** The id a map file gets here: its name, kept clear of the maps that come with the game. */
  idFor(entry: Entry): string {
    const id = idOf(entry.path);
    return isShippedId(id) ? `${id}_imported` : id;
  }

  /** Queues maps of the last pick for import. */
  importEntries(entries: Entry[]): void {
    for (const entry of entries) {
      const id = this.idFor(entry);
      if (this.current?.id === id || this.queue.some((q) => q.id === id)) continue;
      this.queue.push({ entry, id });
    }
  }

  /** Takes a map of the player's off this device. */
  remove(id: string): void {
    if (this.removing.some((r) => r.id === id)) return;
    this.removing.push({ id, p: store.remove(storePaths(id).dir) });
  }

  /** The frame's share of the work: reading the store, a pick's answer, removals, the import under way. */
  update(now: number, budget = BUDGET_MS): void {
    if (this.loading) {
      this.loading.step(budget);
      if (this.loading.done) {
        const r = this.loading.value;
        for (const m of r?.maps ?? []) { addUserMap(m); this.onChange(m.id, m); }
        if (r?.problems.length) this.say(`Some stored maps could not be read: ${r.problems.join("; ")}`, "warn");
        if (this.loading.error) this.say(`The stored maps could not be listed: ${message(this.loading.error)}`, "warn");
        this.loading = null;
        this.status = "ready";
      }
    }
    if (this.picking?.done) {
      const p = this.picking;
      this.picking = null;
      if (p.ok && p.value) {
        this.found = scan(p.value.pick, p.value.name, p.value.entries);
        this.wadCache = new Map();
        const f = this.found;
        this.say(f.bsps.length ? `${f.name}: ${f.bsps.length} map${f.bsps.length > 1 ? "s" : ""}, ${f.wads.length} texture archive${f.wads.length === 1 ? "" : "s"}` : `${f.name}: no .bsp map in it. Choose the game's folder (cstrike, valve, or the one above them)`, f.bsps.length ? "default" : "warn");
      } else if (p.reason !== "canceled") this.say(`No folder: ${p.reason}`, "warn");
    }
    for (const r of [...this.removing]) {
      if (!r.p.done) continue;
      this.removing.splice(this.removing.indexOf(r), 1);
      if (r.p.ok) {
        removeUserMap(r.id);
        this.onChange(r.id, null);
        this.say(`${r.id} is off this device`, "default");
      } else this.say(`${r.id} could not be removed: ${r.p.reason}`, "bad");
    }
    if (!this.job && this.queue.length && this.found) {
      const next = this.queue.shift()!;
      this.current = { ...next, t0: now };
      this.job = new Sliced(importMap(this.found, next.entry, next.id, this.wadCache));
    }
    if (this.job && this.current) {
      // (An import has the frame's budget less what reading the store took.)
      this.job.step(budget);
      if (this.job.done) this.finish(now);
    }
  }

  private finish(now: number): void {
    const job = this.job!, cur = this.current!;
    this.job = null;
    this.current = null;
    const ms = Math.round(now - cur.t0);
    if (job.error || !job.value) {
      const error = message(job.error);
      this.done.push({ id: cur.id, ok: false, ms, busy: Math.round(job.busy), frames: job.steps, longest: Math.round(job.longest), warnings: [], error });
      this.say(`${baseName(cur.entry.path)}: ${error}`, "bad");
      return;
    }
    const r = job.value;
    addUserMap(r.map);
    this.onChange(r.id, r.map);
    const missing = r.stats.textures.missing.length;
    this.done.push({ id: r.id, ok: true, ms, busy: Math.round(job.busy), frames: job.steps, longest: Math.round(job.longest), longestAt: job.longestAt, slow: job.slow, warnings: r.warnings, triangles: r.stats.triangles, textures: r.stats.textures.used, missing });
    const extra = missing ? ` · ${missing} texture${missing > 1 ? "s" : ""} missing${r.wadsMissing.length ? ` (${r.wadsMissing.join(", ")} not in the folder)` : ""}` : "";
    this.say(`${r.map.title === r.id ? r.id : `${r.map.title} (${r.id})`} imported in ${(ms / 1000).toFixed(1)} s${extra}`, missing ? "warn" : "good");
    if (!this.queue.length) this.wadCache = new Map();
  }

  say(text: string, tone: Notice["tone"]): void {
    this.notice = { text, tone };
    this.noticeAt = clock();
  }

  /** The last notice, if it is younger than `ms` (shown over the game while the menu is closed). */
  recent(ms = 8000): Notice | null {
    return this.notice && clock() - this.noticeAt < ms ? this.notice : null;
  }

  /** The player's own map by id. */
  has(id: string): boolean {
    return !!mapById(id);
  }
}

function message(e: unknown): string {
  if (e instanceof ImportError || e instanceof HostError) return e.message;
  if (e instanceof Error) return e.message;
  return e === null || e === undefined ? "the import stopped without a result" : String(e);
}
