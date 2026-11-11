import {
  createSignal,
  createRenderEffect,
  onCleanup,
  For,
  Show,
} from "solid-js";
import {
  AuxiliarySurface,
  Image,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/solid";
import { hasFeature } from "@pocketjs/framework/platform";
import { createGesture } from "@pocketjs/framework/gesture";
import { strike, type RadarState } from "./sdk.ts";
import {
  createTacticalTouch,
  MAP_RECT,
  mapPoint,
  unmapPoint,
} from "./tactical-touch.ts";

export default function Radar() {
  const [state, setState] = createSignal<RadarState | undefined>(
    strike.radar(),
  );
  const [live, setLive] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [mark, setMark] = createSignal<{ x: number; y: number }>();
  const [pressed, setPressed] = createSignal<string>();
  let image: NodeMirror | undefined;
  let panel: NodeMirror | undefined;
  const cx = () => (zoom() === 1 ? 104 : (state()?.x ?? 104));
  const cy = () => (zoom() === 1 ? 76 : (state()?.y ?? 76));
  const x = (v: number) => mapPoint(v, cx(), MAP_RECT.w, zoom());
  const y = (v: number) => mapPoint(v, cy(), MAP_RECT.h, zoom());
  const touch = createTacticalTouch({
    enabled: () => live(),
    input: strike.touchInput,
    pressed: setPressed,
    zoom: () => setZoom((z) => (z === 1 ? 2 : z === 2 ? 4 : 1)),
    mark: (x, y) =>
      setMark({
        x: unmapPoint(x, cx(), MAP_RECT.w, zoom()),
        y: unmapPoint(y, cy(), MAP_RECT.h, zoom()),
      }),
    clear: () => setMark(undefined),
  });
  onCleanup(
    strike.onRadar((s) => {
      if (s?.map !== state()?.map) {
        touch.cancel();
        setMark(undefined);
        setZoom(1);
      }
      setState(s);
    }),
  );
  onCleanup(
    strike.onTick((s) => {
      const active = s.phase === "live" && s.alive && !strike.touchBlocked();
      if (!active && live()) touch.cancel();
      setLive(active);
    }),
  );
  onCleanup(touch.cancel);
  if (hasFeature("input.touch.auxiliary"))
    createGesture({
      surface: "auxiliary",
      region: { node: () => panel },
      onDown: touch.down,
      onMove: touch.move,
      onUp: touch.up,
      onCancel: touch.cancel,
    });
  createRenderEffect(() => {
    const s = state();
    if (image && s) getOps().setImage(image.id, s.texture);
  });
  return (
    <AuxiliarySurface>
      <View
        ref={(node) => (panel = node)}
        class="relative w-[320] h-[240] bg-[#071019]"
      >
        <Text class="absolute left-2 top-1 text-xs font-bold tracking-wide text-[#b8f34a]">
          TACTICAL MAP
        </Text>
        <Text class="absolute right-2 top-1 text-xs text-[#8fa3ad]">N ↑</Text>
        <Text class="absolute left-2 top-5 text-xs text-[#e8f0f2]">
          {state()
            ? `${state()!.map.toUpperCase()} · ${state()!.loading < 1 ? "LOADING" : "TRAINING"}`
            : "SELECT AN OPERATION ON TOP SCREEN"}
        </Text>
        <View class="absolute left-2 top-10 w-[208] h-[152] overflow-hidden bg-[#0a131a]">
          <Image
            ref={(node) => {
              image = node;
              if (state()) getOps().setImage(node.id, state()!.texture);
            }}
            style={{
              posType: 1,
              insetL: x(0),
              insetT: y(0),
              width: 256 * zoom(),
              height: 256 * zoom(),
              opacity: state() ? 1 : 0,
            }}
          />
          <For each={Array.from({ length: 16 }, (_, i) => i)}>
            {(i) => (
              <View
                class="absolute w-1.5 h-1.5 rounded-full"
                style={{
                  insetL: x(state()?.bots[i]?.x ?? 0) - 3,
                  insetT: y(state()?.bots[i]?.y ?? 0) - 3,
                  opacity: state()?.bots[i] ? 1 : 0,
                  bgColor:
                    Math.abs(state()?.bots[i]?.height ?? 0) > 96
                      ? "#bf864b"
                      : "#f45b57",
                }}
              />
            )}
          </For>
          <Show when={state()}>
            {(s) => (
              <>
                <View
                  class="absolute w-3 h-3 rounded-full bg-[#b8f34a40]"
                  style={{ insetL: x(s().x) - 6, insetT: y(s().y) - 6 }}
                />
                <View
                  class="absolute w-1.5 h-1.5 rounded-full bg-[#b8f34a]"
                  style={{ insetL: x(s().x) - 3, insetT: y(s().y) - 3 }}
                />
                <View
                  class="absolute w-1 h-1 bg-[#e8f0f2]"
                  style={{
                    insetL: x(s().x) - Math.sin(s().yaw) * 10 - 2,
                    insetT: y(s().y) - Math.cos(s().yaw) * 10 - 2,
                  }}
                />
              </>
            )}
          </Show>
          <Show when={mark()}>
            {(m) => (
              <>
                <View
                  class="absolute w-3 h-3 border-[#fbbf24]"
                  style={{ insetL: x(m().x) - 6, insetT: y(m().y) - 6 }}
                />
                <Text
                  class="absolute text-xs text-[#fbbf24]"
                  style={{ insetL: x(m().x) + 8, insetT: y(m().y) - 7 }}
                >
                  MARK
                </Text>
              </>
            )}
          </Show>
          <Show when={!state()}>
            <View class="absolute inset-0 flex-col justify-center items-center gap-2">
              <Text class="text-xs text-[#8fa3ad]">CIRCLE PAD MOVE</Text>
              <Text class="text-xs text-[#8fa3ad]">X / B / Y / A AIM</Text>
              <Text class="text-xs text-[#8fa3ad]">R FIRE · L JUMP</Text>
              <Text class="text-xs text-[#8fa3ad]">C-STICK AIM ON NEW 3DS</Text>
            </View>
          </Show>
        </View>
        <For each={["fire", "reload", "jump", "walk"] as const}>
          {(action, i) => (
            <View
              class="absolute left-[224] w-[88] h-8 rounded-sm items-center justify-center"
              style={{
                insetT: 40 + i() * 40,
                opacity: live() ? 1 : 0.35,
                bgColor: pressed() === action ? "#486326" : "#20313e",
              }}
            >
              <Text class="text-xs font-bold text-[#e8f0f2]">
                {action === "walk" ? "WALK (HOLD)" : action.toUpperCase()}
              </Text>
            </View>
          )}
        </For>
        <View class="absolute left-2 top-[200] w-[68] h-8 rounded-sm items-center justify-center bg-[#20313e]">
          <Text class="text-xs font-bold text-[#b8f34a]">{zoom()}× MAP</Text>
        </View>
        <View class="absolute left-[84] top-[200] w-[92] h-8 rounded-sm items-center justify-center bg-[#20313e]">
          <Text class="text-xs text-[#fbbf24]">CLEAR MARK</Text>
        </View>
        <View class="absolute left-[184] top-[201] flex-col gap-1">
          <Text class="text-xs text-[#8fa3ad]">DRAG MAP TO AIM</Text>
          <Text class="text-xs text-[#8fa3ad]">TAP TO MARK</Text>
        </View>
      </View>
    </AuxiliarySurface>
  );
}
