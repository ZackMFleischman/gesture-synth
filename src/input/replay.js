// Record / replay of raw MediaPipe HandLandmarker results (DEV tool).
//
// Recording file (JSON):
//   { format: "gesture-synth-recording", version: 1, createdAt, durationMs,
//     video: { width, height },            // camera frame size the landmarks were measured on
//     note?: string,
//     frames: [{ t,                        // ms since the recording started
//                landmarks: [[{x,y,z}, ...21], ...],              // = detectForVideo().landmarks
//                handedness: [[{categoryName, score}], ...] }] }  // = detectForVideo().handedness
//
// Replay feeds the frames through the same pipeline in real time: createReplaySource()
// returns an object with the same detectForVideo() method as HandLandmarker.
// Pure (no DOM) except downloadRecording().

export const RECORDING_FORMAT = "gesture-synth-recording";
const EMPTY = Object.freeze({ landmarks: [], handedness: [] });

const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Copies the serializable part of a detectForVideo() result (rounded to 1e-5). */
export function snapshotResults(results) {
  return {
    landmarks: (results.landmarks || []).map((hand) => hand.map((p) => ({ x: r5(p.x), y: r5(p.y), z: r5(p.z || 0) }))),
    handedness: (results.handedness || []).map((cats) =>
      cats.slice(0, 1).map((c) => ({ categoryName: c.categoryName, score: r5(c.score ?? 1) }))),
  };
}

/** Collects frames for `durationMs`, then calls onDone(recording). add() is a no-op when idle. */
export function createRecorder({ onDone = () => {} } = {}) {
  let frames = null;
  let t0 = 0;
  let duration = 0;
  let video = { width: 0, height: 0 };

  function finish() {
    const rec = {
      format: RECORDING_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      durationMs: frames.length ? frames[frames.length - 1].t : 0,
      video,
      frames,
    };
    frames = null;
    onDone(rec);
    return rec;
  }

  return {
    get recording() { return frames !== null; },
    /** 0..1 progress of the current recording. */
    progress(now) { return frames ? Math.min(1, (now - t0) / duration) : 0; },
    start(durationMs, now, videoSize = video) {
      frames = [];
      t0 = now;
      duration = durationMs;
      video = { width: videoSize.width || 0, height: videoSize.height || 0 };
    },
    add(results, now) {
      if (!frames) return;
      const t = now - t0;
      if (t > duration) { finish(); return; }
      frames.push({ t: Math.round(t * 10) / 10, ...snapshotResults(results) });
    },
    stop() { return frames ? finish() : null; },
  };
}

export async function loadRecording(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`replay: cannot load ${url} (${res.status})`);
  const rec = await res.json();
  if (rec.format !== RECORDING_FORMAT || !Array.isArray(rec.frames)) {
    throw new Error(`replay: ${url} is not a ${RECORDING_FORMAT} file`);
  }
  return rec;
}

/**
 * Real-time replay. The clock starts at the first detectForVideo() call; each call returns the
 * latest frame whose t <= elapsed. After the last frame: empty results (hands gone), or wrap
 * around with `loop`.
 */
export function createReplaySource(recording, { loop = false } = {}) {
  const frames = recording.frames;
  const end = frames.length ? frames[frames.length - 1].t : 0;
  let start = null;
  let i = 0;
  let done = false;

  return {
    recording,
    get done() { return done; },
    detectForVideo(_video, now) {
      if (start === null) start = now;
      let elapsed = now - start;
      if (loop && end > 0 && elapsed > end) {
        start += Math.floor(elapsed / end) * end;
        elapsed = now - start;
        i = 0;
      }
      if (!frames.length || elapsed < frames[0].t) return EMPTY;
      if (!loop && elapsed > end + 100) { done = true; return EMPTY; }
      while (i + 1 < frames.length && frames[i + 1].t <= elapsed) i++;
      return frames[i];
    },
  };
}

/** Saves a recording as a JSON download (browser only). */
export function downloadRecording(rec, filename) {
  const stamp = rec.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || `gesture-rec-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
