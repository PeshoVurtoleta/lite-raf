/**
 * @zakkster/lite-raf — type declarations
 * Zero-GC frame-rate scheduling for @zakkster/lite-signal.
 */

/**
 * A read-only reactive accessor over a number.
 * - Call it (`frameDelta()`) for a *tracked* read inside an effect/computed.
 * - `.peek()` reads the current value *without* establishing a dependency.
 * - `.subscribe(fn)` runs `fn` with the value now and on every change; returns
 *   an idempotent unsubscribe function.
 */
export interface ReadonlyFrameSignal {
    (): number;
    peek(): number;
    subscribe(fn: (value: number) => void): () => void;
}

/**
 * Time of the current frame in milliseconds (a `DOMHighResTimeStamp` from
 * `requestAnimationFrame`). Monotonic non-decreasing.
 */
export declare const frameTime: ReadonlyFrameSignal;

/**
 * Elapsed milliseconds since the previous frame; `0` on the first frame after
 * {@link startFrames}. Use as your animation `dt`.
 */
export declare const frameDelta: ReadonlyFrameSignal;

/**
 * Total frames rendered since module load. 32-bit counter; wraps to negative
 * after ~414 days of continuous 60 fps. Treat as a change-ticker.
 */
export declare const frameCount: ReadonlyFrameSignal;

/**
 * Register a frame-scheduled effect. The body re-runs at the end of each frame
 * in which a tracked dependency changed — at most once per frame, and every
 * frame the loop ticks if it reads any frame signal.
 *
 * @param fn Effect body. Tracked reads establish dependencies.
 * @returns Idempotent dispose function.
 */
export declare function rafEffect(fn: () => void): () => void;

/**
 * Start the `requestAnimationFrame` loop. Idempotent. Resets the delta baseline
 * so the first frame reports `frameDelta() === 0`.
 */
export declare function startFrames(): void;

/**
 * Stop the loop and cancel the pending frame. Effects are retained and resume
 * when {@link startFrames} is called again.
 */
export declare function stopFrames(): void;
