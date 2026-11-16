// A script as the app of a game instance, with a network: the game runs in the headless renderer (lib/live.ts) and
// this is what a ThreeRT client is to it. It answers the host channel's `net.*` family with real sockets and HTTP
// (Node's WebSocket and fetch), sends the player's input every frame, and steps the game in real time (the rooms'
// clocks are real). Several instances step together: `World.run(seconds)`. With `files`, it is also an app with the
// `files` and `store` families (files.ts): a directory as the game's store, scripted picks; its launch message lists
// them (`caps`).
import type { FilesHost } from "./files.ts";
import { startLive, type Live, type Post, type Report } from "./live.ts";

export class App {
  readonly live: Live;
  readonly name: string;
  private readonly sockets = new Map<string, WebSocket>();
  private inbox: object[] = [];
  private batches = new Map<string, { t: string; id: unknown; list: string[] }>();
  /** What is held (it stays held), and what happens once in the next frame. */
  keys: string[] = [];
  buttons: number[] = [];
  private once: { pressed: string[]; dx: number; dy: number; wheel: number } = { pressed: [], dx: 0, dy: 0, wheel: 0 };
  /** The network is cut: sockets cannot be opened, requests fail. */
  offline = false;
  /** The store and the picks, for an app with `files` and `store`. */
  readonly files: FilesHost | null;

  private constructor(live: Live, name: string) {
    this.live = live;
    this.name = name;
    this.files = live.files;
    live.onPosts = (posts) => { for (const p of posts) this.post(p); };
  }

  static async start(bundle: string, launch: Record<string, unknown>, o: { width?: number; height?: number; scale?: string; files?: { store: string; picks?: string[] } } = {}): Promise<App> {
    const live = await startLive(bundle, { launch, dt: 1 / 60, width: o.width ?? 480, height: o.height ?? 270, ...(o.scale ? { scale: o.scale } : {}), ...(o.files ? { files: o.files } : {}) });
    const app = new App(live, String(launch.name ?? "player"));
    // (What the game posted before this script was listening: its first `net.*` messages.)
    for (const p of live.posts) app.post(p);
    return app;
  }

  private post(p: Post): void {
    const key = JSON.stringify(p.id);
    switch (p.t) {
      case "net.open": {
        if (this.offline) { this.inbox.push({ t: "net.closed", id: p.id, code: 1006, reason: "offline" }); return; }
        const ws = new WebSocket(String(p.url));
        this.sockets.set(key, ws);
        ws.onopen = () => this.inbox.push({ t: "net.opened", id: p.id });
        ws.onmessage = (e) => {
          if (typeof e.data !== "string" || this.sockets.get(key) !== ws) return;
          let b = this.batches.get(key);
          if (!b) { b = { t: "net.messages", id: p.id, list: [] }; this.batches.set(key, b); }
          b.list.push(e.data);
        };
        ws.onclose = (e) => { if (this.sockets.get(key) === ws) { this.sockets.delete(key); this.inbox.push({ t: "net.closed", id: p.id, code: e.code || 1006, reason: e.reason || "" }); } };
        ws.onerror = () => {};
        return;
      }
      case "net.send": {
        const ws = this.sockets.get(key);
        if (ws && ws.readyState === 1) ws.send(String(p.data));
        return;
      }
      case "net.close": {
        const ws = this.sockets.get(key);
        this.sockets.delete(key);
        try { ws?.close(1000, "bye"); } catch { /* gone */ }
        this.inbox.push({ t: "net.closed", id: p.id, code: 1000, reason: "" });
        return;
      }
      case "net.fetch": {
        if (this.offline) { this.inbox.push({ t: "net.fetched", id: p.id, status: 0, body: "", error: "offline" }); return; }
        const init: RequestInit = { method: String(p.method ?? "GET") };
        if (typeof p.body === "string") { init.body = p.body; init.headers = { "content-type": "application/json", ...(p.headers ?? {}) }; }
        fetch(String(p.url), init).then(
          async (res) => this.inbox.push({ t: "net.fetched", id: p.id, status: res.status, body: await res.text() }),
          (e) => this.inbox.push({ t: "net.fetched", id: p.id, status: 0, body: "", error: String(e) }),
        );
        return;
      }
    }
  }

  /** Drops every socket the way a lost network does (no close frame from this side reaches the game as a goodbye). */
  cut(): void {
    for (const [key, ws] of [...this.sockets]) {
      this.sockets.delete(key);
      try { ws.close(); } catch { /* gone */ }
      this.inbox.push({ t: "net.closed", id: JSON.parse(key), code: 1006, reason: "cut" });
    }
  }

  press(...keys: string[]): void { this.once.pressed.push(...keys); }
  /** The player clicks or taps row `row` of the selectable HUD table `item` (the app's `hud.choose`). */
  choose(item: string | number, row: number): void { this.inbox.push({ t: "hud.choose", item, row }); }
  look(dx: number, dy: number): void { this.once.dx += dx; this.once.dy += dy; }

  /** One frame: the app's messages in, the frame, what the game posted out. */
  async frame(): Promise<void> {
    const messages: object[] = [...this.inbox, ...this.batches.values()];
    this.inbox = [];
    this.batches = new Map();
    const o = this.once;
    this.once = { pressed: [], dx: 0, dy: 0, wheel: 0 };
    messages.push({ t: "input", captured: true, keys: [...this.keys, ...o.pressed.filter((k) => !k.startsWith("Mouse") && !this.keys.includes(k))], buttons: this.buttons, pressed: o.pressed, dx: o.dx, dy: o.dy, wheel: o.wheel });
    this.live.host(messages);
    await this.live.step(1);
  }

  report(): Promise<Report> { return this.live.report(); }
  hud(): any { return this.live.hud(); }
  /** A HUD item by type and label (or the first of the type). */
  item(type: string, label?: string | RegExp): any {
    return (this.hud().items ?? []).find((i: any) => i.type === type && (label === undefined || (typeof label === "string" ? i.label === label : label.test(String(i.label ?? "")))));
  }

  async quit(): Promise<void> {
    for (const ws of this.sockets.values()) try { ws.close(1000, "bye"); } catch { /* gone */ }
    this.sockets.clear();
    await this.live.quit();
  }
}

/** Instances that play together: stepped side by side at 60 frames a second of real time. */
export class World {
  readonly apps: App[] = [];
  add<T extends App>(app: T): T { this.apps.push(app); return app; }
  remove(app: App): void { const i = this.apps.indexOf(app); if (i >= 0) this.apps.splice(i, 1); }

  async frames(n: number): Promise<void> {
    for (let k = 0; k < n; k++) {
      const t0 = performance.now();
      await Promise.all(this.apps.map((a) => a.frame()));
      const left = 1000 / 60 - (performance.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
  }
  run(seconds: number): Promise<void> { return this.frames(Math.round(seconds * 60)); }

  /** Steps until `ok()` or `seconds` have passed. True if it came to be. */
  async until(ok: () => boolean | Promise<boolean>, seconds: number, every = 6): Promise<boolean> {
    for (let k = 0; k < seconds * 60; k += every) {
      if (await ok()) return true;
      await this.frames(every);
    }
    return ok();
  }
}
