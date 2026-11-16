// The imported maps the game bundles (docs/MAPS.md). tools/import-bsp.ts rewrites this file: one import of
// `./<id>/map.json` per map, listed in `maps`. Imported maps are your own copies of maps you own: `maps/<id>/` and
// `assets/maps/` are git-ignored, and a project with any map listed here is not published.
//
//   import de_dust2 from "./de_dust2/map.json";
//   export const maps: MapData[] = [de_dust2 as MapData];
import type { MapData } from "../src/maps/types.ts";

export const maps: MapData[] = [];
