// Shotgun: a tactical semi-automatic 12 gauge (Benelli M4 class): rounded receiver, barrel over a tube magazine, polymer
// forend, pistol-grip stock, ghost-ring rear sight and a winged front post. The `mag` node is a single shell seated in
// the loading port under the receiver (reloads feed shells one by one); `bolt` is the bolt with its handle (right side).
import { type HandPose, arm, fitSupport } from "./arms.ts";
import { type Kit, rect } from "./kit.ts";
import { type Meta, RIFLE_GRIP_HAND, arGrip, pinX, shell } from "./parts.ts";

/** A 12 gauge shell along -z with its brass base at z. */
function shotShell(k: Kit, x: number, y: number, z: number): void {
  const seg = k.segs(12, 6);
  k.mat("brass");
  k.lathe([[z, 10.6], [z - 1.5, 11.1], [z - 2.5, 10.3], [z - 16, 10.3]], { at: [x, y, 0], segs: seg, crease: 40 });
  k.mat("shell_red");
  k.lathe([[z - 15.5, 10.1], [z - 66, 10.1], [z - 70, 8.4]], { at: [x, y, 0], segs: seg, crease: 40 });
}

export function shotgun(k: Kit): Meta {
  const BORE = 46, TUBE = 19, TOP = 64;
  k.part("body").mat("anodized").tag("receiver");
  // Receiver: rounded top, deeper at the front where the magazine tube and the loading port are.
  shell(k, [[72, 22], [72, 52], [60, TOP], [-170, TOP], [-170, 3], [-100, 3], [-96, 22]], { hw: 17, skinL: 3, skinR: 7, bevel: 6, holesR: [rect(-118, -40, 39, 56, 3)] });
  k.rail(40, -110, TOP + 8);
  if (k.hi) {
    k.mat("gunmetal");
    for (const [z, y] of [[40, 30], [-60, 30]]) {
      pinX(k, z, y, -17.8, -16.5, 2.6);
      pinX(k, z, y, 16.5, 17.8, 2.6);
    }
    pinX(k, -128, 22, 16.5, 19, 5, 10);
    // Loading port recess.
    k.mat("void");
    k.box([-10.5, 2.4, -166], [10.5, 4, -104]);
  }
  // Trigger group, guard, trigger, safety.
  k.mat("polymer").tag("lower");
  k.extrude([[40, 23], [-97, 23], [-97, -5], [-38, -5], [12, 1], [24, 4], [40, 12]], { from: -13, to: 13, bevel: 2 });
  k.extrude([[-97, -29], [-38, -26.5], [-38, -31], [-97, -34]], { from: -7, to: 7, bevel: 1 });
  k.mat("gunmetal");
  k.extrude([[-64, -3], [-56.5, -3], [-58, -12], [-61, -20], [-64.5, -23.5], [-66.5, -22], [-64.5, -13]], { from: -3.2, to: 3.2, bevel: 0.9 });
  pinX(k, -30, 8, -14.6, 14.6, 3.6, 8);
  arGrip(k);
  // Fixed stock: a slim spine from the receiver to the butt, a strut up from the grip, recoil pad.
  k.mat("polymer").tag("stock");
  k.extrude([[70, 54], [318, 40], [318, -62], [302, -62], [232, -6], [176, 6], [70, 22]], { from: -14, to: 14, bevel: 4, round: k.hi ? 2 : 1, crease: 50, holes: k.hi ? [[[196, 10], [292, 4], [292, -36], [240, -2]]] : undefined });
  k.mat("rubber");
  k.extrude([[317, 42], [326, 42], [332, 36], [332, -58], [326, -64], [317, -64]], { from: -14.5, to: 14.5, bevel: 3, round: k.hi ? 2 : 1, crease: 50 });
  // Barrel (with a bore), magazine tube and cap, barrel clamp.
  k.mat("gunmetal").tag("barrel");
  const rs = k.segs(16, 8);
  k.lathe([[-160, 9.3], [-160, 13.5], [-190, 13.5], [-192, 12], [-596, 11.6], [-600, 10.8], [-600, 9.3]], { at: [0, BORE, 0], segs: rs, closed: true });
  k.mat("void");
  k.lathe([[-170, 9.2], [-560, 9.2]], { at: [0, BORE, 0], segs: 8 });
  k.mat("gunmetal");
  k.lathe([[-165, 13], [-548, 13], [-550, 14.5], [-566, 14.5], [-570, 12], [-572, 6]], { at: [0, TUBE, 0], segs: rs });
  k.extrude([[-16, TUBE - 2], [-16, BORE + 6], [-9, BORE + 15], [9, BORE + 15], [16, BORE + 6], [16, TUBE - 2], [9, TUBE - 16.5], [-9, TUBE - 16.5]], { plane: "xy", from: -536, to: -520, bevel: 1.5 });
  // Forend: a polymer shroud around the tube up to the barrel's flanks, with grip ribs.
  k.mat("polymer").tag("forend");
  k.extrude([[-13, 1], [13, 1], [21, 9], [21, 40], [15, 47], [-15, 47], [-21, 40], [-21, 9]], { plane: "xy", from: -385, to: -172, bevel: 3 });
  if (k.hi) for (let z = -200; z >= -360; z -= 20) for (const s of [-1, 1]) k.box([s * 20.4, 12, z - 5], [s * 22, 37, z + 5], 0.8);
  // Sights: ghost ring with wings at the back of the receiver, winged post on the barrel.
  k.mat("gunmetal").tag("sights");
  const SIGHT = TOP + 20;
  k.box([-12, TOP - 1, 44], [12, TOP + 8, 66], 1.5);
  k.lathe([[58, 7], [58, 10.5], [52, 10.5], [52, 7]], { at: [0, SIGHT, 0], segs: k.segs(16, 8), closed: true });
  k.box([-2.5, TOP + 7, 52.5], [2.5, SIGHT - 9.5, 57.5]);
  for (const s of [-1, 1]) k.extrude([[64, TOP + 7], [64, SIGHT + 6], [58, SIGHT + 12], [48, SIGHT + 12], [44, TOP + 7]], { from: s * 13, to: s * 16, bevel: 0.8 });
  k.box([-9, BORE + 10, -592], [9, BORE + 16, -566], 1.2);
  k.extrude([[-570, BORE + 15], [-570, SIGHT], [-576, SIGHT], [-588, BORE + 15]], { from: -1.6, to: 1.6 });
  for (const s of [-1, 1]) k.extrude([[-566, BORE + 15], [-566, SIGHT + 3], [-574, SIGHT + 6], [-584, SIGHT + 6], [-592, BORE + 15]], { from: s * 7, to: s * 9.5, bevel: 0.6 });

  // The shell being loaded (seated in the port; the game moves it in from magOut).
  k.part("mag").tag("shell");
  shotShell(k, 0, TUBE - 2, -98);

  // Bolt and its handle.
  k.part("bolt").mat("steel").tag("bolt");
  k.lathe([[-36, 9.6], [-70, 9.6], [-71, 8.6], [-78, 8.6], [-79, 9.6], [-116, 9.6], [-118, 7.5]], { at: [5, 47.5, 0], segs: k.segs(14, 8) });
  k.mat("gunmetal");
  k.cyl([12, 47.5, -104], [34, 47.5, -104], 4.2, 8, { bevel: 0.8, crease: 50 });
  k.cyl([30, 47.5, -104], [40, 49, -100], 6.2, 8, { bevel: 1.4, crease: 50 });

  const section: [number, number][] = [[-15, 58], [15, 58], [21, 40], [21, 9], [13, 1], [-13, 1], [-21, 9], [-21, 40]];
  const fit = fitSupport(section, -285, 56, [-33, 14, -278]);
  const [fa, fb, fd] = fit.pose.fingers[0].curl;
  const left: HandPose = { ...fit.pose, fingers: [{ curl: [fa, fb - 4, Math.max(8, fd - 22)] }, { curl: [fa, fb, fd] }, { curl: [fa + 2, fb, fd] }, { curl: [fa + 5, fb - 2, fd] }], thumb: [[-35, 12, -277], [-31, 34, -292], [-28, 47, -311]], elbow: [-310, -150, -60] };
  if (k.hi && process.env.HANDS) console.log(`shotgun support fit: penalty ${fit.penalty.toFixed(1)}, thumb reach ${fit.reach.toFixed(0)} mm`);
  arm(k, RIFLE_GRIP_HAND);
  arm(k, left);
  return { muzzle: [0, BORE, -600], eject: [17, 47.5, -79], ejectDir: [0.9, 0.3, 0.3], eye: [0, SIGHT, 150], gripL: [-10, 6, -285], magOut: [0, -75, 25], boltTravel: 70 };
}
