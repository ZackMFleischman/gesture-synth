// Pure onset <-> schedule matching (no page, no fs): usable from unit specs. Re-exported by arp-analysis.js.

/**
 * matchToSchedule() for captures whose offset to the AudioContext clock may exceed half a step (the real
 * app: the tap's ScriptProcessor sits ~2 blocks = ~170 ms behind `playbackTime`). On a regular grid such an
 * offset is ambiguous by whole steps, so every alias (first onset = each scheduled step) is tried and the
 * one with the smallest worst-case residual wins. A grid that changes (tempo change) leaves exactly one
 * alias that fits everywhere; on a perfectly regular grid all aliases fit equally (counts are still right).
 * Same return shape as matchToSchedule; residuals are relative to the median offset.
 */
export function matchToScheduleAnyOffset(onsets, scheduled, recStart) {
  const nearest = (x) => scheduled.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) ? s : b), scheduled[0]);
  let best = null;
  for (const s0 of scheduled) {
    const off0 = onsets[0] + recStart - s0;
    const pairs = onsets.map((t) => {
      const x = t + recStart;
      const s = nearest(x - off0);
      return { onset: x, sched: s, d: x - s };
    });
    const ds = pairs.map((p) => p.d).sort((a, b) => a - b);
    const offset = ds[Math.floor(ds.length / 2)];
    const errors = pairs.map((p) => p.d - offset);
    const worst = Math.max(...errors.map(Math.abs));
    if (!best || worst < best.worst) best = { offset, pairs, errors, worst };
  }
  return { offset: best.offset, pairs: best.pairs, errors: best.errors };
}
