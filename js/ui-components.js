// ui-components.js — reusable card renderers.
// Each function takes plain data and returns an HTMLElement. No fetch, no
// global state. The mode files compose these into the result area.

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function code(text) {
  return el("span", { class: "code" }, text);
}

// ---------------- drug identity ----------------

export function drugIdentityCard({ rxcui, name, tty }) {
  return el("section", { class: "card", "aria-label": "Drug identity" }, [
    el("p", { class: "card-title" }, "Drug"),
    el("h2", { class: "drug-name" }, name || "(unknown)"),
    el("div", { class: "identity-meta" }, [
      el("span", {}, [el("strong", {}, "RXCUI:"), " ", code(rxcui)]),
      tty ? el("span", {}, [el("strong", {}, "TTY:"), " ", el("span", { class: "tty-badge" }, tty)]) : null,
    ]),
  ]);
}

// ---------------- route resolution ----------------

export function routeCard({ route, dfgs = [], chosenDfg = null }) {
  const list = dfgs.length
    ? el("ul", { class: "dfg-list" }, dfgs.map(d =>
        el("li", { class: d === chosenDfg ? "is-chosen" : "" }, d)
      ))
    : null;
  const why = (() => {
    if (route === "unknown") return "No dose form group returned by RxNav — route could not be resolved.";
    if (dfgs.length > 1 && chosenDfg) {
      return `Selected "${chosenDfg}" as the highest-priority DFG. The most-specific local route wins over more general ones.`;
    }
    if (chosenDfg) return `The drug's dose form group is "${chosenDfg}".`;
    return "";
  })();
  return el("section", { class: "card", "aria-label": "Route resolution" }, [
    el("p", { class: "card-title" }, "Route"),
    el("div", { class: "card-body" }, [
      el("p", {}, [el("span", { class: "route-pill" }, route)]),
      why ? el("p", { class: "reason" }, why) : null,
      list,
    ]),
  ]);
}

// ---------------- kept / rejected ATCs ----------------

export function keptAtcCard({ atc, name, reason, overrideNote = null }) {
  return el("section", { class: "card card-kept", "aria-label": `Kept ATC ${atc}` }, [
    el("p", { class: "card-title" }, "Kept"),
    el("p", { class: "atc-code" }, atc),
    name ? el("p", { class: "atc-name" }, name) : null,
    reason ? el("p", { class: "reason" }, reason) : null,
    overrideNote ? el("p", { class: "reason-override" }, overrideNote) : null,
  ]);
}

export function rejectedAtcCard({ atc, name, reason, clinical }) {
  return el("section", { class: "card card-rejected", "aria-label": `Rejected ATC ${atc}` }, [
    el("p", { class: "card-title" }, "Rejected"),
    el("p", { class: "atc-code" }, atc),
    name ? el("p", { class: "atc-name" }, name) : null,
    reason ? el("p", { class: "reason" }, reason) : null,
    clinical ? el("p", { class: "reason-clinical" }, clinical) : null,
  ]);
}

// ---------------- ATC L4 family card (Mode 3 L4 expansion) ----------------
//
// Renders the L4 parent + a list of L5 cousins (each with a Query button),
// followed by Export CSV and Query-all-cousins actions in the footer.
//
// Visual scope: distinct from RxCUI result cards. Family card uses the
// `card-family` modifier (CSS picks up a soft accent-tinted background).

export function atcFamilyCard({
  parentCode,
  parentName,
  cousins,        // [{code, name, isCombination}]
  onQueryCousin,  // (code) => void
  onExport,       // () => void
  onQueryAll,     // () => void
}) {
  const rows = cousins.map(c => {
    const queryBtn = el("button", {
      type: "button",
      class: "family-query-btn",
      "aria-label": `Query ${c.code}`,
    }, ["Query ", el("span", { "aria-hidden": "true" }, "→")]);
    queryBtn.addEventListener("click", () => onQueryCousin && onQueryCousin(c.code));
    return el("li", { class: "family-cousin" + (c.isCombination ? " is-combination" : "") }, [
      el("span", { class: "family-cousin-marker", "aria-hidden": "true" }, "▸"),
      el("span", { class: "family-cousin-code" }, c.code),
      el("span", { class: "family-cousin-sep", "aria-hidden": "true" }, "—"),
      el("span", { class: "family-cousin-name" }, c.name || "(name unavailable)"),
      c.isCombination ? el("span", { class: "family-cousin-tag" }, "combination") : null,
      queryBtn,
    ]);
  });

  const total = cousins.length;
  const batchNote = total >= 10 ? `This will query ${total} classes — may take a moment.` : "";

  const exportBtn = el("button", { type: "button", class: "btn-secondary" }, "⬇ Export this list");
  if (onExport) exportBtn.addEventListener("click", () => onExport());

  const batchBtn = el("button", { type: "button", class: "btn-primary" }, `Query all ${total} cousin${total === 1 ? "" : "s"} as batch`);
  if (onQueryAll) batchBtn.addEventListener("click", () => onQueryAll());

  return el("section", {
    class: "card card-family",
    "aria-label": `ATC family ${parentCode}`,
  }, [
    el("div", { class: "family-header" }, [
      el("span", { class: "family-glyph", "aria-hidden": "true" }, "🌳"),
      el("span", { class: "family-parent-code" }, parentCode),
      el("span", { class: "family-parent-sep", "aria-hidden": "true" }, "—"),
      el("span", { class: "family-parent-name" }, parentName || "(name loading…)"),
    ]),
    el("p", { class: "family-sub" }, `Level 5 cousins in this family (${total})`),
    el("ul", { class: "family-cousin-list" }, rows),
    batchNote ? el("p", { class: "family-batch-note" }, batchNote) : null,
    el("div", { class: "action-row" }, [exportBtn, batchBtn]),
  ]);
}

// ---------------- error / empty / loading ----------------

export function errorCard({ title, body, actions = [], variant = "warning" }) {
  const cls = variant === "error" ? "card card-rejected"
            : variant === "info"  ? "card card-info"
            : "card card-warning";
  return el("section", { class: cls, role: "alert" }, [
    el("p", { class: "card-title" }, variant === "error" ? "Error" : variant === "info" ? "Info" : "Notice"),
    el("h3", { class: "drug-name", style: "font-size:18px" }, title),
    typeof body === "string"
      ? el("p", { class: "card-body" }, body)
      : el("div", { class: "card-body" }, body),
    actions.length
      ? el("div", { class: "action-row" }, actions.map(a =>
          el("button", { type: "button", class: a.primary ? "btn-primary" : "btn-secondary", onclick: a.onClick }, a.label)
        ))
      : null,
  ]);
}

export function skeletonCard() {
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": "Loading" }, [
    el("div", { class: "skel-line w-30" }),
    el("div", { class: "skel-line w-70" }),
    el("div", { class: "skel-line w-50" }),
    el("div", { class: "skel-line w-90" }),
  ]);
}

// ---------------- code-detection banner ----------------

export function codeDetectionBanner({ detectedType, value, suggestedModeLabel, onSwitch, onContinue }) {
  return el("div", { class: "detect-banner", role: "status" }, [
    el("p", {}, [
      "Looks like a ", el("strong", {}, detectedType),
      " (", code(value), "). Switch to ",
      el("strong", {}, suggestedModeLabel),
      " mode?",
    ]),
    el("div", { class: "banner-actions" }, [
      el("button", { type: "button", class: "btn-primary", onclick: onSwitch }, "Switch mode"),
      el("button", { type: "button", class: "btn-secondary", onclick: onContinue }, "Continue anyway"),
    ]),
  ]);
}

// ---------------- action row ----------------

export function actionBarCard({ onCopyJson, onLookupAnother }) {
  const copyBtn = el("button", { type: "button", class: "btn-secondary" }, "Copy as JSON");
  copyBtn.addEventListener("click", () => {
    onCopyJson?.();
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied ✓";
    copyBtn.classList.add("is-success");
    setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove("is-success");
    }, 1500);
  });
  const buttons = [copyBtn];
  // onLookupAnother is omitted by Mode 2's row-expand — the batch UI has its
  // own Reset button, and "Look up another" would be misleading inline.
  if (onLookupAnother) {
    buttons.push(el("button", { type: "button", class: "btn-secondary", onclick: onLookupAnother }, "Look up another"));
  }
  return el("section", { class: "card", "aria-label": "Actions" }, [
    el("div", { class: "action-row" }, buttons),
  ]);
}

// ---------------- batch (Mode 2) ----------------

const STATUS_LABEL = {
  // Mode 2
  CLEAN_FIX:      "Clean fix",
  UNCHANGED:      "Unchanged",
  LEGIT_MULTI:    "Legit multi",
  // Mode 3
  KEPT:           "Kept",
  ROUTE_MISMATCH: "Mismatch",
  // Mode 5
  OK:             "OK",
  NO_NDCS:        "No NDCs",
  // shared
  NEEDS_REVIEW:   "Needs review",
  PENDING:        "Pending",
};

export function statusBadge(status, tooltip = "") {
  const cls = `status-badge status-${String(status).toLowerCase()}`;
  const attrs = { class: cls };
  if (tooltip) {
    attrs["data-tooltip"] = tooltip;
    attrs["aria-label"] = `${STATUS_LABEL[status] || status} — ${tooltip}`;
    attrs.tabindex = "0";
  }
  return el("span", attrs, STATUS_LABEL[status] || status);
}

// ---------------- educational banner ----------------

/**
 * Dismissible info banner above filter chips. Layer 1 of the
 * three-layer status explanation system.
 *
 * @param {object} opts
 * @param {string} opts.storageKey   localStorage key for dismissed state
 * @param {string} opts.title        e.g. "Results categorized by what the route filter did"
 * @param {Array<{dot:string,name:string,desc:string}>} opts.items
 *        dot = one of "success" | "muted" | "accent" | "error" | "warning"
 * @param {string} [opts.footnote]   small italic note below the list
 * @returns {HTMLElement | null} returns null if user dismissed it previously
 */
export function educationalBanner({ storageKey, title, items, footnote = "", showDismiss = true, ignoreDismissed = false }) {
  if (storageKey && !ignoreDismissed && safeStorage.get(storageKey) === "1") return null;

  const children = [
    el("h3", { class: "edu-banner-head" }, [
      el("span", { class: "edu-banner-icon", "aria-hidden": "true" }, "i"),
      title,
    ]),
    el("ul", { class: "edu-banner-list" }, items.map(it =>
      el("li", { class: "edu-banner-item" }, [
        el("span", { class: `status-dot status-dot-${it.dot}`, "aria-hidden": "true" }),
        el("span", { class: "edu-banner-item-name" }, it.name),
        el("span", { class: "edu-banner-item-desc" }, it.desc),
      ])
    )),
    footnote ? el("p", { class: "edu-banner-footnote" }, footnote) : null,
  ];

  let dismissBtn = null;
  if (showDismiss) {
    dismissBtn = el("button", {
      type: "button",
      class: "edu-banner-dismiss",
      "aria-label": "Dismiss",
      title: "Dismiss",
    }, "×");
    children.push(dismissBtn);
  }

  const banner = el("section", {
    class: "edu-banner",
    role: "region",
    "aria-label": title,
  }, children);

  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      if (storageKey) safeStorage.set(storageKey, "1");
      banner.remove();
    });
  }

  return banner;
}

/**
 * Build the educational-banner element from a key + reuse it as a
 * popover toggled by the column-header info button. Returns:
 *   { iconBtn, openPopover, closePopover }
 * where iconBtn is the ⓘ element and the popover anchors next to it.
 *
 * Use case: after the user dismisses the banner, this is the way back
 * to the same content without clutter.
 */
export function statusInfoIcon({ buildBanner }) {
  const iconBtn = el("button", {
    type: "button",
    class: "col-info-btn",
    "aria-label": "Status explanations",
    "aria-expanded": "false",
    title: "Status explanations",
  }, "i");

  let popover = null;
  let docHandler = null;
  let escHandler = null;

  function close() {
    if (!popover) return;
    popover.remove();
    popover = null;
    iconBtn.setAttribute("aria-expanded", "false");
    if (docHandler) document.removeEventListener("mousedown", docHandler);
    if (escHandler) document.removeEventListener("keydown", escHandler);
  }

  function open() {
    if (popover) return;
    popover = buildBanner();
    if (!popover) {
      // banner returns null if user dismissed it — force-render anyway
      // by temporarily clearing the dismiss flag for this popover instance.
      // We rebuild it without the storageKey check.
      popover = buildBanner(true);
    }
    if (!popover) return;
    // Position it as an absolute popover anchored below the icon button.
    popover.classList.add("edu-banner-as-popover");
    document.body.appendChild(popover);
    positionPopover(popover, iconBtn);
    iconBtn.setAttribute("aria-expanded", "true");

    docHandler = (e) => {
      if (popover && !popover.contains(e.target) && e.target !== iconBtn) close();
    };
    escHandler = (e) => { if (e.key === "Escape") close(); };
    // Defer so the click that opened the popover doesn't immediately close it
    setTimeout(() => {
      document.addEventListener("mousedown", docHandler);
      document.addEventListener("keydown", escHandler);
    }, 0);
  }

  iconBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popover) close(); else open();
  });

  return { iconBtn };
}

function positionPopover(popover, anchor) {
  const r = anchor.getBoundingClientRect();
  popover.style.position = "absolute";
  popover.style.top = `${window.scrollY + r.bottom + 8}px`;
  popover.style.left = `${Math.max(8, window.scrollX + r.left - 24)}px`;
  popover.style.maxWidth = "440px";
  popover.style.zIndex = "300";
}

// Small localStorage shim — JSON-safe and tolerant of disabled storage
const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function progressBar({ done = 0, total = 0, eta = "" } = {}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return el("div", { class: "progress", role: "status", "aria-live": "polite" }, [
    el("div", { class: "progress-track" }, [
      el("div", { class: "progress-fill", style: `width:${pct}%` }),
    ]),
    el("div", { class: "progress-meta" }, [
      el("span", { class: "progress-count" }, `${done} / ${total}`),
      el("span", { class: "progress-eta" }, eta || ""),
    ]),
  ]);
}

/** Mutate an existing progressBar element in place — avoids replacing the
 * node (and losing focus or screen-reader continuity) on every tick. */
export function updateProgressBar(progEl, { done, total, eta }) {
  if (!progEl) return;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = progEl.querySelector(".progress-fill");
  const count = progEl.querySelector(".progress-count");
  const etaEl = progEl.querySelector(".progress-eta");
  if (fill) fill.style.width = `${pct}%`;
  if (count) count.textContent = `${done} / ${total}`;
  if (etaEl) etaEl.textContent = eta || "";
}

export function batchSummaryBar({
  total, cleanFix, unchanged, legitMulti, needsReview,
  onDownloadCleaned, onDownloadAudit, onReset,
}) {
  const fixPart = cleanFix === 0
    ? "No ingredient-pollution fixes were needed."
    : `Identified ${cleanFix} mapping${cleanFix === 1 ? "" : "s"} that would have been wrong in standard ingredient-level mapping.`;
  const reviewPart = needsReview === 0
    ? ""
    : ` ${needsReview} need${needsReview === 1 ? "s" : ""} review.`;
  const summary = `Analyzed ${total} RXCUI${total === 1 ? "" : "s"}. ${fixPart}${reviewPart}`;
  return el("section", { class: "summary-bar" }, [
    el("p", { class: "summary-text" }, summary),
    el("div", { class: "action-row" }, [
      el("button", { type: "button", class: "btn-primary", onclick: onDownloadCleaned }, "Download cleaned CSV"),
      el("button", { type: "button", class: "btn-secondary", onclick: onDownloadAudit }, "Download audit CSV"),
      el("button", { type: "button", class: "btn-secondary", onclick: onReset }, "Reset"),
    ]),
  ]);
}

/**
 * Build one row of the batch results table.
 *
 * Returns { tr, detailRow, update(data), setOnExpand(fn) }.
 *   - tr / detailRow are appended to <tbody>.
 *   - update() mutates the row in place once the resolver returns.
 *   - setOnExpand(fn) registers a one-time callback invoked the first time the
 *     user expands the row; fn receives the inner container to render into.
 */
export function batchRow({ rxcui, isDuplicate = false }) {
  const statusCell = el("td", { class: "cell-status" }, statusBadge("PENDING"));
  const rxcuiCell = el("td", { class: "cell-rxcui" }, [
    el("span", { class: "code" }, rxcui),
    isDuplicate ? el("span", { class: "dup-tag", title: "Appeared more than once in your input — counted once" }, "dup") : null,
  ]);
  const nameCell = el("td", { class: "cell-name" }, "…");
  const routeCell = el("td", { class: "cell-route" }, "…");
  const keptCell = el("td", { class: "cell-kept" }, "…");
  const removedCell = el("td", { class: "cell-removed" }, "…");
  const chevron = el("button", {
    type: "button",
    class: "row-toggle",
    "aria-label": "Expand details",
    "aria-expanded": "false",
    disabled: true,
  }, "▶");
  const togCell = el("td", { class: "cell-toggle" }, chevron);

  const tr = el("tr", { class: "batch-row", "data-status": "PENDING", "data-rxcui": rxcui }, [
    statusCell, rxcuiCell, nameCell, routeCell, keptCell, removedCell, togCell,
  ]);

  const detailContainer = el("div", { class: "row-detail-inner" });
  const detailRow = el("tr", { class: "batch-row-detail", hidden: true }, [
    el("td", { colspan: "7" }, detailContainer),
  ]);

  let isOpen = false;
  let detailRendered = false;
  let onExpandHandler = null;

  chevron.addEventListener("click", () => {
    isOpen = !isOpen;
    chevron.textContent = isOpen ? "▼" : "▶";
    chevron.setAttribute("aria-label", isOpen ? "Collapse details" : "Expand details");
    chevron.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) detailRow.removeAttribute("hidden");
    else detailRow.setAttribute("hidden", "");
    if (isOpen && !detailRendered && onExpandHandler) {
      detailRendered = true;
      onExpandHandler(detailContainer);
    }
  });

  function update({ status, name, route, kept, removed, reason, tooltip }) {
    statusCell.innerHTML = "";
    const badge = statusBadge(status, tooltip || "");
    // Align tooltip to the start so it doesn't get clipped by the table edge
    if (tooltip) badge.setAttribute("data-tooltip-align", "start");
    statusCell.appendChild(badge);
    tr.dataset.status = status;

    nameCell.textContent = name || (status === "NEEDS_REVIEW" ? "—" : "(unknown)");
    routeCell.textContent = route || "—";

    keptCell.innerHTML = "";
    if (kept && kept.length > 0) {
      for (const k of kept) {
        keptCell.appendChild(el("span", { class: "code-pill", title: k.name || "" }, k.code));
      }
    } else {
      keptCell.textContent = reason ? "—" : "—";
    }

    removedCell.textContent = String(removed != null ? removed : 0);

    // Enable expand for anything that has substantive Mode 1 content to show.
    // For NEEDS_REVIEW without any data, expand is pointless.
    const hasDetail = status !== "NEEDS_REVIEW" || (kept && kept.length > 0);
    chevron.disabled = !hasDetail;
    if (!hasDetail) chevron.title = reason || "No detail available";
    else chevron.title = "Show full Mode 1 detail";
  }

  function setOnExpand(fn) { onExpandHandler = fn; }

  return { tr, detailRow, update, setOnExpand };
}

// ---------------- mode 3: breadcrumb / group header / NDC list / member row ----------------

/**
 * Hierarchical chip breadcrumb for an ATC code's full Level 1 → N path.
 * `levels` = [{ atc, name, level, isCurrent }, ...] sorted Level 1 → Level N.
 */
export function atcBreadcrumbCard({ levels = [] } = {}) {
  const items = [];
  levels.forEach((lvl, i) => {
    items.push(el("span", {
      class: `atc-crumb atc-crumb-l${lvl.level}` + (lvl.isCurrent ? " is-current" : ""),
      title: lvl.name || "",
    }, [
      el("span", { class: "atc-crumb-code" }, lvl.atc),
      lvl.name ? el("span", { class: "atc-crumb-name" }, lvl.name) : null,
    ]));
    if (i < levels.length - 1) {
      items.push(el("span", { class: "atc-crumb-sep", "aria-hidden": "true" }, "›"));
    }
  });
  return el("section", { class: "card breadcrumb-card", "aria-label": "ATC hierarchy" }, [
    el("p", { class: "card-title" }, "ATC hierarchy"),
    el("div", { class: "atc-crumbs" }, items),
  ]);
}

/**
 * Collapsible Level-5 group header used in L4 query results. Returns the
 * header <tr> ready to drop into a <tbody>. Toggling fires the callback,
 * which mode3 uses to hide/show every row tagged with the same group key.
 */
export function levelFiveGroupHeader({ atc, name, count, onToggle }) {
  let isOpen = true;
  const chevron = el("span", { class: "group-chevron", "aria-hidden": "true" }, "▼");
  const button = el("button", {
    type: "button",
    class: "group-header-btn",
    "aria-expanded": "true",
  }, [
    chevron,
    el("span", { class: "code group-header-code" }, atc),
    el("span", { class: "group-header-name" }, name || ""),
    el("span", { class: "group-header-count" }, `${count} RXCUI${count === 1 ? "" : "s"}`),
  ]);
  button.addEventListener("click", () => {
    isOpen = !isOpen;
    chevron.textContent = isOpen ? "▼" : "▶";
    button.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (onToggle) onToggle(isOpen);
  });

  const tr = el("tr", { class: "group-header-row", "data-group": atc }, [
    el("td", { colspan: "6" }, button),
  ]);
  return { tr, button };
}

/**
 * Active NDC sub-list. Shows up to `initialMax` NDCs initially with a
 * "Show all N" button when there are more.
 */
export function ndcSubList({ ndcs = [], initialMax = 50 } = {}) {
  const container = el("div", { class: "ndc-sublist" });
  container.appendChild(el("p", { class: "card-title" },
    ndcs.length === 0 ? "No active NDCs" : `Active NDCs (${ndcs.length})`));

  if (ndcs.length === 0) return container;

  const list = el("ul", { class: "ndc-list" });
  const showAll = ndcs.length <= initialMax;
  const visible = showAll ? ndcs : ndcs.slice(0, initialMax);
  for (const n of visible) {
    list.appendChild(el("li", {}, el("span", { class: "code" }, n)));
  }
  container.appendChild(list);

  if (!showAll) {
    const moreBtn = el("button", {
      type: "button",
      class: "link-btn",
    }, `Show all ${ndcs.length}`);
    moreBtn.addEventListener("click", () => {
      list.innerHTML = "";
      for (const n of ndcs) {
        list.appendChild(el("li", {}, el("span", { class: "code" }, n)));
      }
      moreBtn.remove();
    });
    container.appendChild(moreBtn);
  }
  return container;
}

/**
 * One row of the Mode 3 member table. Columns:
 *   Status | RXCUI | TTY | Drug Name | (▶)
 * Returns the same { tr, detailRow, update, setOnExpand } shape as batchRow.
 */
export function memberRow({ rxcui, groupKey }) {
  const statusCell = el("td", { class: "cell-status" }, statusBadge("PENDING"));
  const rxcuiCell = el("td", { class: "cell-rxcui" }, el("span", { class: "code" }, rxcui));
  const ttyCell = el("td", { class: "cell-tty" }, "…");
  const nameCell = el("td", { class: "cell-name" }, "…");
  const resolvedCell = el("td", { class: "cell-resolved" }, "…");
  const chevron = el("button", {
    type: "button",
    class: "row-toggle",
    "aria-label": "Expand details",
    "aria-expanded": "false",
    disabled: true,
  }, "▶");
  const togCell = el("td", { class: "cell-toggle" }, chevron);

  const tr = el("tr", {
    class: "member-row",
    "data-status": "PENDING",
    "data-rxcui": rxcui,
    "data-group": groupKey || "",
  }, [statusCell, rxcuiCell, ttyCell, nameCell, resolvedCell, togCell]);

  const detailContainer = el("div", { class: "row-detail-inner" });
  const detailRow = el("tr", {
    class: "member-row-detail",
    hidden: true,
    "data-group": groupKey || "",
  }, [el("td", { colspan: "6" }, detailContainer)]);

  let isOpen = false;
  let detailRendered = false;
  let onExpandHandler = null;

  chevron.addEventListener("click", () => {
    isOpen = !isOpen;
    chevron.textContent = isOpen ? "▼" : "▶";
    chevron.setAttribute("aria-label", isOpen ? "Collapse details" : "Expand details");
    chevron.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) detailRow.removeAttribute("hidden");
    else detailRow.setAttribute("hidden", "");
    if (isOpen && !detailRendered && onExpandHandler) {
      detailRendered = true;
      onExpandHandler(detailContainer);
    }
  });

  function update({ status, tty, name, reason, tooltip, resolvedAtc, resolvedAtcName }) {
    if (status !== undefined) {
      statusCell.innerHTML = "";
      const badge = statusBadge(status, tooltip || "");
      if (tooltip) badge.setAttribute("data-tooltip-align", "start");
      statusCell.appendChild(badge);
      tr.dataset.status = status;
      // Enable expand for any row with substantive data; NEEDS_REVIEW without
      // a name is the only case where there's nothing to show.
      const hasDetail = status !== "NEEDS_REVIEW" || !!name;
      chevron.disabled = !hasDetail;
      chevron.title = hasDetail ? "Show full Mode 1 detail" : (reason || "No detail available");
    }
    if (tty !== undefined) ttyCell.textContent = tty || "—";
    if (name !== undefined) {
      nameCell.textContent = name || (status === "NEEDS_REVIEW" ? "—" : "(unknown)");
      nameCell.title = name || "";
    }
    if (resolvedAtc !== undefined) {
      resolvedCell.innerHTML = "";
      if (resolvedAtc) {
        resolvedCell.appendChild(el("span", { class: "code" }, resolvedAtc));
        if (resolvedAtcName) {
          resolvedCell.title = resolvedAtcName;
        }
      } else {
        resolvedCell.textContent = "—";
      }
    }
  }

  function setOnExpand(fn) { onExpandHandler = fn; }

  return { tr, detailRow, update, setOnExpand };
}

