"""
engine.py — Route-aware RxCUI → ATC resolver.

Python port of js/atc-resolver.js + js/filter-engine.js from the MedCode
Lookup app. Keep the matrix tables and strategy order in sync with the JS
when the app updates them.

Public entry points:

    resolver = AtcResolver(cache_path="cache.sqlite")
    verdict  = resolver.convert_rxcui_to_atc(rxcui)
        # → {
        #     "status":         "KEEP" | "INGREDIENT_LEVEL" | "NO_ATC",
        #     "codes":          [{"code": "R01AD08", "name": "..."}],
        #     "route":          "nasal" | "..." | "unknown",
        #     "tty":            "SCD",
        #     "route_override": bool   (Strategy 1 kept a code the matrix would reject)
        #   }

Designed for very long runs: persistent SQLite cache, FIFO rate-limited
request queue (15 req/s, 6 concurrent), retry+backoff on 5xx, graceful 404
handling. Single-process (no threads); audit.py drives it with a worker
pool.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Set

BASE = "https://rxnav.nlm.nih.gov/REST"
CACHE_TTL_SEC = 30 * 24 * 60 * 60  # 30 days
RATE_LIMIT_PER_SEC = 15
MAX_CONCURRENT = 6
RETRY_DELAYS = [1.0, 2.0, 4.0]
REQUEST_TIMEOUT = 30  # seconds


# ----------------------------------------------------------------------
# Route filter matrix — verbatim from js/filter-engine.js.
# DO NOT edit without coordinating with the app team.
# ----------------------------------------------------------------------

DFG_ROUTE_MAP = {
    "Buccal Product":      "buccal",
    "Inhalant Product":    "inhalant",
    "Injectable Product":  "injectable",
    "Mucosal Product":     "mucosal",
    "Nasal Product":       "nasal",
    "Ophthalmic Product":  "ophthalmic",
    "Oral Product":        "oral",
    "Otic Product":        "otic",
    "Rectal Product":      "rectal",
    "Sublingual Product":  "sublingual",
    "Topical Product":     "topical",
    "Transdermal Product": "transdermal",
    "Vaginal Product":     "vaginal",
}

# Most-specific local routes win over broader systemic ones.
DFG_PRIORITY = [
    "Ophthalmic Product",
    "Otic Product",
    "Nasal Product",
    "Vaginal Product",
    "Rectal Product",
    "Buccal Product",
    "Sublingual Product",
    "Mucosal Product",
    "Inhalant Product",
    "Topical Product",
    "Transdermal Product",
    "Oral Product",
    "Injectable Product",
]

# Each rule has either an "allow" prefix set (kept iff any matches) or an
# "exclude" prefix set (kept iff no exclude prefix matches). Keep prefixes
# sorted longest-first within each rule.
ROUTE_ATC_MATRIX = {
    "ophthalmic":  {"mode": "allow",   "prefixes": ["S01", "S03"]},
    "otic":        {"mode": "allow",   "prefixes": ["S02", "S03"]},
    "nasal":       {"mode": "allow",   "prefixes": ["R01"]},
    "inhalant":    {"mode": "allow",   "prefixes": ["R03", "R07"]},
    "vaginal":     {"mode": "allow",   "prefixes": ["G01", "G02", "G03C"]},
    "rectal":      {"mode": "allow",   "prefixes": ["A06", "A07E", "C05", "G01", "D07"]},
    "topical":     {"mode": "allow",   "prefixes": ["D", "M02", "N01B", "C05"]},
    "transdermal": {"mode": "allow",   "prefixes": ["D", "M02", "N01B", "C05"]},
    "buccal":      {"mode": "allow",   "prefixes": ["A01", "R02"]},
    "sublingual":  {"mode": "allow",   "prefixes": ["A01", "R02", "C01"]},
    "mucosal":     {"mode": "allow",   "prefixes": ["D", "M02", "C05"]},
    "oral":        {"mode": "exclude", "prefixes": ["S01", "S02", "R01", "R02", "D", "G01", "G02", "M02", "B05X"]},
    "injectable":  {"mode": "exclude", "prefixes": ["S01", "S02", "R01", "R02", "D", "G01", "M02"]},
}

INGREDIENT_TTYS = {"IN", "MIN", "PIN"}


def resolve_route(dfg_names: List[str]) -> str:
    """Pick the highest-priority DFG present and translate to a route key."""
    if not dfg_names:
        return "unknown"
    for dfg in DFG_PRIORITY:
        if dfg in dfg_names:
            return DFG_ROUTE_MAP[dfg]
    # No priority match; return the first that maps, else "unknown".
    for d in dfg_names:
        if d in DFG_ROUTE_MAP:
            return DFG_ROUTE_MAP[d]
    return "unknown"


def classify_atc_for_route(atc: str, route: str) -> Dict[str, Any]:
    """Return {kept: bool, mode, matched_prefix, allowed_prefixes}."""
    rule = ROUTE_ATC_MATRIX.get(route)
    if not rule:
        return {"kept": True, "mode": "no-rule"}
    code = (atc or "").upper()
    matched = next((p for p in rule["prefixes"] if code.startswith(p)), None)
    if rule["mode"] == "allow":
        return {"kept": matched is not None, "mode": "allow",
                "matched_prefix": matched, "allowed_prefixes": rule["prefixes"]}
    # exclude
    return {"kept": matched is None, "mode": "exclude",
            "matched_prefix": matched, "allowed_prefixes": rule["prefixes"]}


def filter_atc_by_route(codes: List[str], route: str) -> List[str]:
    """Apply the route filter. Safety valve: if filtering removes ALL codes,
    return the unfiltered list rather than emptying the result."""
    if not route or route == "unknown":
        return list(codes)
    kept = [c for c in codes if classify_atc_for_route(c, route)["kept"]]
    return kept if kept else list(codes)


# ----------------------------------------------------------------------
# Rate-limited request scheduler.
# ----------------------------------------------------------------------

class _Scheduler:
    """FIFO scheduler: at most `concurrent` in-flight, at most `per_sec` starts/sec."""

    def __init__(self, concurrent: int, per_sec: int) -> None:
        self._sem = threading.Semaphore(concurrent)
        self._min_interval = 1.0 / per_sec
        self._last_start = 0.0
        self._start_lock = threading.Lock()

    def acquire(self) -> None:
        self._sem.acquire()
        with self._start_lock:
            now = time.monotonic()
            wait = max(0.0, self._last_start + self._min_interval - now)
            if wait > 0:
                time.sleep(wait)
            self._last_start = time.monotonic()

    def release(self) -> None:
        self._sem.release()


# ----------------------------------------------------------------------
# Persistent cache (SQLite, JSON-encoded values, 30-day TTL).
# ----------------------------------------------------------------------

class _DiskCache:
    """One row per (namespace, key). Thread-safe via a single connection
    + a lock; SQLite's own threading model isn't great under load, so we
    serialize writes."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS entries (
      namespace TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );
    """

    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute(self.SCHEMA)
        self._lock = threading.Lock()

    def get(self, namespace: str, key: str) -> Optional[Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT value, ts FROM entries WHERE namespace=? AND key=?",
                (namespace, key),
            ).fetchone()
        if not row:
            return None
        value, ts = row
        if time.time() - ts > CACHE_TTL_SEC:
            return None
        return json.loads(value)

    def put(self, namespace: str, key: str, value: Any) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO entries (namespace, key, value, ts) VALUES (?, ?, ?, ?)",
                (namespace, key, json.dumps(value), int(time.time())),
            )


# ----------------------------------------------------------------------
# AtcResolver — the public API.
# ----------------------------------------------------------------------

def _as_list(x: Any) -> List[Any]:
    if x is None:
        return []
    if isinstance(x, list):
        return x
    return [x]


class AtcResolver:
    def __init__(self, cache_path: str = "cache.sqlite") -> None:
        self._cache = _DiskCache(cache_path)
        self._scheduler = _Scheduler(MAX_CONCURRENT, RATE_LIMIT_PER_SEC)

    # ------------- network (stdlib urllib so the skill has zero pip deps) -

    def _fetch(self, url: str) -> Any:
        """GET with retry. 404 returns the sentinel {'__not_found': True};
        5xx retries with exponential backoff; other HTTP errors raise."""
        req = urllib.request.Request(url, headers={"User-Agent": "route-aware-atc-audit/1.0"})
        for attempt in range(len(RETRY_DELAYS) + 1):
            self._scheduler.acquire()
            status = None
            body = None
            err = None
            try:
                try:
                    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                        status = resp.status
                        body = resp.read()
                except urllib.error.HTTPError as e:
                    status = e.code
                    try:
                        body = e.read()
                    except Exception:
                        body = b""
                except urllib.error.URLError as e:
                    err = e
                except TimeoutError as e:
                    err = e
            finally:
                self._scheduler.release()

            if err is not None:
                if attempt < len(RETRY_DELAYS):
                    time.sleep(RETRY_DELAYS[attempt])
                    continue
                raise RuntimeError(f"Network error for {url}: {err}")

            if status == 404:
                return {"__not_found": True}
            if status and 200 <= status < 300:
                if not body:
                    return {}
                try:
                    return json.loads(body.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return {}
            if status and 500 <= status < 600 and attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt])
                continue
            raise RuntimeError(f"HTTP {status} for {url}")
        raise RuntimeError(f"Request failed: {url}")

    # ------------- per-endpoint helpers (each cached) ----------------

    def get_properties(self, rxcui: str) -> Dict[str, Any]:
        cached = self._cache.get("rxcui_props", rxcui)
        if cached is not None:
            return cached
        data = self._fetch(f"{BASE}/rxcui/{rxcui}/properties.json")
        if data.get("__not_found") or not data.get("properties"):
            result = {"found": False, "rxcui": rxcui}
        else:
            p = data["properties"]
            result = {"found": True, "rxcui": rxcui, "name": p.get("name"),
                      "tty": p.get("tty"), "synonym": p.get("synonym")}
        self._cache.put("rxcui_props", rxcui, result)
        return result

    def get_dfgs(self, rxcui: str) -> List[str]:
        cached = self._cache.get("rxcui_dfg", rxcui)
        if cached is not None:
            return cached
        try:
            data = self._fetch(f"{BASE}/rxcui/{rxcui}/related.json?tty=DFG")
        except RuntimeError:
            self._cache.put("rxcui_dfg", rxcui, [])
            return []
        names: List[str] = []
        if not data.get("__not_found"):
            for g in _as_list(data.get("relatedGroup", {}).get("conceptGroup")):
                if g.get("tty") != "DFG":
                    continue
                for p in _as_list(g.get("conceptProperties")):
                    if p and p.get("name"):
                        names.append(p["name"])
        self._cache.put("rxcui_dfg", rxcui, names)
        return names

    def get_ingredient_rxcuis(self, rxcui: str) -> List[str]:
        """Returns the RxCUI itself plus its IN-related RxCUIs (or just the
        input if related fetch fails)."""
        cached = self._cache.get("rxcui_in", rxcui)
        if cached is not None:
            return cached
        ids: Set[str] = {str(rxcui)}
        try:
            data = self._fetch(f"{BASE}/rxcui/{rxcui}/related.json?tty=IN")
        except RuntimeError:
            data = {}
        if not data.get("__not_found"):
            for g in _as_list(data.get("relatedGroup", {}).get("conceptGroup")):
                for p in _as_list(g.get("conceptProperties")):
                    if p and p.get("rxcui"):
                        ids.add(str(p["rxcui"]))
        values = list(ids)
        self._cache.put("rxcui_in", rxcui, values)
        return values

    def _get_atc_by_rxcui(self, rxcui: str, rela_source: str) -> List[Dict[str, str]]:
        ns = f"rxcui_atc_{rela_source.lower()}"
        cached = self._cache.get(ns, rxcui)
        if cached is not None:
            return cached
        url = f"{BASE}/rxclass/class/byRxcui.json?rxcui={rxcui}&relaSource={rela_source}"
        try:
            data = self._fetch(url)
        except RuntimeError:
            self._cache.put(ns, rxcui, [])
            return []
        out: List[Dict[str, str]] = []
        seen: Set[str] = set()
        if not data.get("__not_found"):
            for item in _as_list(data.get("rxclassDrugInfoList", {}).get("rxclassDrugInfo")):
                m = item.get("rxclassMinConceptItem", {})
                cid = str(m.get("classId", "")).strip()
                if not cid or cid in seen:
                    continue
                seen.add(cid)
                out.append({"classId": cid, "className": str(m.get("className", "")).strip()})
        self._cache.put(ns, rxcui, out)
        return out

    def get_atcprod_classes(self, rxcui: str) -> List[Dict[str, str]]:
        return self._get_atc_by_rxcui(rxcui, "ATCPROD")

    def get_ingredient_atc_classes(self, rxcui: str) -> List[Dict[str, str]]:
        return self._get_atc_by_rxcui(rxcui, "ATC")

    def get_atc_property_values(self, rxcui: str) -> List[str]:
        cached = self._cache.get("rxcui_atc_prop", rxcui)
        if cached is not None:
            return cached
        try:
            data = self._fetch(f"{BASE}/rxcui/{rxcui}/property.json?propName=ATC")
        except RuntimeError:
            self._cache.put("rxcui_atc_prop", rxcui, [])
            return []
        codes: List[str] = []
        if not data.get("__not_found"):
            for p in _as_list(data.get("propConceptGroup", {}).get("propConcept")):
                if p and p.get("propValue"):
                    codes.append(str(p["propValue"]).strip())
        self._cache.put("rxcui_atc_prop", rxcui, codes)
        return codes

    def get_class_members(self, class_id: str, rela_source: str = "ATC") -> List[Dict[str, Any]]:
        ns = f"class_members_{rela_source.lower()}"
        cached = self._cache.get(ns, class_id)
        if cached is not None:
            return cached
        url = f"{BASE}/rxclass/classMembers.json?classId={class_id}&relaSource={rela_source}"
        try:
            data = self._fetch(url)
        except RuntimeError:
            self._cache.put(ns, class_id, [])
            return []
        out: List[Dict[str, Any]] = []
        if not data.get("__not_found"):
            for m in _as_list(data.get("drugMemberGroup", {}).get("drugMember")):
                mc = m.get("minConcept", {})
                if not mc.get("rxcui"):
                    continue
                source_id = source_name = None
                for a in _as_list(m.get("nodeAttr")):
                    if a.get("attrName") == "SourceId":
                        source_id = a.get("attrValue")
                    elif a.get("attrName") == "SourceName":
                        source_name = a.get("attrValue")
                out.append({
                    "rxcui": str(mc["rxcui"]),
                    "tty": mc.get("tty"),
                    "sourceId": source_id,
                    "sourceName": source_name,
                })
        self._cache.put(ns, class_id, out)
        return out

    # ------------- L4 → L5 promotion (3-pass match) ----------------

    def resolve_level5_from_class_members(self, rxcui: str, level4_class_ids: List[str]) -> Optional[List[Dict[str, str]]]:
        """Given an input RxCUI and L4 class IDs, return matching L5 codes.

        Three-pass strategy (first hit wins per L4):
            1. Single-ingredient direct match — member.rxcui ∈ input's
               ingredient set, sourceId is a 7-char L5.
            2. MIN-equality match — for combination products, find a MIN
               concept member whose ingredient set equals the input's.
            3. Bottom-of-function fallback — query each ingredient RxCUI's
               ATC classes and pick L5 codes starting with one of the
               target L4 prefixes.
        """
        match_ids = self.get_ingredient_rxcuis(rxcui)
        self_id = str(rxcui)
        input_ings = {i for i in match_ids if i != self_id}
        level5: List[Dict[str, str]] = []

        for class_id in level4_class_ids:
            if len(class_id) != 5:
                continue
            members = self.get_class_members(class_id, "ATC")

            hit: Optional[Dict[str, str]] = None
            # Pass 1
            for m in members:
                if not m.get("rxcui") or m["rxcui"] not in match_ids:
                    continue
                sid = m.get("sourceId") or ""
                if len(sid) == 7:
                    hit = {"code": sid, "name": m.get("sourceName") or "Name not available"}
                    break

            # Pass 2 (combination, MIN-equality)
            if hit is None and len(input_ings) >= 2:
                for m in members:
                    if not m.get("rxcui") or m.get("tty") != "MIN":
                        continue
                    sid = m.get("sourceId") or ""
                    if len(sid) != 7:
                        continue
                    min_related = self.get_ingredient_rxcuis(m["rxcui"])
                    min_ings = {i for i in min_related if i != str(m["rxcui"])}
                    if min_ings == input_ings:
                        hit = {"code": sid, "name": m.get("sourceName") or "Name not available"}
                        break

            if hit:
                level5.append(hit)

        if level5:
            return level5

        # Pass 3 fallback — walk each ingredient's ATC classes.
        seen5: Set[str] = set()
        for ing in match_ids:
            try:
                classes = self.get_ingredient_atc_classes(ing)
            except Exception:
                continue
            for c in classes:
                cid = (c.get("classId") or "").upper()
                if len(cid) != 7 or cid in seen5:
                    continue
                if any(cid.startswith(l4.upper()) for l4 in level4_class_ids):
                    seen5.add(cid)
                    level5.append({"code": cid, "name": c.get("className") or "Name not available"})
        return level5 if level5 else None

    # ------------- main entry point ----------------

    def convert_rxcui_to_atc(self, rxcui: str) -> Dict[str, Any]:
        """Return the verdict for one RxCUI. Mirrors atc-resolver.js's
        convertRxcuiToAtc."""
        props = self.get_properties(rxcui)
        if props.get("found") and props.get("tty") in INGREDIENT_TTYS:
            property_codes = self.get_atc_property_values(rxcui)
            codes = [
                {"code": c, "name": props.get("name") or None}
                for c in property_codes if len(c) == 7
            ]
            return {"status": "INGREDIENT_LEVEL", "tty": props["tty"], "codes": codes, "route": "ingredient"}

        atcprod = self.get_atcprod_classes(rxcui)
        dfgs = self.get_dfgs(rxcui)
        ingredient = self.get_ingredient_atc_classes(rxcui)
        prop_codes = self.get_atc_property_values(rxcui)

        route = resolve_route(dfgs)

        atcprod_fallback: Optional[List[Dict[str, str]]] = None
        atcprod_prefixes: Optional[List[str]] = None

        # ----- Strategy 1: ATCPROD -----
        if atcprod:
            uniques = [{"code": c["classId"], "name": c.get("className") or "Name not available"} for c in atcprod]
            l4_ids = [c["code"] for c in uniques if 4 <= len(c["code"]) <= 5]
            if l4_ids:
                promoted = self.resolve_level5_from_class_members(rxcui, l4_ids)
                if promoted:
                    return self._build_keep(promoted, route, props.get("tty"))
            l5_direct = [c for c in uniques if len(c["code"]) == 7]
            if l5_direct:
                return self._build_keep(l5_direct, route, props.get("tty"))
            atcprod_fallback = uniques
            atcprod_prefixes = l4_ids

        def _prefix_ok(item: Any) -> bool:
            if not atcprod_prefixes:
                return True
            c = (item["code"] if isinstance(item, dict) else str(item)).upper()
            return any(c.startswith(p.upper()) for p in atcprod_prefixes)

        # ----- Strategy 2: ingredient ATC + DFG route filter -----
        if ingredient:
            atc_list = [{"code": c["classId"], "name": c.get("className") or "Name not available"} for c in ingredient]
            l5_items = [it for it in atc_list if len(it["code"]) == 7 and _prefix_ok(it)]
            l5_codes = filter_atc_by_route([it["code"] for it in l5_items], route)
            kept_l5 = [it for it in l5_items if it["code"] in l5_codes]
            if kept_l5:
                return {"status": "KEEP", "codes": kept_l5, "route": route, "tty": props.get("tty")}

            if atcprod_fallback is None:
                l4_codes = filter_atc_by_route([c["code"] for c in atc_list if len(c["code"]) == 5], route)
                if l4_codes:
                    promoted = self.resolve_level5_from_class_members(rxcui, l4_codes)
                    if promoted:
                        return {"status": "KEEP", "codes": promoted, "route": route, "tty": props.get("tty")}

        # ----- Strategy 3: property API -----
        if prop_codes:
            l5_filtered = filter_atc_by_route([c for c in prop_codes if len(c) == 7 and _prefix_ok(c)], route)
            if l5_filtered:
                named = [{"code": c, "name": "Name not available"} for c in l5_filtered]
                return {"status": "KEEP", "codes": named, "route": route, "tty": props.get("tty")}
            if atcprod_fallback is None:
                l4_codes = filter_atc_by_route([c for c in prop_codes if len(c) == 5], route)
                if l4_codes:
                    promoted = self.resolve_level5_from_class_members(rxcui, l4_codes)
                    if promoted:
                        return {"status": "KEEP", "codes": promoted, "route": route, "tty": props.get("tty")}

        # ----- Last resort: ATCPROD L4 fallback -----
        if atcprod_fallback:
            return {"status": "KEEP", "codes": atcprod_fallback, "route": route, "tty": props.get("tty")}
        return {"status": "NO_ATC", "codes": [], "route": route, "tty": props.get("tty")}

    def _build_keep(self, level5: List[Dict[str, str]], route: str, tty: Optional[str]) -> Dict[str, Any]:
        """Strategy 1 keep, with route_override detection (the matrix would
        have rejected a code but NLM's product-level mapping kept it)."""
        if not route or route == "unknown":
            return {"status": "KEEP", "codes": level5, "route": route, "tty": tty}
        override: List[Dict[str, Any]] = []
        for c in level5:
            v = classify_atc_for_route(c["code"], route)
            if not v["kept"]:
                override.append({"code": c["code"], "name": c["name"], "verdict": v})
        result = {"status": "KEEP", "codes": level5, "route": route, "tty": tty}
        if override:
            result["route_override"] = override
        return result


# ----------------------------------------------------------------------
# Worker pool: process many RxCUIs in parallel through one resolver.
# ----------------------------------------------------------------------

def process_many(resolver: AtcResolver, rxcuis: List[str], workers: int = 8) -> Dict[str, Dict[str, Any]]:
    """Resolve a list of RxCUIs in parallel and return a {rxcui: verdict} dict.
    Network parallelism is controlled by the resolver's internal scheduler;
    `workers` controls how many resolver calls are in flight at once."""
    out: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(resolver.convert_rxcui_to_atc, r): r for r in rxcuis}
        for f in futs:
            r = futs[f]
            try:
                out[r] = f.result()
            except Exception as e:
                out[r] = {"status": "ERROR", "error": str(e), "codes": []}
    return out
