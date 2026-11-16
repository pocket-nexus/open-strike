// The HUD, described for the app to draw (the engine's `hud` schema, docs/RUNTIME.md "HUD"): the crosshair that
// opens with the spread, health, the weapon and its rounds, the score and the round's clock, the kill feed, the
// scoreboard (Tab, and between rounds), where the player is (the room's code and how to invite, or practice and
// why), and the messages at the centre: a round starting, eliminated and the seconds to the respawn, a round won or
// lost, connecting. Hit markers and the direction damage came from are `hud.flash` (game.ts). The Maps menu
// (src/menu.ts) is a table at the centre while it is open; an import under way is a bar at the bottom.
import { hud, type Hud, type HudItem, type HudMessage, type HudTone } from "@threert/gameplay";
import { TEAM, TEAMS, type Team } from "./config.ts";
import type { Match } from "./match.ts";
import type { Arsenal } from "./weapons.ts";

export interface HudView {
  match: Match;
  arsenal: Arsenal;
  /** The cone's half angle now, radians; the pointer is captured; Tab is held; the scope's reticle is up. */
  spread: number;
  captured: boolean;
  board: boolean;
  scoped: boolean;
  /** Who is under the crosshair, if anyone is seen there: a name, and whether to shoot. */
  target: { name: string; hostile: boolean } | null;
  map: string;
  /** Seconds since the last spawn (the round's opening message), and since the match came to be as it is. */
  sinceSpawn: number;
  /** The Maps menu's items (none while it is closed); an import under way; a word about the last one. */
  menu?: HudItem[];
  importing?: { label: string; done: number; queued: number } | null;
  notice?: { text: string; tone: HudTone } | null;
  /** The map being played is one the player imported (on this device only). */
  imported?: boolean;
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const title = (t: Team | null) => (t ? TEAM[t].title : "No team");

export function describe(v: HudView): Hud {
  const { match: m, arsenal: a } = v;
  const me = m.me, now = m.time();
  const items: HudItem[] = [];
  const playing = m.status === "online" || m.status === "practice" || m.status === "reconnecting";

  // Where the player is.
  if (m.status === "online" || m.status === "reconnecting") {
    items.push({ type: "text", anchor: "top-left", label: m.listed ? "Public room" : "Room", text: m.code ?? "", size: "normal", tone: m.status === "reconnecting" ? "warn" : "default" });
    items.push({ type: "text", anchor: "top-left", text: m.listed ? `Friends join with the code · ${m.link}` : `Invite: ${m.link}`, size: "small", tone: "dim" });
    items.push({ type: "text", anchor: "top-left", text: `${v.map} · ${1 + m.actors.size} playing · ${Math.round(m.rtt / 5) * 5} ms`, size: "small", tone: "dim" });
  } else if (m.status === "practice") {
    items.push({ type: "text", anchor: "top-left", label: "Practice", text: v.map, size: "normal" });
    if (m.notice) items.push({ type: "text", anchor: "top-left", text: m.notice, size: "small", tone: "warn" });
  }
  if (playing) items.push({ type: "text", anchor: "top-left", text: v.imported ? "M: maps · this map is your own copy, on this device" : "M: maps", size: "small", tone: "dim" });
  const menu = v.menu ?? [];
  items.push(...menu);
  if (v.importing) {
    const more = v.importing.queued ? ` · ${v.importing.queued} more to go` : "";
    items.push({ type: "bar", anchor: "bottom", label: `Importing ${v.importing.label}${more}`, value: Math.round(v.importing.done * 100) / 100, text: `${Math.round(v.importing.done * 100)} %`, tone: "accent" });
  }
  if (v.notice) items.push({ type: "text", anchor: "bottom", text: v.notice.text, size: "small", tone: v.notice.tone });

  if (playing) {
    // The score and the clock.
    const { mine, theirs, limit } = m.standing();
    const mode = m.mode === "tdm" ? "Team Deathmatch" : "Free for All";
    const score = m.mode === "tdm" && me.team
      ? `${title(me.team)} ${mine}  :  ${theirs} ${title(TEAMS.find((t) => t !== me.team)!)}`
      : `You ${mine}  :  ${theirs} Best`;
    items.push({ type: "text", anchor: "top", label: `${mode} · first to ${limit}`, text: score, size: "large", tone: mine > theirs ? "good" : mine < theirs ? "bad" : "default" });
    if (m.round.end && m.round.phase === "live") items.push({ type: "text", anchor: "top", label: `Round ${m.round.n}`, text: clock(m.round.end - now), tone: m.round.end - now < 30_000 ? "warn" : "default" });

    // The kill feed.
    if (m.feed.length) items.push({ type: "list", anchor: "top-right", lines: m.feed.map((l) => ({ id: l.id, text: l.text, tone: l.tone, ttl: 6 })) });

    // Health; the weapon.
    const hp = Math.max(0, me.health);
    items.push({ type: "bar", anchor: "bottom-left", label: me.team ? `${title(me.team)} · ${me.name}` : me.name, value: Math.min(1, hp / m.rules.health), text: String(hp), tone: hp > 60 ? "good" : hp > 30 ? "warn" : "bad" });
    if (me.alive && now < me.protectedUntil) items.push({ type: "text", anchor: "bottom-left", text: "Spawn protection", size: "small", tone: "accent" });
    const s = a.slot;
    items.push({ type: "text", anchor: "bottom-right", label: `${a.current + 1} · ${s.def.title}`, text: `${s.ammo} / ${s.reserve}`, size: "large", tone: s.ammo === 0 ? "bad" : s.ammo <= s.def.mag * 0.25 ? "warn" : "default" });
    if (a.reloading > 0) items.push({ type: "bar", anchor: "bottom-right", label: "Reloading", value: 1 - a.reloading / (s.def.reload / 1000), tone: "accent" });
    else if (s.ammo === 0) items.push({ type: "text", anchor: "bottom-right", text: s.reserve > 0 ? "R to reload" : "Out of ammunition", size: "small", tone: "warn" });

    if (v.target) items.push({ type: "text", anchor: "bottom", text: v.target.name, size: "small", tone: v.target.hostile ? "bad" : "good" });
    if (!v.captured && !menu.length) items.push({ type: "text", anchor: "bottom", text: "Click to play · W A S D move · Shift sprint · C crouch · Space jump · Mouse fire, right button sights · R reload · 1 2 3 or wheel: weapons · Tab scores", size: "small", tone: "dim" });

    // The scoreboard: while Tab is held, and between rounds.
    if ((v.board || m.round.phase === "over") && !menu.length) {
      const rows = m.board();
      items.push({
        type: "table", anchor: "center",
        title: `${v.map} · ${mode} · round ${m.round.n}`,
        columns: m.mode === "tdm" ? ["Team", "Player", "Kills", "Deaths"] : ["Player", "Kills", "Deaths"],
        rows: rows.map((r) => (m.mode === "tdm" ? [title(r.team), r.name + (r.alive ? "" : " (down)"), r.kills, r.deaths] : [r.name + (r.alive ? "" : " (down)"), r.kills, r.deaths])),
        highlight: rows.findIndex((r) => r.me),
      });
    }
  }

  // The centre.
  let message: HudMessage | null = null;
  const say = (t: string, subtitle?: string, tone?: HudTone) => { message = { title: t, ...(subtitle ? { subtitle } : {}), ...(tone ? { tone } : {}) }; };
  if (menu.length) message = null;
  else if (m.status === "starting" || m.status === "searching") say("Finding a match", "Looking for a room with a free place");
  else if (m.status === "joining") say("Joining", m.code ? `Room ${m.code}` : "Opening a room");
  else if (m.status === "reconnecting") say("Reconnecting", "The connection to the room dropped", "warn");
  else if (m.round.phase === "over") {
    const w = m.round.winner;
    const won = w !== undefined && (w === me.team || w === me.id);
    const who = w === undefined ? "Draw" : typeof w === "string" ? `${TEAM[w as Team]?.title ?? w} win the round` : `${m.nameOf(w)} wins the round`;
    say(w === undefined ? "Round over" : won ? "Victory" : "Defeat", `${who} · next round in ${Math.max(0, Math.ceil((m.round.end - now) / 1000))}`, w === undefined ? "default" : won ? "good" : "bad");
  } else if (playing && !me.alive && me.id) {
    const left = Math.max(0, Math.ceil((me.respawnAt - now) / 1000));
    say("Eliminated", left > 0 ? `Respawning in ${left}` : "Respawning", "bad");
  } else if (playing && v.sinceSpawn < 2.5 && m.round.phase === "live") {
    say(`Round ${m.round.n}`, m.mode === "tdm" ? `${title(me.team)} · first team to ${m.rules.scoreLimit}` : `First to ${m.rules.scoreLimit}`, "accent");
  }

  // The crosshair opens with the spread (0.06 rad is wide open). A scope has its own.
  const gap = Math.round(Math.min(1, v.spread / 0.06) * 20) / 20;
  return {
    crosshair: !playing || !me.alive || v.scoped ? null : { style: a.def.pellets > 1 ? "circle" : "cross", gap, ...(v.target?.hostile ? { tone: "bad" as const } : {}) },
    items,
    message,
  };
}

export function show(v: HudView): void {
  hud.set(describe(v));
}
