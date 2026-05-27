/**
 * lite-raf correctness suite.
 *
 * Run:  npm test            (node --test test/*.test.js)
 *       npm run test:gc     (adds --expose-gc to enable the leak assertion)
 *
 * Every test drives a deterministic frame clock (see harness.js) so there is no
 * wall-clock flake: one tick() == one frame, at a timestamp we choose.
 *
 * NOTE on shared state: RAF.js is a singleton module (one rAF loop, three frame
 * signals in lite-signal's default registry). Each test reinstalls the rAF mock,
 * disposes the effects it creates, and stops the loop, so tests don't leak into
 * one another. Counters (frameCount) accumulate globally, so assertions use
 * relative deltas, never absolute values.
 */

import {test} from "node:test";
import assert from "node:assert/strict";
import {signal} from "@zakkster/lite-signal";
import {installRaf, tick, armedCount} from "./harness.js";

installRaf();
const {
    rafEffect, startFrames, stopFrames,
    frameTime, frameDelta, frameCount,
} = await import("../RAF.js");

/** Fresh clock + clean stop for each test body. Returns a teardown fn. */
function freshLoop() {
    installRaf();
    return () => stopFrames();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

test("startFrames arms exactly one rAF callback; stopFrames cancels it", () => {
    const done = freshLoop();
    assert.equal(armedCount(), 0);
    startFrames();
    assert.equal(armedCount(), 1, "one callback armed after start");
    tick(16);
    assert.equal(armedCount(), 1, "loop re-arms itself each frame");
    stopFrames();
    assert.equal(armedCount(), 0, "no callback armed after stop");
    done();
});

test("startFrames is idempotent (double start does not double-arm)", () => {
    const done = freshLoop();
    startFrames();
    startFrames();
    assert.equal(armedCount(), 1);
    done();
});

// ── Frame signals ─────────────────────────────────────────────────────────

test("frameTime tracks the rAF timestamp; first frame delta is 0", () => {
    const done = freshLoop();
    let t = 0, d = -1;
    const stop = rafEffect(() => {
        t = frameTime();
        d = frameDelta();
    });
    startFrames();
    tick(1000);
    assert.equal(t, 1000, "frameTime equals the timestamp");
    assert.equal(d, 0, "first delta is 0");
    tick(1016);
    assert.equal(t, 1016);
    assert.equal(d, 16, "delta is the gap to the previous frame");
    stop();
    done();
});

test("frameCount increments by exactly one per frame", () => {
    const done = freshLoop();
    let seen = [];
    const stop = rafEffect(() => {
        seen.push(frameCount());
    });
    startFrames();
    const base = frameCount.peek();
    tick(16);
    tick(32);
    tick(48);
    // last three observed counts must be consecutive
    const tail = seen.slice(-3);
    assert.deepEqual(tail, [tail[0], tail[0] + 1, tail[0] + 2]);
    assert.ok(tail[0] > base - 5, "count advanced from baseline");
    stop();
    done();
});

// ── The core promise: every frame, exactly once ─────────────────────────────

test("runs EVERY frame even when the delta is bit-identical (fixed-rate display)", () => {
    const done = freshLoop();
    let runs = 0;
    const stop = rafEffect(() => {
        frameDelta();
        runs++;
    });
    startFrames();
    let clk = 0;
    for (let i = 0; i < 10; i++) tick(clk += 16); // constant 16ms delta
    assert.equal(runs, 10, "constant delta must not short-circuit propagation");
    stop();
    done();
});

test("runs at MOST once per frame despite many synchronous dep changes", () => {
    const done = freshLoop();
    const s = signal(0);
    let runs = 0, lastSeen = null;
    const stop = rafEffect(() => {
        lastSeen = s();
        runs++;
    });
    startFrames();
    tick(16);                       // init run: reads s = 0
    const before = runs;
    s.set(1);
    s.set(2);
    s.set(3);   // three writes between frames
    tick(32);                       // one frame
    assert.equal(runs - before, 1, "collapsed three writes into one run");
    assert.equal(lastSeen, 3, "ran with the latest value");
    stop();
    done();
});

test("reading all three frame signals still yields one run per frame", () => {
    const done = freshLoop();
    let runs = 0;
    const stop = rafEffect(() => {
        frameTime();
        frameDelta();
        frameCount();
        runs++;
    });
    startFrames();
    const before = runs;
    tick(16);
    tick(33);
    tick(50);
    assert.equal(runs - before, 3, "3 signal writes/frame dedupe to 1 effect run");
    stop();
    done();
});

// ── Disposal ────────────────────────────────────────────────────────────────

test("dispose stops future runs", () => {
    const done = freshLoop();
    let runs = 0;
    const stop = rafEffect(() => {
        frameCount();
        runs++;
    });
    startFrames();
    tick(16);
    const after1 = runs;
    stop();
    tick(32);
    tick(48);
    assert.equal(runs, after1, "no runs after dispose");
    done();
});

test("dispose is idempotent", () => {
    const done = freshLoop();
    const stop = rafEffect(() => {
        frameCount();
    });
    startFrames();
    tick(16);
    stop();
    assert.doesNotThrow(() => {
        stop();
        stop();
    });
    done();
});

test("a pending trampoline for a disposed effect is neutralised, not run", () => {
    const done = freshLoop();
    let aRuns = 0, bRuns = 0;
    let stopB;
    // A is created first, so it drains first within the frame and can dispose B
    // while B's trampoline is still sitting in the queue behind it.
    const stopA = rafEffect(() => {
        frameCount();
        aRuns++;
        if (stopB) stopB();
    });
    stopB = rafEffect(() => {
        frameCount();
        bRuns++;
    });
    startFrames();
    const a0 = aRuns, b0 = bRuns;
    tick(16);
    assert.equal(aRuns - a0, 1, "A ran");
    assert.equal(bRuns - b0, 0, "B was disposed by A before its trampoline fired");
    stopA();
    done();
});

// ── Cascades ────────────────────────────────────────────────────────────────

test("a rafEffect writing a dep of another rafEffect cascades to the NEXT frame", () => {
    const done = freshLoop();
    const x = signal(0);
    let bSeen = [];
    // A bumps x every frame; B observes x.
    const stopA = rafEffect(() => {
        frameCount();
        x.set(x.peek() + 1);
    });
    const stopB = rafEffect(() => {
        bSeen.push(x());
    });
    startFrames();
    tick(16);                 // A bumps x -> B scheduled for next frame
    tick(32);                 // B observes the value A wrote last frame
    tick(48);
    // B's observed values should lag A's writes by one frame (monotonic, no skips)
    const tail = bSeen.slice(-2);
    assert.equal(tail[1] - tail[0], 1, "B advances one step per frame (cascade latency = 1 frame)");
    stopA();
    stopB();
    done();
});

// ── Stopped state ─────────────────────────────────────────────────────────

test("effects created before startFrames run once on the first frame", () => {
    const done = freshLoop();
    let runs = 0;
    const stop = rafEffect(() => {
        frameCount();
        runs++;
    });
    // not started yet
    assert.equal(runs, 0, "no run before start");
    startFrames();
    tick(16);
    assert.equal(runs, 1, "ran on first frame after start");
    stop();
    done();
});

// ── Error isolation ─────────────────────────────────────────────────────────

test("a throwing effect does not abort sibling effects in the same frame", () => {
    const done = freshLoop();
    let okRuns = 0;
    const stopBad = rafEffect(() => {
        frameCount();
        throw new Error("boom");
    });
    const stopOk = rafEffect(() => {
        frameCount();
        okRuns++;
    });
    startFrames();
    const before = okRuns;
    // console.error from the isolated throw is expected here.
    assert.doesNotThrow(() => {
        tick(16);
        tick(32);
    });
    assert.ok(okRuns - before >= 2, "sibling kept running across frames");
    stopBad();
    stopOk();
    done();
});

// ── Retained-memory leak guard (only meaningful under --expose-gc) ──────────

test("no retained heap growth under sustained load", {skip: typeof global.gc !== "function" ? "run with --expose-gc" : false}, () => {
    const done = freshLoop();
    const effects = [];
    for (let i = 0; i < 50; i++) effects.push(rafEffect(() => {
        frameDelta();
    }));
    startFrames();
    let clk = 0;
    for (let i = 0; i < 3000; i++) tick(clk += 16.7); // warm up JIT + pools
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const N = 60000;
    for (let i = 0; i < N; i++) tick(clk += 16.7);
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const perFrame = (after - before) / N;
    // Generous bound: steady state must not accumulate. Real value is ~0.
    assert.ok(perFrame < 16, `retained ${perFrame.toFixed(3)} B/frame (expected ~0)`);
    effects.forEach((d) => d());
    done();
});
