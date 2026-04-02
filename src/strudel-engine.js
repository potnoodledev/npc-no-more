/**
 * Jam Studio audio engine — wraps @strudel/web for live pattern playback.
 *
 * Uses the same approach as musicats: initStrudel() from @strudel/web sets up
 * everything (audio context, sample loading, global functions), then evaluate()
 * hot-swaps patterns and hush() silences.
 */

let ready = false;
let initPromise = null;
let evaluateFn = null;
let hushFn = null;

/**
 * Initialize strudel. Must be called from a user gesture (click/tap).
 */
export async function initStrudel() {
  if (ready) {
    console.log("[strudel] Already initialized, skipping");
    return;
  }
  if (initPromise) {
    console.log("[strudel] Init already in progress, waiting...");
    return initPromise;
  }

  console.log("[strudel] Starting initialization...");

  initPromise = (async () => {
    try {
      console.log("[strudel] Importing @strudel/web...");
      const mod = await import("@strudel/web");
      console.log("[strudel] @strudel/web loaded, exports:", Object.keys(mod).join(", "));

      console.log("[strudel] Calling initStrudel()...");
      await mod.initStrudel({
        prebake: async () => {
          console.log("[strudel] prebake: loading samples...");
          const g = globalThis;
          console.log("[strudel] prebake: globalThis.samples type =", typeof g.samples);
          if (typeof g.samples === "function") {
            const ds = "https://raw.githubusercontent.com/felixroos/dough-samples/main";
            try {
              await g.samples(`${ds}/tidal-drum-machines.json`);
              console.log("[strudel] prebake: tidal-drum-machines loaded");
            } catch (e) {
              console.warn("[strudel] prebake: tidal-drum-machines failed:", e.message);
            }
            try {
              await g.samples(`${ds}/Dirt-Samples.json`);
              console.log("[strudel] prebake: Dirt-Samples loaded");
            } catch (e) {
              console.warn("[strudel] prebake: Dirt-Samples failed:", e.message);
            }
          } else {
            console.warn("[strudel] prebake: globalThis.samples not available!");
          }
        },
      });
      console.log("[strudel] initStrudel() completed");

      evaluateFn = mod.evaluate;
      hushFn = mod.hush;
      console.log("[strudel] evaluateFn type:", typeof evaluateFn, "hushFn type:", typeof hushFn);

      ready = true;
      console.log("[strudel] Audio engine initialized successfully");
    } catch (err) {
      console.error("[strudel] Init FAILED:", err);
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Build strudel code from active instruments + BPM.
 */
export function buildPatternCode(instruments, bpm) {
  const patterns = Object.values(instruments)
    .filter((i) => i.pattern && !i.muted)
    .map((i) => i.pattern);

  if (patterns.length === 0) return "";

  const code = patterns.length === 1
    ? patterns[0]
    : `stack(\n${patterns.map((p) => `  ${p}`).join(",\n")}\n)`;

  const cpm = bpm / 60;
  return cpm === 2 ? code : `${code}.cpm(${cpm})`;
}

/**
 * Evaluate combined patterns. Hot-swaps the running pattern.
 */
export async function updatePatterns(instruments, bpm) {
  if (!ready || !evaluateFn) {
    console.log("[strudel] updatePatterns skipped: ready=", ready, "evaluateFn=", !!evaluateFn);
    return;
  }

  const code = buildPatternCode(instruments, bpm);
  console.log("[strudel] updatePatterns called, code:", code ? code.slice(0, 100) + (code.length > 100 ? "..." : "") : "(empty)");

  if (!code) {
    console.log("[strudel] No active patterns, stopping playback");
    stopPlayback();
    return;
  }

  try {
    console.log("[strudel] Evaluating pattern...");
    const result = await evaluateFn(code, true);
    console.log("[strudel] Pattern evaluated, result:", result);
  } catch (err) {
    console.warn("[strudel] Pattern eval error:", err.message, err);
  }
}

/**
 * Stop all playback.
 */
export function stopPlayback() {
  if (!ready) return;
  console.log("[strudel] Stopping playback");
  try { if (hushFn) hushFn(); } catch (e) { console.warn("[strudel] hush error:", e); }
}

/**
 * Check if the engine is initialized.
 */
export function isInitialized() {
  return ready;
}
