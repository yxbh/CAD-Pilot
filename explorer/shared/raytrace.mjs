// The ray-traced view: how far a page refines it, what an image waits for, and how an answer describes what it got.
import { defaultAnalysis } from "./analysis.mjs";

// The ray-traced view draws Studio's light and finishes without analysis views; any other appearance draws its own.
const PLAIN = defaultAnalysis();
export function analysisDrawn(appearance, analysis) {
  return appearance === "raytraced" ? PLAIN : analysis;
}

// A page refines the view until this many samples, then rests.
export const PAGE_SAMPLES = 512;
// An image waits for this many samples or this many seconds of tracing, whichever comes first.
export const IMAGE_SAMPLES = 128;
export const IMAGE_SECONDS = 60;
// Software WebGL (no usable GPU) traces a sample in seconds rather than milliseconds, so an image waits at most this long.
export const SOFTWARE_SECONDS = 20;
export const MAX_SAMPLES = 4096;
// The longest an image traces: with preparing and compiling first, it still answers within the five minutes a request
// from the command line waits.
export const MAX_SECONDS = 90;

/** A capture's ray-tracing limits from its input: samples and seconds, either optional; throws a RangeError naming the problem. */
export function traceLimits({ samples, seconds } = {}) {
  if (samples !== undefined && (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES)) {
    throw new RangeError(`samples must be a whole number from 1 to ${MAX_SAMPLES}`);
  }
  if (seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS)) {
    throw new RangeError(`seconds must be a time above 0 and up to ${MAX_SECONDS}`);
  }
  // A sample count alone traces as long as it takes, within the most an image waits; a time alone takes what it gets.
  return {
    samples: samples ?? (seconds !== undefined ? MAX_SAMPLES : IMAGE_SAMPLES),
    seconds: seconds ?? (samples !== undefined ? MAX_SECONDS : IMAGE_SECONDS),
  };
}

/**
 * What the answer says about a traced image: the samples it got of those asked for, how long it traced and waited in
 * all (preparing the scene and compiling the tracer first) and on what, with a note when software rendering capped it.
 * trace is the renderer's report: { samples, asked, seconds, waited, stopped, software, renderer }; stopped is "untraced" for
 * a page drawing in software, which shows Studio's view.
 */
export function traceAnswer(trace) {
  if (!trace || typeof trace !== "object" || !Number.isFinite(trace.samples)) return null;
  const round = (value) => Math.round(value * 10) / 10;
  const answer = {
    samples: trace.samples, asked: trace.asked, seconds: round(trace.seconds), waited: round(trace.waited),
    stopped: ["samples", "untraced"].includes(trace.stopped) ? trace.stopped : "time", renderer: String(trace.renderer ?? ""),
  };
  if (answer.stopped === "untraced") {
    return { ...answer, note: "This page draws with software WebGL, so it shows Studio's view and its image is not ray traced. Images from the background renderer still trace." };
  }
  if (!trace.software) return answer;
  const prepared = `Drawn with software WebGL, as no usable GPU was found: the path tracer took ${round(trace.waited - trace.seconds)} s to prepare and compile`;
  return {
    ...answer,
    note: answer.stopped === "samples"
      ? `${prepared}, then ${answer.seconds < 0.1 ? "under 0.1" : answer.seconds} s for ${answer.samples} samples. Software tracing stops after ${SOFTWARE_SECONDS} s.`
      : `${prepared}, then stopped at the ${SOFTWARE_SECONDS} s software limit with ${answer.samples} of ${answer.asked} samples. A GPU reaches them in seconds, with less grain.`,
  };
}
