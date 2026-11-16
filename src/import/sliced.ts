// Long work spread over frames: a generator stepped for a few milliseconds a frame, so the picture keeps running while
// a map is converted. What the generator yields says what it is doing: a `Pending` (host.ts) is a request to the app,
// and the job is not stepped again until it is answered; a `{ stage, done }` is its progress, for the HUD.
import { Pending } from "./host.ts";

export interface Progress { label: string; done: number }

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Sliced<R> {
  done = false;
  value: R | undefined;
  error: unknown = null;
  progress: Progress = { label: "", done: 0 };
  /** Milliseconds of work done so far, and frames it took. */
  busy = 0;
  steps = 0;
  /** The longest step, ms (a step stops only between two yields). */
  longest = 0;
  /** What the job said it was doing after its longest step. */
  longestAt = "";
  /** The steps that took longer than twice what was asked (at most 12): how long, and between which progress. */
  readonly slow: string[] = [];
  private before = "";
  private waiting: Pending<unknown> | null = null;
  private readonly job: Generator<unknown, R>;

  constructor(job: Generator<unknown, R>) {
    this.job = job;
  }

  /** Works on the job for about `ms` milliseconds (less when it waits on the app, or ends). */
  step(ms: number): void {
    if (this.done) return;
    const t0 = clock();
    this.steps++;
    try {
      for (;;) {
        if (this.waiting && !this.waiting.done) break;
        this.waiting = null;
        const r = this.job.next();
        if (r.done) {
          this.done = true;
          this.value = r.value;
          break;
        }
        const v = r.value;
        if (v instanceof Pending) this.waiting = v;
        else if (v && typeof v === "object" && typeof (v as Progress).done === "number") this.progress = { label: String((v as Progress).label ?? this.progress.label), done: (v as Progress).done };
        if (clock() - t0 >= ms) break;
      }
    } catch (e) {
      this.done = true;
      this.error = e;
    }
    const took = clock() - t0;
    this.busy += took;
    if (took > 2 * ms && this.slow.length < 12) this.slow.push(`${Math.round(took)} ms: ${this.before} -> ${this.progress.label} ${this.progress.done.toFixed(3)}`);
    if (took > this.longest) { this.longest = took; this.longestAt = `${this.before} -> ${this.progress.label} ${this.progress.done.toFixed(3)}`; }
    this.before = `${this.progress.label} ${this.progress.done.toFixed(3)}`;
  }

  /** Stops it (the generator's `finally` blocks run). */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.error = new Error("canceled");
    try { this.job.return(undefined as R); } catch { /* it is over either way */ }
  }
}
