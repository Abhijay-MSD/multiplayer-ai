import { useEffect, useRef } from "react";
import styles from "./LiveSignal.module.css";
import { useTheme } from "../themes/ThemeProvider";

// PRD 20.7: the one signature element. The agent's state drives it, and every
// theme draws it in its own way (theme.json "signal"):
//   wave      a flat-colour waveform (Signal Room)
//   softwave  a slower, softer wave with a gradient accent (Horizon)
//   dots      three dots that pulse in turn (Plain)
//   line      a thin line that breathes slowly (Paper)
// The state names and the four labels are the same everywhere. With
// prefers-reduced-motion nothing moves: each variant has a still drawing, and
// the label is the indicator.

const LABELS = {
  idle: "Agent is idle",
  working: "Agent is working",
  limit: "Step limit reached",
  error: "Last step failed"
};

const STOPPED = new Set(["limit", "error"]);

// work: wave amplitude. breathe: idle drift. stopped: blend toward --danger.
const TARGETS = {
  idle: { work: 0, breathe: 1, stopped: 0 },
  working: { work: 1, breathe: 0, stopped: 0 },
  limit: { work: 0, breathe: 0, stopped: 1 },
  error: { work: 0, breathe: 0, stopped: 1 }
};

const PROFILES = {
  wave: { amp: 0.4, freq: [3.2, 6.1, 1.4], speed: 1, width: 2.5, layers: [{ phase: 0, opacity: 1 }], gradient: false },
  softwave: {
    amp: 0.3,
    freq: [1.6, 2.7, 0.9],
    speed: 0.55,
    width: 3,
    layers: [{ phase: 0, opacity: 1 }, { phase: 1.3, opacity: 0.32 }],
    gradient: true
  }
};

const STEP_PX = 3;
const TAU_MS = 90; // time constant: ~95% of a change done in ~270-300ms

const smooth = (x) => x * x * (3 - 2 * x);

// Resolves any CSS color (hex, rgb, color-mix, ...) to [r, g, b].
let probe;
function toRgb(value, fallback) {
  try {
    probe ||= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    probe.canvas.width = probe.canvas.height = 1;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a === 0 ? fallback : [r, g, b];
  } catch {
    return fallback;
  }
}

const readToken = (name, fallback) =>
  toRgb(getComputedStyle(document.documentElement).getPropertyValue(name).trim(), fallback);

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = ([r, g, b]) => `rgb(${r},${g},${b})`;

function waveY(u, t, s, h, p, phase) {
  let y = 0;
  const [f1, f2, f3] = p.freq;
  const k = p.speed;
  if (s.work > 0.001) {
    // Three drifting sines, shaped by a travelling amplitude envelope and a
    // slow global swell, so peaks vary along the line and over time.
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * (u * 1.3 - t * 0.35 * k) + 1.1 + phase);
    const swell = 0.72 + 0.28 * Math.sin(t * 0.9 * k + phase);
    const carrier =
      0.62 * Math.sin(2 * Math.PI * u * f1 - t * 5.2 * k + phase) +
      0.28 * Math.sin(2 * Math.PI * u * f2 + t * 3.1 * k + 0.8 + phase) +
      0.35 * Math.sin(2 * Math.PI * u * f3 - t * 1.7 * k + phase);
    y += s.work * (h * p.amp) * envelope * swell * (carrier / 1.25);
  }
  if (s.breathe > 0.001) {
    // ~7s breath, a couple of pixels of travel.
    y +=
      s.breathe * 2.6 * (h / 56) *
      (Math.sin((2 * Math.PI * (t + phase)) / 7) * Math.sin(Math.PI * u) +
        0.4 * Math.sin((2 * Math.PI * (t + phase)) / 11 + 1) * Math.sin(2 * Math.PI * u));
  }
  return y;
}

function WaveSignal({ state, variant }) {
  const svgRef = useRef(null);
  const pathRefs = useRef([]);
  const stopRefs = useRef([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const redrawRef = useRef(() => {});
  const { theme, mode } = useTheme();
  const profile = PROFILES[variant] ?? PROFILES.wave;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Colors come from the active theme's tokens and are re-read on every
    // theme or mode change (this effect depends on both).
    const colorA = readToken("--signal-a", [228, 149, 43]);
    const colorB = readToken("--signal-b", colorA);
    const danger = readToken("--danger", [183, 84, 59]);

    const target = () => TARGETS[stateRef.current] ?? TARGETS.idle;
    const cur = { ...target() };
    let width = 0;
    let height = 0;
    let t = 0;
    let last = null;
    let raf = null;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const draw = () => {
      if (!width) return;
      const taper = 0.06;
      profile.layers.forEach((layer, i) => {
        let d = "";
        for (let x = 0; x <= width + 0.01; x += STEP_PX) {
          const u = x / width;
          const edge = smooth(Math.min(1, u / taper, (1 - u) / taper));
          const y = height / 2 - waveY(u, t, cur, height, profile, layer.phase) * edge;
          d += `${x === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(2)}`;
        }
        const path = pathRefs.current[i];
        path?.setAttribute("d", d);
        if (!profile.gradient) path?.setAttribute("stroke", css(mix(colorA, danger, cur.stopped)));
      });
      if (profile.gradient) {
        stopRefs.current[0]?.setAttribute("stop-color", css(mix(colorA, danger, cur.stopped)));
        stopRefs.current[1]?.setAttribute("stop-color", css(mix(colorB, danger, cur.stopped)));
      }
    };

    const frame = (now) => {
      const dt = last === null ? 16 : Math.min(now - last, 100);
      last = now;
      t += dt / 1000;
      const k = 1 - Math.exp(-dt / TAU_MS);
      const goal = target();
      for (const key of Object.keys(cur)) cur[key] += (goal[key] - cur[key]) * k;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const stop = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      last = null;
    };

    const start = () => {
      stop();
      if (motion.matches) {
        Object.assign(cur, target()); // static: no ramp, no movement
        t = 0;
        draw();
      } else {
        raf = requestAnimationFrame(frame);
      }
    };

    redrawRef.current = () => {
      if (motion.matches) {
        Object.assign(cur, target());
        draw();
      }
    };

    const ro = new ResizeObserver(() => {
      const rect = svg.getBoundingClientRect();
      width = Math.max(0, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const g = svg.querySelector("linearGradient");
      g?.setAttribute("x2", String(width));
      draw();
    });
    ro.observe(svg);
    motion.addEventListener("change", start);
    start();

    return () => {
      stop();
      ro.disconnect();
      motion.removeEventListener("change", start);
    };
  }, [theme, mode, profile]);

  // Reduced motion has no loop to pick up a new state, so redraw directly.
  useEffect(() => {
    redrawRef.current();
  }, [state]);

  const gradId = `signal-grad-${variant}`;
  return (
    <svg ref={svgRef} className={styles.svg} data-part="signal-graphic" aria-hidden="true" focusable="false">
      {profile.gradient && (
        <defs>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
            <stop ref={(el) => (stopRefs.current[0] = el)} offset="0" />
            <stop ref={(el) => (stopRefs.current[1] = el)} offset="1" />
          </linearGradient>
        </defs>
      )}
      {profile.layers.map((layer, i) => (
        <path
          key={i}
          ref={(el) => (pathRefs.current[i] = el)}
          className={styles.path}
          fill="none"
          strokeWidth={profile.width}
          opacity={layer.opacity}
          stroke={profile.gradient ? `url(#${gradId})` : undefined}
        />
      ))}
    </svg>
  );
}

function DotsSignal({ state }) {
  return (
    <span className={styles.dots} data-part="signal-graphic" data-state={state} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

function LineSignal({ state }) {
  return (
    <span className={styles.line} data-part="signal-graphic" data-state={state} aria-hidden="true">
      <i />
    </span>
  );
}

// announce=false drops the live-region role, for a replay that loops.
export function LiveSignal({ state = "idle", showLabel = true, announce = true }) {
  const { meta } = useTheme();
  const variant = meta.signal ?? "wave";
  const stopped = STOPPED.has(state);

  return (
    <div className={styles.wrap} data-part="signal" data-variant={variant} data-state={state}>
      {variant === "dots" ? (
        <DotsSignal state={state} />
      ) : variant === "line" ? (
        <LineSignal state={state} />
      ) : (
        <WaveSignal state={state} variant={variant} />
      )}
      {showLabel && (
        <span
          className={`${styles.label} ${stopped ? styles.labelStopped : ""}`}
          data-part="signal-label"
          role={announce ? "status" : undefined}
          aria-live={announce ? "polite" : undefined}
        >
          {LABELS[state] ?? LABELS.idle}
        </span>
      )}
    </div>
  );
}
