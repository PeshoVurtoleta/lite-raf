/**
 * @zakkster/lite-raf v1.0.0
 * ----------------------------------------------------------------------------
 * Zero-GC, frame-rate scheduling for @zakkster/lite-signal.
 *
 * A single `requestAnimationFrame` loop drives three frame signals
 * (`frameTime`, `frameDelta`, `frameCount`) and a pre-allocated callback queue.
 * `rafEffect(fn)` registers a lite-signal effect whose execution is deferred to
 * the next frame boundary, so an effect runs **at most once per frame** no
 * matter how many of its dependencies changed in between — and **every frame**
 * the loop ticks (see "Frame signals" below).
 *
 * == Zero-GC ==
 * The loop core allocates nothing per frame: the callback queue is a single
 * pre-grown array, the per-frame signal writes are funnelled through one
 * hoisted `applyFrame` function (no closure), and the loop re-arms with the
 * same `loop` reference each frame. The only transient per-frame allocation in
 * the `rafEffect` path is lite-signal's scheduler-dispatch closure -- one
 * short-lived closure per *active* effect per frame -- which is nursery garbage
 * collected by the next scavenge and never retained. Retained heap growth is
 * zero (verified by a 200k-frame leak test; see `npm run bench`).
 *
 * == Frame signals ==
 * The three frame signals are created with `equals: () => false` so that every
 * `.set()` propagates even when the numeric value is unchanged. This is
 * deliberate: on a fixed-rate display the per-frame delta can be bit-identical
 * frame to frame, and lite-signal's default `Object.is` equality would
 * short-circuit the write, silently skipping the effect that frame. Forcing
 * propagation guarantees the per-frame contract ("every frame, exactly once")
 * holds regardless of timing stability.
 *
 * == Registry ==
 * lite-raf binds to lite-signal's *default* registry. If your app needs more
 * than the default node-pool capacity (~1024 reactive nodes) or you run
 * multiple isolated graphs, configure the registry via lite-signal
 * (`createRegistry({ maxNodes, onCapacityExceeded: "grow" })` +
 * `setDefaultRegistry`) before creating rafEffects.
 *
 * @module @zakkster/lite-raf
 */

import {signal, effect, batch} from "@zakkster/lite-signal";

// --- ZERO-GC QUEUE ----------------------------------------------------------
// Pre-allocated callback queue. Scheduled effect trampolines land here during
// the frame's effect flush and are drained at the end of the same frame. The
// array is never shrunk; it grows once (and rarely) if a frame ever schedules
// more than INITIAL_QUEUE_CAPACITY effects.
const INITIAL_QUEUE_CAPACITY = 4096;
const rafQueue = new Array(INITIAL_QUEUE_CAPACITY);

for (let i = 0; i < INITIAL_QUEUE_CAPACITY; i++) rafQueue[i] = null;

let queueLen = 0 | 0;

/**
 * lite-signal effect scheduler. Instead of running the effect synchronously,
 * push its `run` trampoline into the frame queue to be drained at the end of
 * the current frame.
 * @param {() => void} run
 * @private
 */
function rafScheduler(run) {
    if (queueLen < rafQueue.length) {
        rafQueue[queueLen++] = run;
    } else {
        rafQueue.push(run);
        queueLen = (queueLen + 1) | 0;
    }
}

// --- FRAME SIGNALS ----------------------------------------------------------
// equals:() => false  ->  always propagate; see module header "Frame signals".
const FORCE = {equals: () => false};
const _frameTime = signal(0, FORCE);
const _frameDelta = signal(0, FORCE);
const _frameCount = signal(0, FORCE);

/**
 * Wrap a signal in a read-only accessor: callable for tracked reads, plus
 * `.peek()` (untracked) and `.subscribe()`. The `.set`/`.update` mutators are
 * intentionally omitted so consumers cannot drive the clock by hand.
 * @private
 */
function makeReadOnly(sig) {
    const read = () => sig();

    read.peek = sig.peek;
    read.subscribe = sig.subscribe;

    return read;
}

/**
 * Time of the current frame, in milliseconds, as reported by
 * `requestAnimationFrame` (a `DOMHighResTimeStamp`). Monotonic non-decreasing.
 * @type {{ (): number, peek: () => number, subscribe: Function }}
 */
export const frameTime = makeReadOnly(_frameTime);

/**
 * Elapsed time since the previous frame, in milliseconds. `0` on the first
 * frame after {@link startFrames}. Use this as your animation `dt`.
 * @type {{ (): number, peek: () => number, subscribe: Function }}
 */
export const frameDelta = makeReadOnly(_frameDelta);

/**
 * Total frames rendered since module load.
 * Note: 32-bit SMI counter; wraps to a negative value after ~414 days of
 * continuous 60 fps. Treat as a change-ticker, not a monotonic clock.
 * @type {{ (): number, peek: () => number, subscribe: Function }}
 */
export const frameCount = makeReadOnly(_frameCount);

// --- LOOP STATE -------------------------------------------------------------
let rafId = null;
let lastTime = 0;
let isRunning = false;
let hasFirstFrame = false;

// Hoisted frame inputs, read by applyFrame -- keeps the batched write a stable
// function reference so no closure is allocated per frame.
let _curTime = 0;
let _curDelta = 0;

/** Apply the current frame's inputs to the three frame signals. @private */
function applyFrame() {
    _frameTime.set(_curTime);
    _frameDelta.set(_curDelta);
    _frameCount.set((_frameCount.peek() + 1) | 0);
}

/**
 * The rAF callback. Re-arms itself, updates the frame signals inside a single
 * batch (so dependents see a consistent (time, delta, count) triple and are
 * queued exactly once), then drains the frame queue.
 * @param {number} time DOMHighResTimeStamp supplied by the browser.
 * @private
 */
function loop(time) {
    if (!isRunning) return;
    rafId = requestAnimationFrame(loop);

    _curDelta = hasFirstFrame ? time - lastTime : 0;
    _curTime = time;
    lastTime = time;
    hasFirstFrame = true;

    // One batch -> one flush -> each dependent effect scheduled at most once.
    batch(applyFrame);

    // Snapshot the queue AFTER the batch's flush has populated it, then drain.
    // Effects scheduled *during* the drain (cascades) land in the queue for the
    // next frame; we read `run` into a local before nulling, so re-entrant
    // scheduling into already-drained slots is safe.
    const toRun = queueLen | 0;
    queueLen = 0 | 0;

    for (let i = 0; i < toRun; i++) {
        const run = rafQueue[i];
        rafQueue[i] = null;

        try {
            run();
        } catch (err) {
            // Isolate a throwing effect so it cannot abort the rest of the
            // frame's queue. lite-signal has already restored its own observer
            // state before the throw reached us.
            console.error("lite-raf: error in scheduled effect", err);
        }
    }
}

// --- PUBLIC API -------------------------------------------------------------

/**
 * Register a frame-scheduled effect. The body re-runs at the end of each frame
 * in which one of its tracked dependencies changed -- at most once per frame,
 * regardless of how many synchronous changes occurred. Reading any frame signal
 * ({@link frameTime}, {@link frameDelta}, {@link frameCount}) makes it run every
 * frame the loop is ticking.
 *
 * Behaviour notes:
 *  - **Lifecycle**: effects only run while the loop is running. An effect
 *    created before {@link startFrames} (or while stopped) sits queued and runs
 *    once with the latest values on the next frame after the loop starts.
 *  - **Disposal**: the returned function disposes the effect. A trampoline
 *    already queued for the current frame is safely neutralised by lite-signal's
 *    generation guard -- the body will not run after disposal.
 *  - **Cascade latency**: if a rafEffect mutates a signal another rafEffect
 *    depends on, the downstream effect runs on the *next* frame, not this one.
 *
 * @example
 *   const stop = rafEffect(() => {
 *       sprite.x += velocity * frameDelta();   // dt-based integration
 *       renderer.draw(sprite);
 *   });
 *   startFrames();
 *   // later: stop();
 *
 * @param {() => void} fn Effect body. Tracked reads establish dependencies.
 * @returns {() => void} Idempotent dispose function.
 */
export function rafEffect(fn) {
    return effect(fn, {scheduler: rafScheduler});
}

/**
 * Start the `requestAnimationFrame` loop. Idempotent -- a second call while
 * running is a no-op. Resets the delta baseline so the first frame reports
 * `frameDelta() === 0`.
 */
export function startFrames() {
    if (isRunning) return;

    isRunning = true;
    lastTime = 0;
    hasFirstFrame = false;
    rafId = requestAnimationFrame(loop);
}

/**
 * Stop the loop and cancel the pending frame. Registered effects are retained
 * (not disposed) and resume scheduling when {@link startFrames} is called
 * again. Any callbacks already queued for an in-flight frame are left in place
 * and drained on the next started frame.
 */
export function stopFrames() {
    isRunning = false;

    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}
