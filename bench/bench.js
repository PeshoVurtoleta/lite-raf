/**
 * lite-raf benchmark.
 *
 * Run:  node --expose-gc bench/bench.js     (or: npm run bench)
 *
 * --expose-gc is required for the retained-memory numbers. Without it the
 * throughput numbers still print; the heap column reads "n/a".
 *
 * What it measures
 *  1. Dispatch throughput: ms per frame and effect-dispatches/sec for a range of
 *     active rafEffect counts. This is the cost lite-raf adds on top of your own
 *     per-frame work — it is NOT a render benchmark.
 *  2. Retained heap growth: bytes retained per frame across a long run (the
 *     number that decides whether an overlay survives a multi-hour stream).
 *
 * Methodology: a deterministic frame clock (no real rAF) so frame count and
 * timing are exact and reproducible. Warm up, then time a fixed window with
 * process.hrtime; for memory, force a full GC before and after so the figure is
 * *retained* growth, not transient nursery garbage (which the next scavenge
 * reclaims and which never accumulates).
 */

import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {installRaf, tick} from "../test/harness.js";

installRaf();
const {rafEffect, startFrames, stopFrames, frameDelta} = await import("../RAF.js");

const HAS_GC = typeof global.gc === "function";
const FRAME_MS = 16.7;

function throughput(effectCount, frames) {
    installRaf();
    const disposers = [];
    for (let i = 0; i < effectCount; i++) disposers.push(rafEffect(() => {
        frameDelta();
    }));
    startFrames();
    let clk = 0;
    for (let i = 0; i < 2000; i++) tick(clk += FRAME_MS);   // warm up
    const start = process.hrtime.bigint();
    for (let i = 0; i < frames; i++) tick(clk += FRAME_MS);
    const end = process.hrtime.bigint();
    disposers.forEach((d) => d());
    stopFrames();
    const msPerFrame = Number(end - start) / 1e6 / frames;
    return {
        effectCount,
        msPerFrame,
        dispatchesPerSec: effectCount > 0 ? (effectCount / msPerFrame) * 1000 : 0,
        pctOf60fps: (msPerFrame / FRAME_MS) * 100,
    };
}

function retained(effectCount, frames) {
    if (!HAS_GC) return null;
    installRaf();
    const disposers = [];
    for (let i = 0; i < effectCount; i++) disposers.push(rafEffect(() => {
        frameDelta();
    }));
    startFrames();
    let clk = 0;
    for (let i = 0; i < 3000; i++) tick(clk += FRAME_MS);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < frames; i++) tick(clk += FRAME_MS);
    global.gc();
    const after = process.memoryUsage().heapUsed;
    disposers.forEach((d) => d());
    stopFrames();
    return {effectCount, frames, totalBytes: after - before, bytesPerFrame: (after - before) / frames};
}

const fmt = (n, d = 4) => n.toFixed(d);
const eng = (n) => n.toExponential(2);

console.log("\n@zakkster/lite-raf — benchmark");
console.log(`node ${process.version} · ${process.platform}/${process.arch} · gc:${HAS_GC ? "on" : "off (run with --expose-gc)"}\n`);

console.log("Dispatch throughput (cost added per frame; lower ms is better)");
console.log("  effects |   ms/frame | % of 60fps budget | dispatches/sec");
console.log("  --------+------------+-------------------+----------------");
const tRows = [0, 1, 10, 50, 100, 250, 500].map((k) => throughput(k, 20000));
for (const r of tRows) {
    console.log(
        `  ${String(r.effectCount).padStart(7)} | ${fmt(r.msPerFrame).padStart(10)} | ${(fmt(r.pctOf60fps, 3) + " %").padStart(17)} | ${r.effectCount > 0 ? eng(r.dispatchesPerSec) : "—"}`
    );
}

console.log("\nRetained heap growth (full-GC before/after; ~0 means no leak)");
const mRows = [];
if (HAS_GC) {
    console.log("  effects |    frames |  total retained |  bytes/frame");
    console.log("  --------+-----------+-----------------+-------------");
    for (const k of [10, 100]) {
        const r = retained(k, 200000);
        mRows.push(r);
        console.log(`  ${String(r.effectCount).padStart(7)} | ${String(r.frames).padStart(9)} | ${(r.totalBytes + " B").padStart(15)} | ${fmt(r.bytesPerFrame, 4)}`);
    }
} else {
    console.log("  (skipped — run with --expose-gc)");
}

const results = {
    meta: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        gc: HAS_GC,
        frameMs: FRAME_MS,
        when: new Date().toISOString()
    },
    throughput: tRows,
    retained: mRows,
};
const outPath = join(dirname(fileURLToPath(import.meta.url)), "bench-results.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nwrote ${outPath}\n`);
