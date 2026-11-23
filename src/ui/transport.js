// Transport plate (docs/ui-integration.md D9): centered just above the chord display, clocked modes only
// (Arp). `110 BPM` (+ the tempo delta inside the plate during a pinch), 4 beat dots (current one filled
// in the mode color and pulsing, switched at the beat's playTime, not when it was scheduled), a divider
// and one step dot per step of the bar.
// Reads: bpm (state), beat (event: beat-in-bar 1..4, playTime), arp/rate, right/pinch; step position
// from ctx.clock.beatAt() when there is a clock.

const CLOCKED = new Set(["arp"]);
const PULSE_MS = 180;

export function createTransport({ S, bus, ctx, doc, subscribe }) {
  const stage = doc.getElementById("stage");
  const el = doc.createElement("div");
  el.id = "transport";
  el.className = "hidden";
  el.dataset.gsKind = "status";
  el.setAttribute("aria-label", "Tempo and beat");
  el.innerHTML =
    `<span class="gs-bpm"><b class="gs-bpm-n">--</b><span>BPM</span><em class="gs-delta"></em></span>` +
    `<span class="gs-beats">${"<i></i>".repeat(4)}</span><span class="gs-div"></span><span class="gs-steps"></span>`;
  stage.append(el);
  const bpmEl = el.querySelector(".gs-bpm-n");
  const deltaEl = el.querySelector(".gs-delta");
  const beatEls = [...el.querySelectorAll(".gs-beats i")];
  const stepsEl = el.querySelector(".gs-steps");
  let stepEls = [];

  const pending = []; // beats waiting for their playTime: {n, t}
  let beat = -1; // 0..3
  let pulseAt = -Infinity;
  let pinchStartBpm = null;
  let shownBpm = null;

  const audioNow = () => {
    const ac = ctx.audio?.ac;
    return ac ? ac.currentTime - (ac.outputLatency || 0) : null;
  };

  const off = subscribe((name, data, playTime) => {
    if (name === "beat" && typeof data === "number") {
      const now = audioNow();
      if (playTime == null || now == null || playTime <= now) setBeat(data - 1);
      else pending.push({ n: data - 1, t: playTime });
    }
  });

  function setBeat(n) {
    beat = ((n % 4) + 4) % 4;
    pulseAt = performance.now();
    beatEls.forEach((b, i) => b.classList.toggle("on", i === beat));
  }

  function setStepCount(n) {
    if (stepEls.length === n) return;
    stepsEl.innerHTML = "<i></i>".repeat(n);
    stepEls = [...stepsEl.querySelectorAll("i")];
  }

  function stepInfo() {
    const clock = ctx.clock;
    const rate = bus.get("arp/rate") ?? clock?.rate ?? 1 / 8;
    const dbl = clock ? !!clock.doubleTimeActive : !!bus.get("arp/double");
    const stepBeats = (4 * rate) / (dbl ? 2 : 1);
    const count = Math.max(1, Math.min(16, Math.round(4 / stepBeats)));
    let idx = -1;
    const now = audioNow();
    if (clock?.running && now != null && typeof clock.beatAt === "function") {
      const b = clock.beatAt(now);
      if (Number.isFinite(b) && b >= 0) idx = Math.floor((b % 4) / stepBeats) % count;
    } else if (beat >= 0) {
      idx = Math.floor(beat / stepBeats) % count;
    }
    return { count, idx };
  }

  function update() {
    const on = CLOCKED.has(S.modeId) || S.mode?.transport === true;
    el.classList.toggle("hidden", !on);
    if (!on) {
      pending.length = 0;
      return;
    }
    // Beats due by now (audio clock).
    const now = audioNow();
    if (pending.length && now != null) {
      for (let i = 0; i < pending.length; ) {
        if (pending[i].t <= now) {
          setBeat(pending[i].n);
          pending.splice(i, 1);
        } else i++;
      }
    }
    // Pulse: the only repeating motion. Scale the current dot for PULSE_MS after the beat.
    const k = Math.max(0, 1 - (performance.now() - pulseAt) / PULSE_MS);
    if (beat >= 0) beatEls[beat].style.transform = `scale(${(1.15 + 0.35 * k).toFixed(3)})`;
    beatEls.forEach((b, i) => i !== beat && b.style.transform && (b.style.transform = ""));
    el.dataset.pulse = k > 0 ? "1" : "0";

    const bpm = bus.get("bpm") ?? ctx.clock?.bpm;
    if (bpm !== shownBpm) {
      shownBpm = bpm;
      bpmEl.textContent = bpm != null ? String(Math.round(bpm)) : "--";
    }
    // Tempo delta (pinch = tempo), inside the plate, only while pinching.
    const pinching = !!S.hands.right.pinch && !!S.hands.right.pos;
    if (pinching && pinchStartBpm == null) pinchStartBpm = bpm;
    if (!pinching) pinchStartBpm = null;
    const d = pinching && bpm != null && pinchStartBpm != null ? Math.round(bpm - pinchStartBpm) : 0;
    const dt = pinching ? `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}` : "";
    if (deltaEl.textContent !== dt) deltaEl.textContent = dt;

    const { count, idx } = stepInfo();
    setStepCount(count);
    stepEls.forEach((s, i) => s.classList.toggle("on", i === idx));
  }

  return {
    update,
    get beat() {
      return beat;
    },
    destroy() {
      off();
      el.remove();
    },
  };
}
