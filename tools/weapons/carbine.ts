// Carbine: a modern 5.56 assault rifle (M4 / MCX class): monolithic railed upper with a slotted free-float handguard,
// AR-pattern lower and magazine, adjustable stock on a buffer tube, holographic sight, and a reciprocating
// charging handle on the left (so the action shows from the first-person view).
import { type Kit, type V2, rect } from "./kit.ts";
import { type HandPose, arm, describeHand, fitSupport } from "./arms.ts";
import { type Meta, bufferTube, cartridge, foldedSight, handguard, holoSight, pinX, ports, shell } from "./parts.ts";

export const BORE = 46, DECK = 29, TOP = 70, RAIL = 78;

export function carbine(k: Kit): Meta {
  const travel = 58;
  // --- Upper receiver: ejection port on the right, charging-handle slot on the left.
  k.part("body").mat("anodized").tag("upper");
  shell(k, [[62, DECK], [62, 63], [56, TOP], [-150, TOP], [-150, DECK]], { hw: 15.5, skinL: 4, skinR: 7, bevel: 2.2, holesL: [rect(-142, -64, 55.5, 61.5, 1.5)], holesR: [rect(-130, -72, 39, 57, 3)] });
  if (k.hi) {
    // Open dust cover, its hinge, the case deflector.
    k.box([15.5, 20.5, -130], [17.3, 38, -72], 0.7);
    k.cyl([16.4, 38.2, -132], [16.4, 38.2, -70], 1.6, 6, { crease: 50 });
    k.extrude([[15, -70], [15, -46], [21, -63]], { plane: "xz", from: 40, to: 58, bevel: 1 });
    // Side reinforcement ribs.
    k.box([-16.6, 32, -52], [-15, 50, 40], 0.8);
    k.box([15, 32, -40], [16.6, 50, 40], 0.8);
  }
  k.rail(56, -470, RAIL);

  // --- Lower receiver and magazine well.
  k.tag("lower");
  k.extrude([[62, DECK + 1], [-172, DECK + 1], [-176, 25], [-176, 12], [-168, 4], [-165, -42], [-100, -34], [-97, -5], [-38, -5], [12, 1], [24, 4], [42, 15], [62, 18]], { from: -13, to: 13, bevel: 1.6 });
  k.extrude([[-169.5, 21], [-169.5, 4], [-166.5, -44], [-98.5, -35.5], [-95.5, 21]], { from: -14.8, to: 14.8, bevel: 2.2 });
  k.extrude([[-168, -35], [-167.3, -46], [-97.6, -37.3], [-97, -27]], { from: -16.2, to: 16.2, bevel: 1.6 });
  // Receiver end plate.
  k.box([-15, 17, 60], [15, 66, 64.5], 1.5);
  // Trigger guard, trigger.
  k.mat("polymer");
  k.extrude([[-97, -29], [-38, -26.5], [-38, -31], [-97, -34]], { from: -7, to: 7, bevel: 1 });
  k.mat("gunmetal");
  k.extrude([[-64, -3], [-56.5, -3], [-58, -12], [-61, -20], [-64.5, -23.5], [-66.5, -22], [-64.5, -13]], { from: -3.2, to: 3.2, bevel: 0.9 });
  if (k.hi) {
    // Takedown and pivot pins, trigger pins, selector, bolt catch, magazine release.
    for (const [z, y, r] of [[44, 23, 3.4], [-170, 20, 3.4], [-56, 8, 2], [-28, 14, 2]]) {
      pinX(k, z, y, -13.8, -12.5, r);
      pinX(k, z, y, 12.5, 13.8, r);
    }
    pinX(k, -6, 12, -15.2, -12.5, 4.6, 10);
    k.box([-16.4, 9.8, -24], [-14.6, 14.2, -4], 0.7);
    pinX(k, -6, 12, 12.5, 14.6, 4.6, 10);
    k.box([-16.2, 12, -92], [-14.2, 27, -80], 0.8);
    k.box([-15.6, 4, -91], [-14.2, 12, -82], 0.6);
    pinX(k, -84, 9, 14.2, 16.6, 4.2, 10);
    k.box([14.4, 1, -122], [15.6, 14, -98], 0.5);
  }

  // --- Pistol grip.
  k.mat("polymer").tag("grip");
  const grip: V2[] = [[15, 2], [16.5, -8], [23, -32], [33, -70], [39, -93], [36, -98], [-10, -102], [-13.5, -98], [-18, -78], [-23.5, -52], [-30, -30], [-37.5, -24], [-38, -3]];
  k.extrude(grip, { from: -14.2, to: 14.2, bevel: 5, round: k.hi ? 3 : 1, crease: 42 });
  if (k.hi) {
    k.mat("rubber");
    k.extrude([[14, -14], [21, -40], [29, -70], [33, -88], [-9, -92], [-14, -76], [-19, -52], [-24, -34], [-20, -20]], { from: -15, to: 15, bevel: 1.2 });
  }

  // --- Buffer tube and stock.
  bufferTube(k, 62, 236, BORE);
  k.mat("polymer").tag("stock");
  k.extrude([[102, 62], [112, 63.5], [252, 63.5], [252, -38], [240, -38], [150, 25], [102, 28]], { from: -15.5, to: 15.5, bevel: 4, round: k.hi ? 2 : 1, crease: 50, holes: k.hi ? [[[182, 20], [236, 20], [236, -16]]] : undefined });
  if (k.hi) {
    // Adjustment lever, sling socket.
    k.extrude([[106, 25], [140, 23], [136, 15], [112, 17]], { from: -6, to: 6, bevel: 1.5 });
    k.mat("gunmetal");
    k.cyl([-16.2, 30, 228], [16.2, 30, 228], 6.5, 10, { bevel: 1, crease: 50 });
  }
  k.mat("rubber");
  k.extrude([[251, 65], [256, 66], [261, 61], [261, -35], [256, -40], [251, -39]], { from: -16, to: 16, bevel: 3, round: k.hi ? 2 : 1, crease: 50 });

  // --- Barrel, gas system, muzzle device.
  k.mat("gunmetal").tag("barrel");
  const rs = k.segs(16, 8);
  k.lathe([[-140, 13], [-164, 13], [-164, 10], [-318, 10], [-318, 13], [-346, 13], [-346, 9], [-486, 9], [-486, 7], [-492, 7]], { at: [0, BORE, 0], segs: rs });
  if (k.hi) {
    k.lathe([[-150, 3], [-334, 3]], { at: [0, BORE + 16.5, 0], segs: 8, crease: 50 });
    k.box([-6, BORE + 9, -344], [6, BORE + 20.5, -320], 1.5);
  }
  k.lathe([[-488, 3.4], [-488, 10.5], [-496, 10.5], [-498, 9.2], [-502, 9.2], [-504, 11.5], [-531, 11.5], [-535, 10], [-535, 3.4]], { at: [0, BORE, 0], segs: rs, closed: true });
  ports(k, 0, BORE, 11.5, -509, -527, 4.4, [0, 60, 120, 180, 240, 300]);
  k.mat("void");
  k.lathe([[-490, 3.3], [-522, 3.3]], { at: [0, BORE, 0], segs: 8 });

  // --- Handguard and sights.
  k.mat("anodized").tag("handguard");
  handguard(k, { z0: -150, z1: -472, hw: 20, top: TOP, bot: 23, c: 11 });
  if (k.hi) {
    // Barrel nut collar, front cap ring, handguard screws.
    k.lathe([[-146, 21.5], [-156, 21.5], [-158, 19.5]], { at: [0, BORE, 0], segs: 16, phase: 22.5 });
    for (const z of [-160, -172]) {
      pinX(k, z, 30, -21, -19, 2.4);
      pinX(k, z, 30, 19, 21, 2.4);
    }
  }
  foldedSight(k, -436, RAIL, 1);
  const sight = holoSight(k, -30, RAIL);

  // --- Magazine.
  k.part("mag").mat("polymer_tan").tag("mag");
  k.extrude([[-102, 18], [-102, -42], [-104.5, -80], [-110, -118], [-118, -150], [-178, -135], [-172, -112], [-166, -82], [-162, -45], [-162, 18]], { from: -11.3, to: 11.3, bevel: 1.6 });
  k.extrude([[-115.8, -146.9], [-117.5, -153.7], [-180.4, -138], [-178.7, -131.2]], { from: -12.6, to: 12.6, bevel: 1.6 });
  if (k.hi) {
    for (const [y, zr, zf] of [[-62, -105, -161.5], [-78, -106.5, -163.5], [-94, -108.5, -166.5], [-110, -111, -169.5]]) {
      for (const s of [-1, 1]) k.extrude([[zr, y + 4], [zr - 1, y - 4], [zf - 1.5, y - 2], [zf, y + 6]], { from: s * 11, to: s * 12.2, bevel: 0.5 });
    }
    cartridge(k, [2.6, 19.5, -103], 4.8, 57);
    k.mat("polymer");
    k.box([-8, 14, -160], [8, 19.2, -104], 1);
  }

  // --- Bolt carrier (in the ejection port) and the charging handle (left).
  k.part("bolt").mat("steel").tag("bolt");
  k.lathe([[-60, 9.4], [-96, 9.4], [-97, 8.6], [-103, 8.6], [-104, 9.4], [-126, 9.4], [-127, 7], [-134, 7]], { at: [4, 48, 0], segs: k.segs(14, 8) });
  k.mat("gunmetal");
  k.box([-27, 56.6, -139], [-6, 60.4, -131], 0.8);
  k.extrude([[-22, -142], [-31, -140], [-33, -128], [-22, -126]], { plane: "xz", from: 52.5, to: 64.5, bevel: 1.6 });

  // --- Arms.
  const right: HandPose = {
    side: "R",
    wrist: [1, -26, 62],
    fwd: [0.259, -0.2415, -0.935],
    back: [1, 0, 0.2],
    fingers: [{ curl: [10, 62, 45], spread: 22 }, { curl: [80, 80, 25] }, { curl: [80, 82, 25] }, { curl: [82, 82, 25] }],
    thumb: [[-16, -8, 8], [-22, -9, -18], [-21, -11, -42]],
    elbow: [120, -170, 290],
  };
  // The support hand is fitted to the handguard's section (arms.ts fitSupport): proximal phalanges under it, the
  // middle ones up its right face, tips below the rail, the thumb's base within reach of the left face. The index's
  // end joint is eased by hand (its tip otherwise sinks under the top-right corner).
  const section: [number, number][] = [[-9, TOP], [9, TOP], [20, TOP - 11], [20, 34], [9, 23], [-9, 23], [-20, 34], [-20, TOP - 11]];
  const fit = fitSupport(section, -305, TOP, [-32, 28, -298]);
  const [fa, fb, fd] = fit.pose.fingers[0].curl;
  const left: HandPose = {
    ...fit.pose,
    fingers: [{ curl: [fa, fb - 4, Math.max(8, fd - 22)] }, { curl: [fa, fb, fd] }, { curl: [fa + 2, fb, fd] }, { curl: [fa + 5, fb - 2, fd] }],
    thumb: [[-34, 26, -297], [-29.5, 48, -313], [-27, 60, -333]],
    elbow: [-310, -150, -60],
  };
  if (k.hi && process.env.HANDS) console.log(`support fit: penalty ${fit.penalty.toFixed(1)}, thumb reach ${fit.reach.toFixed(0)} mm`);
  if (k.hi && process.env.HANDS) console.log(`right\n${describeHand(right)}\nleft\n${describeHand(left)}`);
  arm(k, right);
  arm(k, left);

  return { muzzle: [0, BORE, -535], eject: [15.5, 48, -101], ejectDir: [0.9, 0.35, 0.25], eye: [0, sight, 48], gripL: [-10, 26, -300], magOut: [0, -120, -22], boltTravel: travel, hands: { right, left } };
}
