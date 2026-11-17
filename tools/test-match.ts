// A real match between two players, against the platform's rooms: two instances of the game in the headless
// renderer, each with this script as its app (lib/app.ts: real WebSockets and HTTP to the rooms, scripted keys and
// mouse), in real time. Nothing is mocked: the room is the platform's Room with its `fps` rules.
//
//   node tools/test-match.ts --api https://threert.app          the real rooms
//   node tools/test-match.ts [--api http://127.0.0.1:8933]      a rooms server on this machine (one needs access to
//                                                               the ThreeRT platform to run one)
//   [--shots media/dir]
//
// The story, each step checked on both players' reports and HUDs:
//   1. Ada opens the game with room "new": a private room, its code and invitation on her HUD.
//   2. Lin opens it with that code: both are in, on different teams, each at its own base.
//   3. Both walk into the hall (keys and mouse): each sees the other move, within the interpolation's reach.
//   4. Lin hits Ada once with the marksman rifle: the room takes the claim, Ada's health is 100 - 64 on both sides,
//      her HUD flashes damage from the right direction, Lin's a hit marker.
//   5. Ada kills Lin with the carbine: the room's damage adds up, Lin dies, the score and the kill feed reach both,
//      Lin sees "Eliminated" and the seconds, then respawns at her base with full health.
//   6. Twice more, and the round is Ada's team's (first to 3): "Victory" for her, "Defeat" for Lin, the scoreboard;
//      then the next round starts with everyone alive and the scores at zero.
//   7. Lin's connection is cut: she reconnects as the same player, on the same team.
//   8. Lin leaves: Ada is told.
// Then the ways in: quick play (a public room is made, the next player finds it), a room that is full, a room that
// plays a map this copy does not have, no network at all (practice, and why).
import { MOVE, WEAPONS, damageAt, inviteLink } from "../src/config.ts";
import { build } from "./build.ts";
import { App, World } from "./lib/app.ts";
import { checker, type Report } from "./lib/live.ts";

const args = process.argv.slice(2);
const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const api = flag("--api") ?? "http://127.0.0.1:8933";
const { out } = await build();
const { check, done } = checker();
const world = new World();
const f = (v: number) => v.toFixed(2);

try {
  const r = await fetch(`${api}/api/v1/apps/openstrike/rooms`);
  if (r.status !== 200) throw new Error(`status ${r.status}`);
} catch (e) {
  console.error(`no rooms at ${api} (${e}): start them first (see the top of this file)`);
  process.exit(2);
}

const rules = { scoreLimit: 3, respawn: 2000, intermission: 4000, protect: 400 };
const C = WEAPONS.carbine!, M = WEAPONS.marksman!;

/** Turns the view of `app` onto a point. */
async function aim(app: App, at: [number, number, number]): Promise<Report> {
  const r = await app.report();
  const eye = [r.at[0], r.at[1] + (r.crouched ? MOVE.crouchEye : MOVE.eye), r.at[2]];
  const d = [at[0] - eye[0]!, at[1] - eye[1]!, at[2] - eye[2]!];
  const far = Math.hypot(...d);
  app.look(r.yaw + r.kick[1] - Math.atan2(-d[0]!, -d[2]!), r.pitch + r.kick[0] - Math.asin(d[1]! / far));
  return r;
}

/** Walks `app` through waypoints (x, z), everyone else playing on. */
async function walk(app: App, points: [number, number][]): Promise<void> {
  for (const [x, z] of points) {
    for (let k = 0; k < 200; k++) {
      const r = await app.report();
      const dx = x - r.at[0], dz = z - r.at[2];
      if (Math.hypot(dx, dz) < 0.45) break;
      app.look(r.yaw - Math.atan2(-dx, -dz), r.pitch);
      app.keys = Math.hypot(dx, dz) > 4 ? ["W", "Shift"] : ["W"];
      await world.frames(4);
    }
  }
  app.keys = [];
  await world.frames(20);
}

/** The way from a base's spawns into the hall, to a place with a clear line to the other side's (mirrored in x). */
const intoHall = (side: -1 | 1): [number, number][] => [[side * 29.4, -1], [side * 20, -1], [side * 17, 2.3], [side * 13.5, 2.0]];
const actor = (r: Report, id: number) => r.actors.find((a) => a.id === id);

// ---- 1. Ada makes a private room ----
const big = flag("--shots") ? { width: 960, height: 540, scale: "1" } : {};
const ada = world.add(await App.start(out, { room: "new", name: "Ada", api, id: "test-ada-0000001", rules }, big));
let a: Report, l: Report;
check(await world.until(async () => (await ada.report()).status === "online", 12), "Ada is in a room of her own");
a = await ada.report();
const code = a.code ?? "";
check(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code) && a.mode === "tdm" && a.map === "foundry", `its code is ${code}, team deathmatch on Foundry`);
check(ada.item("text", "Room")?.text === code && JSON.stringify(ada.hud()).includes(inviteLink(code)), `her HUD shows the code and the invitation ${inviteLink(code)}`);
check(a.me.alive && a.me.health === 100 && a.me.team === "ember" && a.round.phase === "live" && a.round.n === 1, `she is alive on ${a.me.team}, round ${a.round.n} is live`);
const summary = (await (await fetch(`${api}/api/v1/rooms/openstrike/${code}`)).json()) as { players: number; rules: string; authority: string; public: boolean; meta: { map: { id: string; hash: string }; rules: { weapons: Record<string, { rpm: number }> } } };
check(summary.players === 1 && summary.rules === "fps" && summary.authority === "room" && !summary.public, `the platform has it: ${summary.players} player, rules ${summary.rules}, authority ${summary.authority}, private`);
check(summary.meta.map.id === "foundry" && /^[0-9a-f]{64}$/.test(summary.meta.map.hash) && summary.meta.rules.weapons.carbine?.rpm === C.rpm, `its meta names the map (${summary.meta.map.hash.slice(0, 12)}…) and carries the game's weapon table`);

// ---- 2. Lin joins by the code ----
const lin = world.add(await App.start(out, { room: code.toLowerCase(), name: "Lin", api, id: "test-lin-0000002" }, big));
check(await world.until(async () => (await lin.report()).status === "online" && (await ada.report()).actors.length === 1, 12), "Lin joins by the code");
await world.run(1);
a = await ada.report();
l = await lin.report();
check(l.code === code && l.me.team === "azure" && a.me.id !== l.me.id, `Lin is player ${l.me.id} on ${l.me.team}; Ada is player ${a.me.id} on ${a.me.team}`);
check(a.at[0] < -28 && l.at[0] > 28, `each stands at its own base (x ${f(a.at[0])} and ${f(l.at[0])})`);
check(actor(a, l.me.id)?.name === "Lin" && actor(l, a.me.id)?.name === "Ada" && actor(a, l.me.id)?.team === "azure", "each has the other by name and team");
const seen = (me: Report, other: Report) => { const o = actor(me, other.me.id)?.at; return o ? Math.hypot(o[0] - other.at[0], o[1] - other.at[1], o[2] - other.at[2]) : 99; };
check(seen(a, l) < 0.05 && seen(l, a) < 0.05, `and where the other stands (${f(seen(a, l))} m, ${f(seen(l, a))} m off)`);
check(JSON.stringify(ada.item("list")).includes("Lin joined"), "Ada's feed says Lin joined");
check(lin.item("text", /Team Deathmatch/)?.label.includes("first to 3"), "Lin's HUD has the room's rules (first to 3), not the default");

// ---- 3. Into the hall ----
ada.keys = ["S"];
await world.run(0.3);
a = await ada.report();
l = await lin.report();
const lag = seen(l, a);
check(lag > 0.1 && lag < 1.5, `while Ada moves, Lin sees her ${f(lag)} m behind where she is (the interpolation delay and the trip)`);
ada.keys = [];
await Promise.all([walk(ada, intoHall(-1)), walk(lin, intoHall(1))]);
a = await ada.report();
l = await lin.report();
check(Math.abs(a.at[0] + 13.5) < 1 && Math.abs(l.at[0] - 13.5) < 1, `both walked into the hall (x ${f(a.at[0])} and ${f(l.at[0])})`);
check(seen(a, l) < 0.05 && seen(l, a) < 0.05, `at rest each sees the other where it is (${f(seen(a, l))} m, ${f(seen(l, a))} m off)`);

// ---- 4. Lin hits Ada once ----
lin.press("3");
await world.run(M.draw + 0.3);
lin.buttons = [2];
await world.run(M.adsTime + 0.3);
a = await ada.report();
await aim(lin, [actor(await lin.report(), a.me.id)!.at![0], 1.15, actor(await lin.report(), a.me.id)!.at![2]]);
await world.frames(2);
lin.press("Mouse0");
lin.buttons = [0, 2];
await world.frames(2);
lin.buttons = [2];
await world.run(0.6);
lin.buttons = [];
a = await ada.report();
l = await lin.report();
const far = Math.hypot(a.at[0] - l.at[0], a.at[2] - l.at[2]);
const taken = damageAt(M, "body", far);
check(l.shots === 1 && l.confirmed === 1 && Object.keys(l.rejects).length === 0, `Lin fires once at ${f(far)} m: the room takes the claim (${JSON.stringify(l.rejects)} refused)`);
check(a.me.health === 100 - taken && actor(l, a.me.id)?.health === 100 - taken, `Ada has ${a.me.health} left on both sides (the table: ${taken})`);
check(lin.hud().flash?.kind === "hit", "Lin's HUD shows a hit marker");
const from = ada.hud().flash;
check(from?.kind === "damage" && Math.abs(from.angle) < 0.6, `Ada's HUD flashes damage from ahead (${from?.angle} rad): she faces the hall`);
check(ada.item("bar")?.text === String(100 - taken), `and her health bar reads ${ada.item("bar")?.text}`);

// ---- 5, 6. Ada kills Lin until the round is won ----
ada.buttons = [2];
await world.run(C.adsTime + 0.2);
for (let kill = 1; kill <= 3; kill++) {
  const before = (await lin.report()).me.deaths;
  let hits = 0;
  for (let k = 0; k < 40 && (await lin.report()).me.deaths === before; k++) {
    const mine = await ada.report();
    const target = actor(mine, l.me.id);
    if (!target?.at || !target.alive) { ada.buttons = [2]; await world.frames(6); continue; }
    await aim(ada, [target.at[0], target.at[1] + 1.15, target.at[2]]);
    ada.buttons = [0, 2];
    ada.press("Mouse0");
    await world.frames(9);
    ada.buttons = [2];
    await world.frames(5);
    hits = (await ada.report()).confirmed;
  }
  a = await ada.report();
  l = await lin.report();
  check(l.me.deaths === before + 1 && !l.me.alive && l.me.health === 0, `kill ${kill}: Lin is down (${hits} of Ada's hits taken by the room so far, ${JSON.stringify(a.rejects)} refused)`);
  check(a.me.kills === kill && a.score.ember === kill && l.score.ember === kill && actor(l, a.me.id)?.kills === kill, `the score reaches both: Ember ${a.score.ember} : ${a.score.azure} Azure`);
  if (kill === 1) {
    const feedA = JSON.stringify(ada.item("list")), feedL = JSON.stringify(lin.item("list"));
    check(feedA.includes("Ada  ›  Lin") && feedA.includes(C.title) && feedL.includes("Ada  ›  Lin"), "the kill feed on both: Ada › Lin, VK-5 Carbine");
    check(ada.hud().flash?.kind === "kill", "Ada's HUD flashes the kill");
    check(lin.hud().message?.title === "Eliminated" && /Respawning in [12]/.test(lin.hud().message?.subtitle ?? ""), `Lin's HUD: ${lin.hud().message?.title}, ${lin.hud().message?.subtitle}`);
    check(lin.hud().crosshair === null, "and no crosshair while she is down");
    check(ada.item("text", /Team Deathmatch/)?.text.includes("Ember 1  :  0 Azure"), `Ada's score line: ${ada.item("text", /Team Deathmatch/)?.text}`);
    if (flag("--shots")) {
      // What each of the two sees at that moment: Ada her kill, Lin her own body from the death camera.
      await ada.live.snapshot(`${flag("--shots")}/match-kill-ada.png`, 2);
      await lin.live.snapshot(`${flag("--shots")}/match-kill-lin.png`, 2);
    }
  }
  if (kill < 3) {
    check(await world.until(async () => (await lin.report()).me.alive, 5), "Lin respawns");
    l = await lin.report();
    check(l.me.health === 100 && l.at[0] > 28 && lin.hud().message?.title !== "Eliminated", `at her base (x ${f(l.at[0])}) with ${l.me.health} health`);
    ada.buttons = [2];
    await walk(lin, intoHall(1));
  }
}
a = await ada.report();
l = await lin.report();
check(a.round.phase === "over" && a.round.winner === "ember" && l.round.phase === "over" && l.round.winner === "ember", `three kills: the round is over on both, winner ${a.round.winner}`);
check(ada.hud().message?.title === "Victory" && lin.hud().message?.title === "Defeat", `Ada's HUD says ${ada.hud().message?.title}, Lin's ${lin.hud().message?.title} (${lin.hud().message?.subtitle})`);
const board = lin.item("table");
check(board && board.rows.length === 2 && board.rows[0][1] === "Ada" && board.rows[0][2] === 3 && board.highlight === 1, `the scoreboard is up between rounds: ${JSON.stringify(board?.rows)}`);
ada.buttons = [];
check(await world.until(async () => (await ada.report()).round.n === 2 && (await lin.report()).round.n === 2, 8), "the next round starts");
await world.run(0.5);
a = await ada.report();
l = await lin.report();
check(a.round.phase === "live" && a.me.alive && l.me.alive && a.me.health === 100 && l.me.health === 100 && a.score.ember === 0 && a.me.kills === 0, `round 2: both alive with 100, the score at ${a.score.ember} : ${a.score.azure}`);
check(a.at[0] < -28 && l.at[0] > 28 && a.ammo === C.mag, `both back at their bases, magazines full (${a.ammo})`);

// ---- 7. Lin's connection drops ----
lin.cut();
await world.frames(3);
check((await lin.report()).status === "reconnecting" && lin.hud().message?.title === "Reconnecting", "Lin's sockets are cut: her HUD says Reconnecting");
check(await world.until(async () => (await lin.report()).status === "online", 10), "and she is back");
await world.run(1);
a = await ada.report();
const back = await lin.report();
// (This script can only close a socket, which the room hears at once: to Ada, Lin left and came back. A network that
// goes silent is not heard: the room keeps the player until the same id returns.)
const feed = JSON.stringify(ada.item("list") ?? "");
check(back.me.id === l.me.id && back.me.team === "azure" && a.actors.length === 1 && a.actors[0]!.id === l.me.id, `as the same player (${back.me.id}) on the same team`);
check(feed.indexOf("Lin left") >= 0 && feed.lastIndexOf("Lin joined") > feed.indexOf("Lin left"), "Ada's feed: Lin left, Lin joined");
lin.keys = ["S"];
await world.run(0.7);
lin.keys = [];
await world.run(0.5);
a = await ada.report();
l = await lin.report();
check(seen(a, l) < 0.05 && l.at[0] > 29.5, `her moves reach Ada again (${f(seen(a, l))} m off)`);

// ---- 8. Lin leaves ----
world.remove(lin);
await lin.quit();
check(await world.until(async () => (await ada.report()).actors.length === 0, 8), "Lin quits: Ada's room has one player");
check(JSON.stringify(ada.item("list")).includes("Lin left"), "and her feed says so");
const errorsA = ada.live.errors(), errorsL = lin.live.errors();
check(errorsA.length === 0 && errorsL.length === 0, `no script error in either game${errorsA.concat(errorsL)[0] ? `: ${errorsA.concat(errorsL)[0]}` : ""}`);
world.remove(ada);
await ada.quit();

// ---- the ways in ----
// Quick play: nobody is playing in public, so a public room is made; the next player finds it.
const kit = world.add(await App.start(out, { name: "Kit", api, id: "test-kit-0000003" }));
check(await world.until(async () => (await kit.report()).status === "online", 12), "quick play with no public room: Kit is in one");
const k = await kit.report();
check(kit.item("text", "Public room")?.text === k.code, `a public room (${k.code}: made now, or one a moment old that nobody is in)`);
kit.keys = ["W"];           // (a room is listed with its players once one moves: the row is written on join)
await world.run(0.5);
kit.keys = [];
const listed = (await (await fetch(`${api}/api/v1/apps/openstrike/rooms`)).json()) as { rooms: { code: string; players: number; meta: { map?: { id: string } } }[] };
check(listed.rooms.some((r) => r.code === k.code && r.players === 1 && r.meta?.map?.id === "foundry"), `the platform lists it: ${JSON.stringify(listed.rooms.map((r) => [r.code, r.players]))}`);
const max = world.add(await App.start(out, { name: "Max", api, id: "test-max-0000004" }));
check(await world.until(async () => (await max.report()).status === "online", 12), "quick play again: Max is in a room");
const m = await max.report();
check(m.code === k.code && m.me.team === "azure" && m.actors[0]?.name === "Kit", `the same one (${m.code}), on the other team`);

// Free-for-all: a room of that mode has no teams, and its players start anywhere.
const dee = world.add(await App.start(out, { room: "new", mode: "dm", name: "Dee", api, id: "test-dee-0000009" }));
check(await world.until(async () => (await dee.report()).status === "online", 12), "a free-for-all room");
const d = await dee.report();
check(d.mode === "dm" && d.me.team === null && d.me.alive && Math.abs(d.at[0]) < 29 && dee.item("text", /Free for All/)?.text.startsWith("You 0"), `mode ${d.mode}, no team, spawned in the lanes (x ${f(d.at[0])}), HUD: ${dee.item("text", /Free for All/)?.label}`);

// A room that is full, a room on a map this copy does not have, and no network.
const post = async (body: object) => ((await (await fetch(`${api}/api/v1/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { code: string }).code;
const tiny = await post({ app: "openstrike", mode: "tdm", rules: "fps", max: 1, meta: { map: { id: "foundry" } } });
const one = world.add(await App.start(out, { room: tiny, name: "One", api, id: "test-one-0000005" }));
check(await world.until(async () => (await one.report()).status === "online", 12), `a room for one (${tiny}): One is in`);
const two = world.add(await App.start(out, { room: tiny, name: "Two", api, id: "test-two-0000006" }));
check(await world.until(async () => (await two.report()).status === "practice", 12), "Two is not: practice");
let t = await two.report();
check(/full/.test(t.notice ?? "") && t.me.alive && t.actors.length === 4 && two.item("text", "Practice") && JSON.stringify(two.hud()).includes("full"), `and told why: "${t.notice}", with ${t.actors.length} bots to shoot at`);
const dust = await post({ app: "openstrike", mode: "tdm", rules: "fps", meta: { map: { id: "de_dust2", hash: "0".repeat(64) } } });
const far2 = world.add(await App.start(out, { room: dust, name: "Far", api, id: "test-far-0000007" }));
check(await world.until(async () => (await far2.report()).status === "practice", 12), `a room on de_dust2 (${dust}): practice instead of a broken world`);
t = await far2.report();
check(/de_dust2/.test(t.notice ?? "") && /M: Maps/.test(t.notice ?? "") && t.map === "foundry" && t.me.alive, `told which map and how to get it: "${t.notice}"`);
const dustRoom = (await (await fetch(`${api}/api/v1/rooms/openstrike/${dust}`)).json()) as { players: number };
check(dustRoom.players === 0, "the player was never put into that room");
const off = await App.start(out, { name: "Off", api: "http://127.0.0.1:9", id: "test-off-0000008" });
world.add(off);
check(await world.until(async () => (await off.report()).status === "practice", 14), "no platform at the address: practice");
t = await off.report();
check(/No connection|did not answer/.test(t.notice ?? "") && t.me.alive && t.round.phase === "live", `and told why: "${t.notice}"`);

for (const app of [...world.apps]) {
  const errors = app.live.errors();
  check(errors.length === 0, `${app.name}: no script error${errors[0] ? `: ${errors[0]}` : ""}`);
  world.remove(app);
  await app.quit();
}
done("match");
