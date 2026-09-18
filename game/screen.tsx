// Shared product screen. Every native 3D host mounts this same menu/HUD over
// its target-specific Pocket3D renderer.

import { createSignal, onCleanup, Show } from "solid-js";
import Hud from "./hud.tsx";
import MainMenu from "./menu.tsx";
import { strike } from "./sdk.ts";

export default function OpenStrikeScreen() {
  let menu = strike.state().phase === "menu";
  const [inMenu, setInMenu] = createSignal(menu);
  onCleanup(strike.onTick((state) => {
    const next = state.phase === "menu";
    if (next !== menu) { menu = next; setInMenu(next); }
  }));
  return (
    <Show when={!inMenu()} fallback={<MainMenu />}>
      <Hud />
    </Show>
  );
}
