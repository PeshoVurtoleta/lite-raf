/**
 * Deterministic requestAnimationFrame harness.
 *
 * lite-raf drives everything off the browser's rAF callback. In Node there is
 * no rAF, so we install a controllable one: `tick(time)` runs exactly the
 * callbacks that are currently scheduled, at the timestamp we choose. Because
 * `loop()` re-arms itself with a single `requestAnimationFrame(loop)` at the
 * top of each frame, one `tick()` == one frame, and we own the clock.
 *
 * Must be imported (and installRaf() called) BEFORE importing ../RAF.js,
 * because RAF.js captures nothing at module load — it only touches rAF inside
 * startFrames()/loop() — so installing first is sufficient and safe.
 */

let cbs = [];
let nextId = 1;

export function installRaf() {
    cbs = [];
    nextId = 1;
    globalThis.requestAnimationFrame = (cb) => {
        const id = nextId++;
        cbs.push([id, cb]);
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
        cbs = cbs.filter(([i]) => i !== id);
    };
}

/** Run one frame at timestamp `time` (ms). Returns number of callbacks fired. */
export function tick(time) {
    const pending = cbs;
    cbs = [];
    for (let i = 0; i < pending.length; i++) pending[i][1](time);
    return pending.length;
}

/** How many rAF callbacks are currently armed (should be 0 stopped, 1 running). */
export function armedCount() {
    return cbs.length;
}
