// Movement, on numbers: the game in the headless renderer in lockstep, on the Range map (src/maps/range.ts), with
// this script as the app that sends the input. The same course is run with frames of 1/30, 1/60 and 1/120 s: the
// player moves in fixed steps (MOVE.step), so every figure must come out the same.
//
//   node tools/test-move.ts [--rates 30,60,120]
// Checked per rate: rest on the ground; run, sprint and crouch speeds; stopping; the jump's height (v² / 2g) and no
// second jump on a held key; air control capped; a 0.1 m wall is not passed at a sprint, nor with frames of 0.1 s; a
// 0.4 m step is walked over, a 0.6 m kerb is not (but jumped onto); a 30 degree ramp is walked, a 60 degree one is
// not; a wall met at 45 degrees is slid along; a 1.4 m tunnel needs a crouch and holds it; a ladder is climbed.
import { MOVE } from "../src/config.ts";
import { RANGE } from "../src/maps/range-course.ts";
import { build } from "./build.ts";
import { checker, startLive, type Live, type Report } from "./lib/live.ts";

const args = process.argv.slice(2);
const rates = (args.includes("--rates") ? args[args.indexOf("--rates") + 1]! : "30,60,120").split(",").map(Number);
const { out } = await build();
const { check, done } = checker();
const f = (v: number) => v.toFixed(3);
const REST = MOVE.skin;
const results: Record<string, Record<number, number>> = {};
const note = (name: string, rate: number, v: number) => ((results[name] ??= {})[rate] = v);

async function course(rate: number): Promise<void> {
  const dt = 1 / rate;
  const live: Live = await startLive(out, { launch: { practice: true, map: "range", bots: 0, name: "Test" }, dt });
  const secs = (s: number) => live.step(Math.round(s * rate));
  const place = async (at: [number, number, number], yaw: number) => {
    live.input({ keys: [] });
    live.send({ cmd: "event", type: "place", payload: { at, yaw } });
    await secs(0.5);
  };
  const tag = `${rate} Hz:`;
  let r: Report;

  await secs(0.5);
  r = await live.report();
  check(r.status === "practice" && r.map === "range" && r.me.alive, `${tag} in practice on the Range, alive`);
  check(r.grounded && Math.abs(r.at[1] - REST) < 3e-3, `${tag} at rest on the ground (y ${f(r.at[1])})`);

  // Run, sprint, crouch: the speed over the second second.
  for (const [name, keys, want] of [["run", ["W"], MOVE.run], ["sprint", ["W", "Shift"], MOVE.sprint], ["crouch", ["W", "C"], MOVE.crouch]] as const) {
    await place([6, 0, 28], 0);
    live.input({ keys });
    await secs(1);
    const a = await live.report();
    await secs(1);
    const b = await live.report();
    const speed = (a.at[2] - b.at[2]) / (1 + dt);          // (the report's own frame moves too)
    note(name, rate, speed);
    check(Math.abs(speed - want) < want * 0.01 && Math.abs(b.at[0] - 6) < 1e-3, `${tag} ${name} ${f(speed)} m/s (${want})`);
    if (name === "crouch") check(b.crouched && Math.abs(b.eye - MOVE.crouchEye) < 1e-3, `${tag} crouched: eyes at ${f(b.eye)} m`);
    live.input({ keys: [] });
    await secs(0.6);
    const c = await live.report();
    if (name === "sprint") {
      // (The report is read before its own frame moves: that frame is still at full speed.)
      const stop = b.at[2] - c.at[2] - MOVE.sprint * dt;
      note("stop", rate, stop);
      check(Math.hypot(c.v[0], c.v[2]) < 1e-3 && stop < 0.7, `${tag} stops from a sprint in ${f(stop)} m`);
    }
  }

  // The jump.
  await place([0, 0, 20], 0);
  live.input({ keys: ["Space"], pressed: ["Space"] });
  let top = 0, airborne = 0, landings = 0, was = true;
  for (let k = 0; k < rate * 1.4; k++) {
    await live.step(1);
    r = await live.report();
    top = Math.max(top, r.at[1]);
    if (!r.grounded) airborne++;
    if (r.grounded && !was) landings++;
    was = r.grounded;
  }
  const rise = (MOVE.jump * MOVE.jump) / (2 * MOVE.gravity);
  note("jump", rate, top - REST);
  check(Math.abs(top - REST - rise) < 0.012, `${tag} jump ${f(top - REST)} m high (v² / 2g = ${f(rise)})`);
  check(landings === 1 && r!.grounded, `${tag} one jump for one press (Space still held)`);
  // Air control: from a standing jump, W in the air gains at most MOVE.airSpeed.
  live.input({ keys: [] });
  await secs(0.3);
  live.input({ keys: ["Space"], pressed: ["Space"] });
  await live.step(1);
  live.input({ keys: ["W"] });
  await secs(0.3);
  r = await live.report();
  check(!r.grounded && Math.hypot(r.v[0], r.v[2]) <= MOVE.airSpeed + 0.02, `${tag} in the air W gains ${f(Math.hypot(r.v[0], r.v[2]))} m/s (at most ${MOVE.airSpeed})`);

  // The thin wall: at a sprint, and with frames of 0.1 s.
  const face = RANGE.thinWall.z + MOVE.radius;
  await place([0, 0, -4], 0);
  live.input({ keys: ["W", "Shift"] });
  await secs(1.5);
  r = await live.report();
  check(r.at[2] >= face && r.at[2] - face < 0.04, `${tag} sprinting at a 0.1 m wall: stopped ${f(r.at[2] - face)} m off its face`);
  await place([0, 0, -4], 0);
  live.send({ cmd: "lockstep", dt: 0.1 });
  live.input({ keys: ["W", "Shift"] });
  await live.step(20);
  live.send({ cmd: "lockstep", dt });
  r = await live.report();
  check(r.at[2] >= face && r.at[2] - face < 0.04, `${tag} the same with frames of 0.1 s (${f(MOVE.sprint * 0.1)} m a frame): ${f(r.at[2] - face)} m off its face`);

  // A wall met at 45 degrees: slid along.
  await place([0, 0, -8], Math.PI / 4);
  live.input({ keys: ["W", "Shift"] });
  await secs(1);
  r = await live.report();
  note("slide", rate, -r.at[0]);
  check(r.at[2] >= face && r.at[2] - face < 0.04 && r.at[0] < -2.5, `${tag} into the wall at 45 degrees: slid ${f(-r.at[0])} m along it, ${f(r.at[2] - face)} m off it`);

  // The step and the kerb (east of the start; +x is yaw -90 degrees).
  await place([RANGE.step.x - 2, 0, RANGE.step.z], -Math.PI / 2);
  live.input({ keys: ["W"] });
  await secs(1.2);
  r = await live.report();
  check(r.grounded && Math.abs(r.at[1] - RANGE.step.height - REST) < 5e-3 && r.at[0] > RANGE.step.x + 1, `${tag} a ${RANGE.step.height} m step is walked over (y ${f(r.at[1])}, x ${f(r.at[0])})`);
  await place([RANGE.kerb.x - 2, 0, RANGE.kerb.z], -Math.PI / 2);
  live.input({ keys: ["W"] });
  await secs(1.2);
  r = await live.report();
  const kerb = RANGE.kerb.x - MOVE.radius;
  check(r.grounded && r.at[1] < 0.05 && r.at[0] <= kerb + 1e-3 && kerb - r.at[0] < 0.04, `${tag} a ${RANGE.kerb.height} m kerb is not (x ${f(r.at[0])}, ${f(kerb - r.at[0])} m off it)`);
  live.input({ keys: ["W", "Space"], pressed: ["Space"] });
  await secs(1);
  r = await live.report();
  check(r.grounded && Math.abs(r.at[1] - RANGE.kerb.height - REST) < 5e-3, `${tag} but it is jumped onto (y ${f(r.at[1])})`);

  // The ramps (west of the start; -x is yaw +90 degrees).
  await place([RANGE.ramp.x + 2, 0, RANGE.ramp.z], Math.PI / 2);
  live.input({ keys: ["W"] });
  await secs(2.2);
  r = await live.report();
  check(r.grounded && Math.abs(r.at[1] - RANGE.ramp.height - REST) < 0.02 && r.at[0] < RANGE.ramp.x - RANGE.ramp.length, `${tag} a 30 degree ramp is walked to its top (y ${f(r.at[1])} of ${f(RANGE.ramp.height)})`);
  await place([RANGE.steep.x + 2, 0, RANGE.steep.z], Math.PI / 2);
  live.input({ keys: ["W"] });
  await secs(2);
  r = await live.report();
  check(r.at[1] < 0.6 && r.at[0] > RANGE.steep.x - 0.6, `${tag} a 60 degree one is not (y ${f(r.at[1])}, x ${f(r.at[0])})`);

  // The tunnel.
  const t = RANGE.tunnel;
  await place([t.x0 - 2, 0, t.z], -Math.PI / 2);
  live.input({ keys: ["W"] });
  await secs(1.2);
  r = await live.report();
  check(r.at[0] <= t.x0 - MOVE.radius + 1e-3, `${tag} standing, a ${t.height} m tunnel is not entered (x ${f(r.at[0])})`);
  live.input({ keys: ["W", "C"] });
  await secs(1.2);
  live.input({ keys: ["W"] });           // the crouch key let go inside: there is no room to stand
  await secs(0.5);
  r = await live.report();
  check(r.crouched && r.at[0] > t.x0 && r.at[0] < t.x1, `${tag} crouched it is, and inside the crouch holds without the key (x ${f(r.at[0])})`);
  await secs(3);
  r = await live.report();
  check(!r.crouched && r.at[0] > t.x1 + MOVE.radius, `${tag} past its end the player stands up (x ${f(r.at[0])})`);

  // The ladder: forward is up, and over the top onto the tower.
  await place([0, 0, RANGE.tower.z - 2], Math.PI);
  live.input({ keys: ["W"] });
  await secs(0.8);
  r = await live.report();
  check(r.ladder && r.at[1] > 0.5, `${tag} on the ladder, climbing (y ${f(r.at[1])})`);
  await secs(1.5);
  r = await live.report();
  check(r.grounded && Math.abs(r.at[1] - RANGE.tower.height - REST) < 0.01 && r.at[2] > RANGE.tower.z, `${tag} and on top of the tower (y ${f(r.at[1])}, z ${f(r.at[2])})`);

  live.input({ keys: [] });
  await live.quit();
  const errors = live.errors();
  check(errors.length === 0, `${tag} no script error${errors.length ? `: ${errors[0]}` : ""}`);
}

for (const rate of rates) await course(rate);
// The same at every frame rate.
for (const [name, by] of Object.entries(results)) {
  const v = Object.values(by);
  const spread = Math.max(...v) - Math.min(...v);
  check(spread <= Math.max(0.01, Math.abs(v[0]!) * 0.01), `${name}: ${rates.map((r) => `${f(by[r]!)} @ ${r}`).join(", ")} (spread ${f(spread)})`);
}
done("movement");
