import { For, onCleanup } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import * as hot from "@pocketjs/framework/hot";
import { reportAppAction } from "@pocketjs/framework/host";
import { strike } from "./sdk.ts";
import { BUTTON, CONTROL } from "./primary-touch.ts";
import { usePrimaryTouch } from "./primary-touch-gesture.ts";

export default function TouchControls() {
  let stick: NodeMirror | undefined, nub: NodeMirror | undefined;
  const labels: Partial<Record<keyof typeof BUTTON, NodeMirror>> = {};
  let completed = 0;
  const enabled = () =>
    strike.state().phase === "live" &&
    strike.state().alive &&
    !strike.touchBlocked();
  const touch = usePrimaryTouch(
    {
      enabled,
      input: strike.primaryInput,
      visual(x, y, buttons, origin) {
        hot.prop(
          stick,
          "translateX",
          origin ? Math.max(48, Math.min(115, origin.x)) - 78 : 0,
        );
        hot.prop(
          stick,
          "translateY",
          origin ? Math.max(204, Math.min(270, origin.y)) - 244 : 0,
        );
        hot.prop(nub, "translateX", x * 30);
        hot.prop(nub, "translateY", -y * 30);
        for (const action of ["fire", "jump", "walk"] as const)
          hot.prop(
            labels[action],
            "opacity",
            buttons & BUTTON[action] ? 1 : 0.55,
          );
      },
      completed() {
        reportAppAction("openstrike_touch", ++completed);
      },
    },
  );
  let active = false;
  onCleanup(
    strike.onTick(() => {
      const next = enabled();
      if (active && !next) touch.cancel();
      active = next;
    }),
  );
  return (
    <View class="absolute inset-0" style={{ zIndex: 30 }}>
      <View
        ref={(el) => (stick = el)}
        class="absolute items-center justify-center"
        style={{
          insetL: 36,
          insetT: 202,
          width: 84,
          height: 84,
          radius: 42,
          bgColor: "#e8f0f215",
          borderColor: "#e8f0f255",
          borderWidth: 1,
        }}
      >
        <View
          ref={(el) => (nub = el)}
          style={{ width: 32, height: 32, radius: 16, bgColor: "#e8f0f275" }}
        />
      </View>
      <Text
        class="absolute text-xs"
        style={{ insetL: 58, insetT: 292, textColor: "#8fa3ad" }}
      >
        MOVE
      </Text>
      <Text
        class="absolute text-xs"
        style={{ insetL: 236, insetT: 284, textColor: "#8fa3ad" }}
      >
        DRAG TO AIM
      </Text>
      <For each={["fire", "reload", "jump", "walk"] as const}>
        {(action) => {
          const b = CONTROL[action];
          return (
            <View
              class="absolute items-center justify-center"
              style={{
                insetL: b.x - b.r,
                insetT: b.y - b.r,
                width: b.r * 2,
                height: b.r * 2,
                radius: b.r,
                borderWidth: 1,
                borderColor: action === "fire" ? "#b8f34a99" : "#e8f0f266",
                bgColor: "#05080c66",
              }}
            >
              <Text
                ref={(el) => (labels[action] = el)}
                class="text-xs font-bold"
                style={{
                  textColor: action === "fire" ? "#b8f34a" : "#e8f0f2",
                  opacity: 0.55,
                }}
              >
                {action.toUpperCase()}
              </Text>
            </View>
          );
        }}
      </For>
    </View>
  );
}
