// DMR: a 7.62 marksman rifle (SR-25 / SCAR-20 class): long slotted handguard, heavy barrel with a brake, precision
// stock with a raised cheek piece, 20-round box magazine, folded bipod, and a magnified scope tube on a tall mount.
import { type HandPose, arm, fitSupport } from "./arms.ts";
import { type Kit, rect } from "./kit.ts";
import { type Meta, RIFLE_GRIP_HAND, arGrip, arTrigger, bufferTube, cartridge, handguard, pinX, ports, scope, shell } from "./parts.ts";

export function dmr(k: Kit): Meta {
  const BORE = 48, DECK = 30, TOP = 72, RAIL = 80;
  k.part("body").mat("cerakote_fde").tag("upper");
  shell(k, [[62, DECK], [62, 65], [56, TOP], [-185, TOP], [-185, DECK]], { hw: 16.5, skinL: 4, skinR: 7, bevel: 2.4, holesL: [rect(-172, -78, 57.5, 63.5, 1.5)], holesR: [rect(-152, -84, 40, 59, 3)] });
  if (k.hi) {
    k.box([16.5, 21.5, -152], [18.3, 39, -84], 0.7);
    k.extrude([[16, -82], [16, -56], [22, -74]], { plane: "xz", from: 41, to: 60, bevel: 1 });
    k.box([-17.6, 33, -60], [-16, 52, 40], 0.8);
    k.box([16, 33, -46], [17.6, 52, 40], 0.8);
  }
  k.mat("anodized");
  k.rail(56, -185, RAIL);
  k.mat("cerakote_fde").tag("lower");
  k.extrude([[62, DECK + 1], [-204, DECK + 1], [-208, 26], [-208, 12], [-198, 4], [-195, -40], [-100, -34], [-97, -5], [-38, -5], [12, 1], [24, 4], [42, 15], [62, 18]], { from: -14, to: 14, bevel: 1.6 });
  k.extrude([[-199.5, 21], [-199.5, 4], [-196.5, -42], [-98.5, -35.5], [-95.5, 21]], { from: -15.8, to: 15.8, bevel: 2.2 });
  k.extrude([[-198, -33], [-197.3, -44], [-97.6, -37.3], [-97, -27]], { from: -17.2, to: 17.2, bevel: 1.6 });
  k.box([-16, 17, 60], [16, 68, 64.5], 1.5);
  arTrigger(k);
  if (k.hi) {
    for (const [z, y, r] of [[44, 23, 3.6], [-202, 20, 3.6], [-56, 8, 2], [-28, 14, 2]]) {
      pinX(k, z, y, -14.8, -13.5, r);
      pinX(k, z, y, 13.5, 14.8, r);
    }
    pinX(k, -6, 12, -16.2, -13.5, 4.6, 10);
    k.box([-17.4, 9.8, -24], [-15.6, 14.2, -4], 0.7);
    k.box([-17.2, 12, -92], [-15.2, 27, -80], 0.8);
    pinX(k, -84, 9, 15.2, 17.6, 4.2, 10);
  }
  arGrip(k);
  // Precision stock: tube housing, raised cheek piece, hooked toe, thick pad.
  bufferTube(k, 62, 250, BORE);
  k.mat("polymer").tag("stock");
  k.extrude([[96, 64], [270, 64], [270, -46], [252, -46], [236, -22], [176, -22], [150, 10], [96, 30]], { from: -16.5, to: 16.5, bevel: 4, round: k.hi ? 2 : 1, crease: 50, holes: k.hi ? [rect(190, 244, -6, 22, 5)] : undefined });
  k.extrude([[112, 62], [118, 76], [214, 76], [222, 62]], { from: -15, to: 15, bevel: 4, round: k.hi ? 2 : 1, crease: 50 });
  if (k.hi) {
    k.mat("gunmetal");
    k.cyl([17, 44, 160], [21, 44, 160], 7, 10, { bevel: 1, crease: 50 });
    k.cyl([17, 10, 258], [21, 10, 258], 7, 10, { bevel: 1, crease: 50 });
  }
  k.mat("rubber");
  k.extrude([[269, 66], [276, 67], [283, 61], [283, -43], [276, -48], [269, -47]], { from: -17, to: 17, bevel: 3, round: k.hi ? 2 : 1, crease: 50 });
  // Heavy barrel, gas block, brake.
  k.mat("gunmetal").tag("barrel");
  const rs = k.segs(16, 8);
  k.lathe([[-176, 14], [-198, 14], [-198, 11.5], [-400, 11.5], [-400, 14.5], [-430, 14.5], [-430, 10.5], [-716, 10.5], [-716, 8], [-722, 8]], { at: [0, BORE, 0], segs: rs });
  k.lathe([[-718, 4.2], [-718, 11], [-728, 11], [-730, 9], [-760, 9], [-762, 11], [-767, 11], [-767, 4.2]], { at: [0, BORE, 0], segs: rs, closed: true });
  if (k.hi) for (const z of [-736, -746, -756]) k.box([-12, BORE - 6.5, z - 3], [12, BORE + 6.5, z + 3], 1);
  ports(k, 0, BORE, 9, -733, -759, 5, [90, 270]);
  k.mat("cerakote_fde").tag("handguard");
  handguard(k, { z0: -185, z1: -545, hw: 21, top: TOP, bot: 24, c: 11, margin: 18 });
  if (k.hi) k.lathe([[-181, 22.5], [-192, 22.5], [-194, 20.5]], { at: [0, BORE, 0], segs: 16, phase: 22.5 });
  // Folded bipod under the handguard.
  k.mat("gunmetal").tag("bipod");
  k.box([-12, 12, -520], [12, 24, -494], 2);
  for (const s of [-1, 1]) k.cyl([s * 11, 14, -500], [s * 15, 9, -318], 5.5, k.segs(8, 6), { bevel: 1, crease: 50 });
  if (k.hi) {
    k.mat("rubber");
    for (const s of [-1, 1]) k.cyl([s * 15, 9, -318], [s * 15.4, 8.6, -300], 6.8, 8, { bevel: 1.5, crease: 50 });
  }
  const sight = scope(k, 40, RAIL, 49);

  k.part("mag").mat("polymer").tag("mag");
  k.extrude([[-104, 18], [-104, -40], [-108, -112], [-188, -106], [-192, -40], [-192, 18]], { from: -12.6, to: 12.6, bevel: 1.6 });
  k.extrude([[-105.5, -108], [-106, -117], [-191, -110.6], [-190.5, -101.6]], { from: -14, to: 14, bevel: 1.6 });
  if (k.hi) {
    for (const y of [-56, -72, -88]) for (const s of [-1, 1]) k.box([s * 12.2, y - 3, -186], [s * 13.5, y + 3, -112], 0.5);
    cartridge(k, [2.8, 19.5, -106], 6, 71);
  }

  k.part("bolt").mat("steel").tag("bolt");
  k.lathe([[-70, 10.4], [-112, 10.4], [-113, 9.6], [-120, 9.6], [-121, 10.4], [-150, 10.4], [-152, 8], [-158, 8]], { at: [4, 49.5, 0], segs: k.segs(14, 8) });
  k.mat("gunmetal");
  k.box([-28, 58.6, -169], [-6, 62.4, -161], 0.8);
  k.extrude([[-23, -172], [-32, -170], [-34, -158], [-23, -156]], { plane: "xz", from: 54.5, to: 66.5, bevel: 1.6 });

  const section: [number, number][] = [[-10, TOP], [10, TOP], [21, TOP - 11], [21, 35], [10, 24], [-10, 24], [-21, 35], [-21, TOP - 11]];
  const fit = fitSupport(section, -300, TOP, [-33, 29, -293]);
  const [fa, fb, fd] = fit.pose.fingers[0].curl;
  const left: HandPose = { ...fit.pose, fingers: [{ curl: [fa, fb - 4, Math.max(8, fd - 22)] }, { curl: [fa, fb, fd] }, { curl: [fa + 2, fb, fd] }, { curl: [fa + 5, fb - 2, fd] }], thumb: [[-35, 27, -292], [-30.5, 49, -308], [-28, 61, -328]], elbow: [-200, -190, 20] };
  if (k.hi && process.env.HANDS) console.log(`dmr support fit: penalty ${fit.penalty.toFixed(1)}, thumb reach ${fit.reach.toFixed(0)} mm`);
  arm(k, RIFLE_GRIP_HAND);
  arm(k, left);
  return { muzzle: [0, BORE, -767], eject: [16.5, 49.5, -118], ejectDir: [0.9, 0.35, 0.25], eye: [0, sight, 110], gripL: [-10, 27, -300], magOut: [0, -125, -10], boltTravel: 66 };
}
