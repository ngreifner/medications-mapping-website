// glass-shimmer.js
// Tracks the cursor across every glass surface and sets CSS custom
// properties (--mx, --my) on the hovered element. CSS uses those to
// position a radial sheen overlay, so each card "wakes up" softly as
// the cursor passes over it.
//
// Single delegated mousemove listener — cheap. We only touch the
// element that's actually under the cursor at this frame.

(function () {
  if (typeof document === "undefined") return;

  // Every kind of glass surface that should respond to the cursor.
  const SELECTOR = [
    ".card",
    ".input-card",
    ".tab-bar",
    ".m3-progress-card",
    ".ndc-table-card",
    ".summary-bar",
    "header",
    "footer",
    ".btn-primary",
    ".btn-secondary",
    ".btn-stop",
    ".family-query-btn",
    ".view-toggle-btn",
    ".filter-chip",
    ".chip",
    ".tab",
  ].join(",");

  let lastTarget = null;

  function onMove(ev) {
    const target = ev.target instanceof Element
      ? ev.target.closest(SELECTOR)
      : null;
    if (!target) {
      if (lastTarget) {
        lastTarget.style.removeProperty("--mx");
        lastTarget.style.removeProperty("--my");
        lastTarget = null;
      }
      return;
    }
    const r = target.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    target.style.setProperty("--mx", `${x}px`);
    target.style.setProperty("--my", `${y}px`);
    if (lastTarget && lastTarget !== target) {
      lastTarget.style.removeProperty("--mx");
      lastTarget.style.removeProperty("--my");
    }
    lastTarget = target;
  }

  // Body-level cursor spotlight — sets --cx/--cy on <html> so the
  // ambient background can paint a soft warm glow wherever the cursor
  // is, independent of which surface is under it. The whole canvas
  // breathes with the user.
  const docEl = document.documentElement;

  // requestAnimationFrame throttle — keeps it smooth without firing
  // setProperty for every mouse event on dense surfaces.
  let queued = false;
  let lastEv = null;
  function handler(ev) {
    lastEv = ev;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!lastEv) return;
      onMove(lastEv);
      // Global spotlight — uses viewport coords directly so the gradient
      // origin maps 1:1 to the cursor regardless of scroll position.
      docEl.style.setProperty("--cx", `${lastEv.clientX}px`);
      docEl.style.setProperty("--cy", `${lastEv.clientY}px`);
    });
  }

  document.addEventListener("mousemove", handler, { passive: true });

  // When the cursor leaves the window, fade everything back out.
  document.addEventListener("mouseleave", () => {
    if (lastTarget) {
      lastTarget.style.removeProperty("--mx");
      lastTarget.style.removeProperty("--my");
      lastTarget = null;
    }
  });
})();
