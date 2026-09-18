import { expect, test } from "bun:test";
import type { NativeStrike, StrikeState } from "../game/sdk.ts";

test("tick dispatch keeps subscription snapshots and the published state", async () => {
  const globals = globalThis as typeof globalThis & { strike?: NativeStrike };
  const previous = globals.strike;
  const native = {} as NativeStrike;
  globals.strike = native;
  try {
    const { strike } = await import("../game/sdk.ts");
    const first: StrikeState = { ...strike.state(), time: 1 };
    const second: StrikeState = { ...first, time: 2 };
    const seen: string[] = [];
    let removeB = () => {};
    let removeC = () => {};
    const c = (s: StrikeState) => seen.push(`c:${s.time}`);
    const removeA = strike.onTick((s) => {
      expect(strike.state()).toBe(s);
      seen.push(`a:${s.time}`);
      removeB();
      removeC = strike.onTick(c);
    });
    const b = (s: StrikeState) => seen.push(`b:${s.time}`);
    removeB = strike.onTick(b);
    strike.onTick(b); // Set semantics: duplicate subscriptions run once.
    native.__dispatch!(first, []);
    expect(seen).toEqual(["a:1", "b:1"]);
    native.__dispatch!(second, []);
    expect(seen).toEqual(["a:1", "b:1", "a:2", "c:2"]);
    expect(first.time).toBe(1);
    removeA();
    removeC();
    removeB(); // Repeated cleanup must be harmless.

    const removeEvent = strike.on("roundReset", () => {
      removeC = strike.onTick(c);
    });
    native.__dispatch!(first, [{ type: "roundReset" }]);
    expect(seen.at(-1)).toBe("c:1"); // Event changes precede the tick snapshot.
    removeEvent();
    removeC();
    const count = seen.length;
    native.__dispatch!(second, []);
    expect(seen.length).toBe(count);
  } finally {
    if (previous) globals.strike = previous;
    else delete globals.strike;
  }
});
