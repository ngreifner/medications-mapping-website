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

// ============================================================
// Sliding tab indicator — a single morphing glass pill that
// follows the active tab. CSS in glass.css paints the pill via
// .tab-bar::before, sized by --tab-ind-w and translated by
// --tab-ind-x. This module sets both, on every change.
//
// Why a MutationObserver, not a click listener: the existing
// app.js owns activateTab() and may also be called programmatically
// (URL state, keyboard shortcut, etc.). Watching aria-selected on
// the buttons gives us a single source of truth.
// ============================================================
(function () {
  if (typeof document === "undefined") return;
  let bar = null;
  let rafToken = 0;
  let observer = null;

  function update() {
    if (!bar) return;
    const active = bar.querySelector(".tab.is-active") ||
                   bar.querySelector('.tab[aria-selected="true"]');
    if (!active) {
      bar.classList.remove("is-indicator-ready");
      return;
    }
    // offsetLeft / offsetTop are from the .tab-bar's padding box (the
    // tabs are direct children). Subtract scrollLeft so the indicator
    // tracks the visible position when the bar is horizontally
    // scrolled on narrow screens. offsetHeight tracks the active
    // tab's height across desktop / mobile padding rules without
    // re-deriving them in CSS.
    const x = active.offsetLeft - bar.scrollLeft;
    const y = active.offsetTop;
    const w = active.offsetWidth;
    const h = active.offsetHeight;
    bar.style.setProperty("--tab-ind-x", x + "px");
    bar.style.setProperty("--tab-ind-y", y + "px");
    bar.style.setProperty("--tab-ind-w", w + "px");
    bar.style.setProperty("--tab-ind-h", h + "px");
    bar.classList.add("is-indicator-ready");
  }

  function schedule() {
    if (rafToken) return;
    rafToken = requestAnimationFrame(() => {
      rafToken = 0;
      update();
    });
  }

  function init() {
    bar = document.querySelector(".tab-bar");
    if (!bar) return;

    // Observe aria-selected (the authoritative state on role=tab
    // elements) AND is-active (the visual class app.js applies).
    observer = new MutationObserver(schedule);
    bar.querySelectorAll(".tab").forEach((tab) => {
      observer.observe(tab, {
        attributes: true,
        attributeFilter: ["aria-selected", "class"],
      });
    });

    // Reposition on scroll (mobile/narrow tab-bar) + on resize.
    bar.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    // Fonts can shift tab widths on late paint; recompute when fonts
    // finish loading.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(schedule).catch(() => {});
    }

    // First paint — wait a frame so layout is final.
    requestAnimationFrame(schedule);
    // And once more after a beat in case the first-load animation
    // mid-flight tab widths haven't settled.
    setTimeout(schedule, 400);
    setTimeout(schedule, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
