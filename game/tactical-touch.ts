/** Logical 320x240 auxiliary-screen controls. A contact owns its original
 * action until release; sliding into FIRE can never start shooting. */
export const TOUCH = { fire: 1, reload: 2, jump: 4, walk: 8 } as const;
export const MAP_RECT = { x: 8, y: 40, w: 208, h: 152 } as const;
export type Contact = { id: number; x: number; y: number };
type Action = keyof typeof TOUCH | "map" | "zoom" | "clear";

export function touchAction(x: number, y: number): Action | undefined {
  if (x >= 8 && x < 216 && y >= 40 && y < 192) return "map";
  if (x >= 224 && x < 312 && y >= 40 && y < 192) {
    const row = Math.floor((y - 40) / 40);
    if ((y - 40) % 40 < 32)
      return (["fire", "reload", "jump", "walk"] as const)[row];
  }
  if (y >= 200 && y < 232) {
    if (x >= 8 && x < 76) return "zoom";
    if (x >= 84 && x < 176) return "clear";
  }
}

export function createTacticalTouch(callbacks: {
  enabled(): boolean;
  input(buttons: number, dx: number, dy: number): void;
  zoom(): void;
  mark(x: number, y: number): void;
  clear(): void;
  pressed(action: Action | undefined): void;
}) {
  let contact:
    | (Contact & {
        startX: number;
        startY: number;
        action: Action;
        dragged: boolean;
        inside: boolean;
      })
    | undefined;
  const cancel = () => {
    contact = undefined;
    callbacks.input(0, 0, 0);
    callbacks.pressed(undefined);
  };
  return {
    cancel,
    down(c: Contact) {
      if (contact || !callbacks.enabled()) return;
      const action = touchAction(c.x, c.y);
      if (!action) return;
      contact = {
        ...c,
        startX: c.x,
        startY: c.y,
        action,
        dragged: false,
        inside: true,
      };
      callbacks.pressed(action);
      if (action === "fire" || action === "jump" || action === "walk")
        callbacks.input(TOUCH[action], 0, 0);
    },
    move(c: Contact) {
      if (!contact || contact.id !== c.id) return;
      if (!callbacks.enabled()) {
        cancel();
        return;
      }
      const t = contact;
      if (t.action === "map") {
        const dragged = Math.hypot(c.x - t.startX, c.y - t.startY) >= 4;
        if (dragged || t.dragged) {
          // Deliver the threshold-crossing motion once, then incremental deltas.
          callbacks.input(
            0,
            c.x - (t.dragged ? t.x : t.startX),
            c.y - (t.dragged ? t.y : t.startY),
          );
          t.dragged = true;
        }
      } else if (touchAction(c.x, c.y) !== t.action) {
        // Leaving a button cancels it for the rest of this contact.
        t.inside = false;
        callbacks.input(0, 0, 0);
        callbacks.pressed(undefined);
      }
      t.x = c.x;
      t.y = c.y;
    },
    up(c: Contact) {
      if (!contact || contact.id !== c.id) return;
      const t = contact;
      const valid =
        callbacks.enabled() && t.inside && touchAction(c.x, c.y) === t.action;
      cancel();
      if (!valid) return;
      if (t.action === "reload") {
        callbacks.input(TOUCH.reload, 0, 0);
        callbacks.input(0, 0, 0);
      }
      if (t.action === "zoom") callbacks.zoom();
      if (t.action === "clear") callbacks.clear();
      if (
        t.action === "map" &&
        !t.dragged &&
        Math.hypot(c.x - t.startX, c.y - t.startY) < 4
      )
        callbacks.mark(c.x - MAP_RECT.x, c.y - MAP_RECT.y);
    },
  };
}

/** Shared inverse transforms keep waypoint taps aligned with the zoomed map. */
export function mapPoint(
  value: number,
  center: number,
  size: number,
  zoom: number,
) {
  return size / 2 + (value - center) * zoom;
}
export function unmapPoint(
  value: number,
  center: number,
  size: number,
  zoom: number,
) {
  return center + (value - size / 2) / zoom;
}
