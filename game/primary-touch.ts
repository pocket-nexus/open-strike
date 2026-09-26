/** Contact roles stay bound until release. Look uses distance, movement uses
 * a normalized stick, so neither depends on frame rate or contact order. */
export const BUTTON = { fire: 1, reload: 2, jump: 4, walk: 8 } as const;
export const CONTROL = {
  fire: { x: 424, y: 216, r: 34 },
  reload: { x: 359, y: 281, r: 25 },
  jump: { x: 429, y: 286, r: 25 },
  walk: { x: 173, y: 282, r: 25 },
} as const;
export type Contact = { id: number; x: number; y: number };
type Role = "move" | "look" | keyof typeof BUTTON;
type Owned = Contact & {
  role: Role;
  startX: number;
  startY: number;
  valid: boolean;
  aim: boolean;
};
const within = (c: Contact, b: { x: number; y: number; r: number }) =>
  Math.hypot(c.x - b.x, c.y - b.y) <= b.r;
export function roleAt(c: Contact): Role | undefined {
  for (const role of ["fire", "reload", "jump", "walk"] as const)
    if (within(c, CONTROL[role])) return role;
  if (c.x >= 8 && c.x < 155 && c.y >= 152 && c.y < 312) return "move";
  if (c.x >= 196 && c.x < 480 && c.y >= 76 && c.y < 320) return "look";
}
export function createPrimaryTouch(
  callbacks: {
    enabled(): boolean;
    input(
      mx: number,
      my: number,
      buttons: number,
      dx: number,
      dy: number,
    ): void;
    visual(mx: number, my: number, buttons: number, origin?: Contact): void;
    completed(): void;
  },
  initiallyHeld: readonly number[] = [],
) {
  const ignored = new Set(initiallyHeld);
  const contacts = new Map<number, Owned>();
  let mx = 0,
    my = 0,
    walk = false;
  const buttons = () => {
    let b = walk ? BUTTON.walk : 0;
    for (const c of contacts.values())
      if (c.valid && (c.role === "fire" || c.role === "jump"))
        b |= BUTTON[c.role];
    return b;
  };
  const emit = (dx = 0, dy = 0, extra = 0) => {
    callbacks.input(
      Math.round(mx * 1000),
      Math.round(my * 1000),
      buttons() | extra,
      Math.round(dx * 1024),
      Math.round(dy * 1024),
    );
    const movement = [...contacts.values()].find((c) => c.role === "move");
    callbacks.visual(
      mx,
      my,
      buttons(),
      movement && { id: movement.id, x: movement.startX, y: movement.startY },
    );
  };
  const cancel = (id?: number) => {
    if (id === undefined) {
      contacts.clear();
      mx = my = 0;
      walk = false;
    } else {
      ignored.delete(id);
      if (contacts.get(id)?.role === "move") mx = my = 0;
      contacts.delete(id);
    }
    emit();
  };
  return {
    cancel,
    sync(held: readonly Contact[]) {
      // A recognizer mounted mid-contact never observes that contact's UP.
      // Retire its suppression from snapshots before the host reuses its ID.
      for (const id of ignored)
        if (!held.some((c) => c.id === id)) ignored.delete(id);
    },
    down(c: Contact) {
      if (!callbacks.enabled() || contacts.has(c.id) || ignored.has(c.id))
        return;
      const role = roleAt(c);
      if (!role) return;
      if ([...contacts.values()].some((o) => o.role === role)) return;
      const aim =
        (role === "look" || role === "fire") &&
        ![...contacts.values()].some((o) => o.aim);
      // A second look contact cannot take over when the first releases.
      if (role === "look" && !aim) return;
      contacts.set(c.id, {
        ...c,
        role,
        startX: c.x,
        startY: c.y,
        valid: true,
        aim,
      });
      emit();
    },
    move(c: Contact) {
      const owned = contacts.get(c.id);
      if (!owned) return;
      if (!callbacks.enabled()) {
        cancel();
        return;
      }
      let dx = 0,
        dy = 0;
      if (owned.role === "move") {
        const x = c.x - owned.startX,
          y = c.y - owned.startY;
        const length = Math.hypot(x, y),
          magnitude = Math.max(0, Math.min(1, (length - 5) / 33));
        mx = length > 0 ? (x / length) * magnitude : 0;
        my = length > 0 ? (-y / length) * magnitude : 0;
      } else if (owned.aim) {
        dx = c.x - owned.x;
        dy = c.y - owned.y;
      } else if (owned.role !== "look" && !within(c, CONTROL[owned.role]))
        owned.valid = false;
      owned.x = c.x;
      owned.y = c.y;
      emit(dx, dy);
    },
    up(c: Contact) {
      ignored.delete(c.id);
      const owned = contacts.get(c.id);
      if (!owned) return;
      const valid = callbacks.enabled() && owned.valid;
      if (owned.role === "move") mx = my = 0;
      contacts.delete(c.id);
      if (valid && owned.role === "walk" && within(c, CONTROL.walk))
        walk = !walk;
      if (valid && owned.role === "reload" && within(c, CONTROL.reload))
        emit(0, 0, BUTTON.reload);
      emit();
      if (valid) callbacks.completed();
    },
  };
}
