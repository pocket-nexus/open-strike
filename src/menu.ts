// The Maps menu: every map this copy of the game has, what to do with one (practise on it, open a room on it, take an
// imported one off this device), and importing maps from the player's own copy of Counter-Strike or Half-Life
// (src/import/). Drawn by the app from the HUD schema: a table whose highlighted row is the choice, lines of help under
// it. Keys: M opens and closes it, Up / Down (W / S, the wheel) choose, Enter (Space, a click while the pointer is
// captured) takes the choice, Backspace (Left, Escape) goes back. A gamepad's buttons come as the keys they stand for.
//
// While it is open the player stands still and does not shoot: the keys are the menu's.
import type { HudItem } from "@threert/gameplay";
import type { Input } from "@threert/gameplay";
import type { Library } from "./import/library.ts";
import { type AnyMap, isBuilt, isUserMap, maps } from "./maps/index.ts";

export type MenuAction =
  | { kind: "practice"; id: string }
  | { kind: "room"; id: string };

type Screen = { kind: "maps" } | { kind: "map"; id: string; confirm: boolean } | { kind: "found" };

interface Row { cells: (string | number)[]; act: () => MenuAction | void; dim?: boolean }

/** Rows shown at once; a longer list scrolls with the choice. */
const PAGE = 11;
const COPYRIGHT = "Uses your own copy; stays on this device";

export class Menu {
  open = false;
  private screen: Screen = { kind: "maps" };
  private sel = 0;
  private readonly lib: Library;
  /** The map being played (marked in the list), and whether the player is in a room. */
  current = "";
  online = false;

  constructor(lib: Library) {
    this.lib = lib;
  }

  /** Opens the list of maps (the chosen one is the map being played). */
  show(): void {
    this.open = true;
    this.screen = { kind: "maps" };
    this.sel = Math.max(0, maps().findIndex((m) => m.id === this.current));
  }

  /** Reads the frame's keys; returns what the player chose to do, if anything. */
  update(input: Input): MenuAction | null {
    if (input.pressed("M")) {
      if (this.open) this.open = false;
      else this.show();
      return null;
    }
    if (!this.open) return null;
    const rows = this.rows();
    const up = input.pressed("Up") || input.pressed("W") || input.wheel > 0;
    const down = input.pressed("Down") || input.pressed("S") || input.wheel < 0;
    if (up) this.sel = (this.sel - 1 + rows.length) % rows.length;
    if (down) this.sel = (this.sel + 1) % rows.length;
    if (input.pressed("Escape") || input.pressed("Backspace") || input.pressed("Left")) {
      this.back();
      return null;
    }
    const choose = input.pressed("Enter") || input.pressed("Space") || input.pressed("Right") || (input.captured && input.pressed("Mouse0"));
    if (!choose) return null;
    const action = rows[Math.min(this.sel, rows.length - 1)]?.act();
    if (action) this.open = false;
    return action ?? null;
  }

  private back(): void {
    if (this.screen.kind === "maps") { this.open = false; return; }
    const id = this.screen.kind === "map" ? this.screen.id : null;
    this.screen = { kind: "maps" };
    const list = maps();
    this.sel = Math.max(0, id ? list.findIndex((m) => m.id === id) : list.length);
  }

  private go(screen: Screen, sel = 0): void {
    this.screen = screen;
    this.sel = sel;
  }

  private rows(): Row[] {
    const lib = this.lib;
    const s = this.screen;
    if (s.kind === "map") {
      const map = maps().find((m) => m.id === s.id);
      if (!map) { this.screen = { kind: "maps" }; return this.rows(); }
      const out: Row[] = [
        { cells: ["Practise here", "against bots, on this device"], act: () => ({ kind: "practice", id: map.id }) },
        { cells: ["Open a new room here", "friends join with its code; they need the map too"], act: () => ({ kind: "room", id: map.id }) },
      ];
      if (isUserMap(map)) {
        out.push({
          cells: s.confirm ? ["Press again to remove it", `${map.id} leaves this device`] : ["Remove from this device", "import it again any time"],
          act: () => {
            if (!s.confirm) { this.screen = { ...s, confirm: true }; return; }
            lib.remove(map.id);
            this.back();
          },
        });
      }
      out.push({ cells: ["Back", ""], act: () => this.back() });
      return out;
    }
    if (s.kind === "found") {
      const f = lib.found;
      if (!f) { this.screen = { kind: "maps" }; return this.rows(); }
      const out: Row[] = f.bsps.map((e) => {
        const id = lib.idFor(e);
        return { cells: [id, folder(e.path), `${(e.size / 1048576).toFixed(1)} MB`, lib.has(id) ? "imported" : ""], act: () => lib.importEntries([e]) };
      });
      if (f.bsps.length > 1) out.push({ cells: [`Import all ${f.bsps.length}`, "", "", ""], act: () => lib.importEntries(f.bsps) });
      out.push({ cells: ["Choose another folder…", "", "", ""], act: () => lib.pick() });
      out.push({ cells: ["Back", "", "", ""], act: () => this.back() });
      return out;
    }
    const out: Row[] = maps().map((m) => ({
      cells: [m.title, kindOf(m), m.id === this.current ? (this.online ? "in this room" : "playing") : ""],
      act: () => this.go({ kind: "map", id: m.id, confirm: false }),
    }));
    out.push({
      cells: [lib.canImport ? "Import from your game folder…" : "Import from your game folder (needs a newer ThreeRT)", "Counter-Strike 1.x, Half-Life", ""],
      dim: !lib.canImport,
      act: () => lib.pick(),
    });
    if (lib.found) out.push({ cells: [`Maps in ${lib.found.name}…`, `${lib.found.bsps.length} found`, ""], act: () => this.go({ kind: "found" }) });
    return out;
  }

  /** A pick came back: show what is in it. */
  picked(): void {
    if (this.lib.found) this.go({ kind: "found" });
  }

  /** The HUD items of the menu (none while it is closed). */
  items(): HudItem[] {
    if (!this.open) return [];
    const rows = this.rows();
    this.sel = Math.max(0, Math.min(this.sel, rows.length - 1));
    const first = Math.max(0, Math.min(this.sel - Math.floor(PAGE / 2), rows.length - PAGE));
    const shown = rows.slice(first, first + PAGE);
    const s = this.screen;
    const more = rows.length > PAGE ? ` · ${first + 1}–${first + shown.length} of ${rows.length}` : "";
    const title = s.kind === "maps" ? `Maps${more}` : s.kind === "map" ? `${maps().find((m) => m.id === s.id)?.title ?? s.id}` : `${this.lib.found?.name ?? ""}: maps found${more}`;
    const columns = s.kind === "maps" ? ["Map", "", ""] : s.kind === "map" ? ["", ""] : ["Map", "Folder", "Size", ""];
    const items: HudItem[] = [{ type: "table", anchor: "center", title, columns, rows: shown.map((r) => r.cells), highlight: this.sel - first }];
    const lib = this.lib;
    if (lib.pickPending) items.push({ type: "text", anchor: "center", text: "Choose your game's folder in the window that opened", size: "small", tone: "accent" });
    if (lib.notice) items.push({ type: "text", anchor: "center", text: lib.notice.text, size: "small", tone: lib.notice.tone });
    if (s.kind !== "map") items.push({ type: "text", anchor: "center", text: `${COPYRIGHT} · never uploaded, never sent to other players`, size: "small", tone: "dim" });
    items.push({ type: "text", anchor: "center", text: "Up Down choose · Enter select · Backspace back · M close", size: "small", tone: "dim" });
    return items;
  }
}

function kindOf(m: AnyMap): string {
  if (isUserMap(m)) return "Imported · on this device";
  return isBuilt(m) ? "Built in" : "Bundled";
}

function folder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
