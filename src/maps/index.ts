// The maps the game has: the built-in ones (made in code), whatever maps/index.ts bundles (a developer's imports with
// tools/import-bsp.ts), and the maps the player imported in the game, kept in the app's store on this device
// (src/import/, docs/MAPS.md). A room names its map by id and hash; `findMap` says whether this copy of the game has
// exactly that one.
import { maps as imported } from "../../maps/index.ts";
import { foundry } from "./foundry.ts";
import { range } from "./range.ts";
import type { BuiltMap, MapData } from "./types.ts";

export type AnyMap = MapData | BuiltMap;
export const DEFAULT_MAP = "foundry";

let fixed: AnyMap[] | null = null;
const user: MapData[] = [];
let all: AnyMap[] | null = null;

/** The maps that come with this copy of the game (built in code, then bundled), built on first use. */
function shipped(): AnyMap[] {
  return (fixed ??= [foundry(), range(), ...imported.filter((m) => m && typeof m.id === "string" && m.collision && Array.isArray(m.spawns))]);
}

/** Every map: built-in first, then bundled, then the player's own. */
export function maps(): AnyMap[] {
  return (all ??= [...shipped(), ...user]);
}

export function mapById(id: string): AnyMap | undefined {
  return maps().find((m) => m.id === id);
}

/** A map the player imported (it can be removed again). */
export function isUserMap(m: AnyMap): boolean {
  return user.includes(m as MapData);
}

/** Whether `id` is taken by a map that comes with the game (a player's map cannot have it). */
export function isShippedId(id: string): boolean {
  return shipped().some((m) => m.id === id);
}

/** Adds (or replaces, by id) a map of the player's. */
export function addUserMap(map: MapData): void {
  if (isShippedId(map.id)) return;
  const i = user.findIndex((m) => m.id === map.id);
  if (i >= 0) user[i] = map;
  else user.push(map);
  user.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  all = null;
}

export function removeUserMap(id: string): void {
  const i = user.findIndex((m) => m.id === id);
  if (i >= 0) user.splice(i, 1);
  all = null;
}

/** What a room's `meta.map` asks for, against what is here. */
export function findMap(wanted: unknown): { map: AnyMap } | { missing: { id: string; why: "absent" | "version" } } {
  const w = (wanted ?? {}) as { id?: unknown; hash?: unknown };
  const id = typeof w.id === "string" ? w.id : DEFAULT_MAP;
  const map = mapById(id);
  if (!map) return { missing: { id, why: "absent" } };
  if (typeof w.hash === "string" && w.hash !== map.hash) return { missing: { id, why: "version" } };
  return { map };
}

export function isBuilt(m: AnyMap): m is BuiltMap {
  return typeof (m as BuiltMap).build === "function";
}
