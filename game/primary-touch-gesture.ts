import { onCleanup } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { touches } from "@pocketjs/framework/touch";
import { createPrimaryTouch } from "./primary-touch.ts";

/** Component-scoped input lifecycle, independent of the control artwork. */
export function usePrimaryTouch(
  callbacks: Parameters<typeof createPrimaryTouch>[0],
) {
  const touch = createPrimaryTouch(callbacks, touches().map((c) => c.id));
  onFrame(() => touch.sync(touches()));
  onCleanup(() => touch.cancel());
  createGesture({
    onDown: touch.down,
    onMove: touch.move,
    onUp: touch.up,
    onCancel: (c) => touch.cancel(c.id),
  });
  return touch;
}
