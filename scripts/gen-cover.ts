// Generate the PSP's XMB backdrop from the desktop hero shot:
//   crates/openstrike-psp/assets/PIC1.png   (480x272, behind the game's listing)
//
//   bun scripts/gen-cover.ts
//
// Requires ImageMagick (`magick`) and the macOS system fonts. Re-run only
// when the branding or source shot changes — the output is committed.
//
// This script draws no icon. The app icon on every console is the Pocket3D
// icon in vendor/pocketjs/engine/pocket3d/icon/, which each build reads from
// that checkout (README.md, "Pocket3D app icon").

import { existsSync, mkdirSync } from "node:fs";

const repo = new URL("..", import.meta.url).pathname;
const hero = `${repo}docs/hero.jpg`;
const out = `${repo}crates/openstrike-psp/assets`;
const IMPACT = "/System/Library/Fonts/Supplemental/Impact.ttf";
const HELV = "/System/Library/Fonts/HelveticaNeue.ttc";

if (!existsSync(hero)) {
  console.error(`missing source shot: ${hero}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });

async function magick(args: string[]): Promise<void> {
  const child = Bun.spawn(["magick", ...args], { stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`ImageMagick failed with exit ${status}`);
}

// PIC1 — full-screen backdrop: darkened dust courtyard, left→right scrim so
// the lime/white wordmark reads, a footer band for the tagline.
await magick([
  hero,
  "-resize", "480x272^", "-gravity", "center", "-extent", "480x272", "-modulate", "78,88",
  "(", "-size", "480x272", "gradient:rgba(5,8,12,0.86)-rgba(5,8,12,0.28)", ")",
  "-compose", "over", "-composite",
  "(", "-size", "480x272", "xc:none", "-fill", "rgba(4,7,10,0.55)",
  "-draw", "rectangle 0,214 480,272", ")", "-composite",
  "-font", IMPACT, "-gravity", "West",
  "-fill", "#b8f34a", "-pointsize", "62", "-annotate", "+28-16", "OPEN",
  "-fill", "#e8f0f2", "-pointsize", "62", "-annotate", "+28+42", "STRIKE",
  "-font", HELV, "-fill", "#8fa3ad", "-pointsize", "13", "-annotate", "+30+96", "TACTICAL  OPERATIONS",
  "-gravity", "SouthWest", "-fill", "#8fa3ad", "-pointsize", "11", "-annotate", "+12+10",
  "A CS-shaped FPS in TypeScript · PocketJS · Pocket3D",
  `${out}/PIC1.png`,
]);

console.log(`wrote ${out}/PIC1.png (480x272)`);
