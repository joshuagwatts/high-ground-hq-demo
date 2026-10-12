/**
 * HailScope fork for High Ground HQ — hail-first storm map.
 * Orchestration ported from Ground Control's app.js renderWx()/wireHsShell()/
 * onHailTap()/onHailViewport(), with lens/chat/jobs/keys/investor/field-team
 * chrome removed. The map + storm engine (wx.js) is untouched.
 */
import {
  mountMap,
  setHailScopeMode,
  defaultMapCenter,
  quickMapConfig,
  clearWxPin,
  bindWxMapScrollExpand,
  bindSelectPinDblTap,
  bindHailSearchClick,
  bindStormSheetOpen,
  setMapViewHailArmed,
  viewportDossier,
  pinDossier,
  refetchDossier,
  hailScopeDays,
  syncHailScopeView,
  patchHailScopePartial,
  revealHailStormSheet,
  revealHailAddressPeek,
  setWxPin,
  wxPinSelected,
  clearSelectedStormDate,
  geocodeAddress,
  flyToPin,
  setMapLayer,
  baseLayerButtons,
  paintHailSearchIdle,
  syncHailScopeRadar,
  hailScopeRadarBarHtml,
  bindHailScopeRadar,
  refreshMapSize,
} from "./wx.js";
import { parseStreetAddress } from "./contacts.js";
import { load, save } from "./store.js";
import { locateDevice } from "./geo.js";
import { httpGet } from "./net.js";

/* ---------- tiny shell helpers (app.js had these globally) ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const setStatus = (msg) => {
  const el = $("#hs-status");
  if (el) el.textContent = msg || "";
};
// No tab bar in the fork — the hail tab is always the active one.
const isHailTab = () => true;

const db = load();
const persist = () => {
  try {
    save(db);
  } catch {
    /* storage may be unavailable */
  }
};

let wxState = { lat: null, lon: null, address: "", data: null, viewport: false };
let hailTapGen = 0;

/* ---------- storm search for the visible map area (from onHailViewport) ---------- */
async function onHailViewport() {
  const gen = ++hailTapGen;
  setMapViewHailArmed(true);
  clearSelectedStormDate();
  clearWxPin();
  wxState.lat = null;
  wxState.lon = null;
  wxState.address = "";
  wxState.viewport = true;
  wxState.data = null;
  const sheet = $("#hs-sheet");
  if (sheet) {
    sheet.innerHTML =
      '<p class="hs-pin hs-pin-ready">Searching visible area…</p><p class="hs-empty">Loading storm history…</p>';
  }
  setStatus("Loading storms…");
  const onRefetch = async (filters) => {
    if (gen !== hailTapGen) return null;
    const fresh = await viewportDossier(db.settings, filters);
    if (gen !== hailTapGen) return null;
    wxState.data = fresh;
    return fresh;
  };
  try {
    let paintedDays = 0;
    let lastPaintAt = 0;
    const data = await viewportDossier(db.settings, undefined, {
      onPartial: (partial) => {
        if (gen !== hailTapGen) return;
        wxState.data = partial;
        const days = hailScopeDays(partial);
        const n = days.length;
        if (!n || !sheet) return;
        const loading = Boolean(partial._meta?.loading);
        const first = !sheet.querySelector(".hs-date");
        const now = Date.now();
        const readyFirst = n >= 3 || !loading || /spc|swdi-recent|done/.test(String(partial._meta?.partial || ""));
        const grew = n > paintedDays;
        const due = now - lastPaintAt > (first ? 0 : 320);
        if ((first && readyFirst) || (!first && ((grew && due) || !loading))) {
          paintedDays = n;
          lastPaintAt = now;
          syncHailScopeView(sheet, partial, esc, { onRefetch, fit: false, revealSheet: true });
          setStatus(loading ? `Loading storms… ${n} dates` : `Storms ready · ${n} dates`);
        }
      },
    });
    if (gen !== hailTapGen) return;
    if (!data) {
      if (sheet) sheet.innerHTML = '<p class="hs-empty">Could not load storms for this map view.</p>';
      setStatus("Storms unavailable");
      return;
    }
    wxState.data = data;
    syncHailScopeView(sheet, data, esc, { onRefetch, fit: false, revealSheet: true });
    const n = hailScopeDays(data).length;
    setStatus(n ? `Storms ready · ${n} dates` : "No storms in map view");
  } catch (e) {
    if (gen !== hailTapGen) return;
    if (sheet) sheet.innerHTML = `<p class="hs-empty">${esc(String(e.message || e))}. Check the network and try again.</p>`;
    setStatus("Storms unavailable");
  }
}

/* ---------- pin storm dossier (from onHailTap; investor hunt removed) ---------- */
async function onHailTap(lat, lon, { address: prefAddr } = {}) {
  const gen = ++hailTapGen;
  const samePin =
    Number.isFinite(wxState.lat) &&
    Number.isFinite(wxState.lon) &&
    Math.abs(wxState.lat - lat) < 1e-5 &&
    Math.abs(wxState.lon - lon) < 1e-5;
  // Keep checked storm dates — accidental house taps should not wipe the overlay.
  wxState.lat = lat;
  wxState.lon = lon;
  wxState.viewport = false;
  const knownAddr = String(prefAddr || "").trim();
  wxState.address = knownAddr && !/^map\s*view$/i.test(knownAddr) ? knownAddr : wxState.address || "";
  setWxPin(lat, lon);
  const sheet = $("#hs-sheet");
  const onRefetch = async (filters) => {
    if (gen !== hailTapGen) return null;
    const fresh = await refetchDossier(db.settings, lat, lon, wxState.address, filters);
    if (gen !== hailTapGen) return null;
    wxState.data = fresh;
    return fresh;
  };
  if (samePin && wxState.data) {
    revealHailStormSheet({ interactive: true, scroll: false });
    syncHailScopeView(sheet, wxState.data, esc, { onRefetch, revealSheet: false });
    setStatus(`Storms ready · ${hailScopeDays(wxState.data).length} dates`);
    return;
  }
  wxState.data = null;
  // Map taps must not reuse the previous house address — reverse-geocode the new pin.
  if (!samePin) wxState.address = knownAddr && !/^map\s*view$/i.test(knownAddr) ? knownAddr : "";
  const addr0 = wxState.address || "Dropped pin";
  if (sheet) {
    sheet.innerHTML = `<p class="hs-pin"><strong>${esc(addr0)}</strong>Finding storms…</p><p class="hs-empty">Loading storm history…</p>`;
  }
  const addrBox = $("#hs-addr-q");
  // Never stuff viewport labels / stale pins into the search box
  if (addrBox) {
    if (wxState.address && parseStreetAddress(wxState.address).house) addrBox.value = wxState.address;
    else addrBox.value = "";
  }
  revealHailAddressPeek();
  setStatus("Loading storms…");
  try {
    const data = await pinDossier(db.settings, lat, lon, {
      address: wxState.address,
      onPartial: (partial) => {
        if (gen !== hailTapGen) return;
        // Ignore stale coords if a newer tap already moved the pin
        if (Number.isFinite(partial.lat) && Number.isFinite(partial.lon)) {
          const dLat = Math.abs(partial.lat - lat);
          const dLon = Math.abs(partial.lon - lon);
          if (dLat > 1e-5 || dLon > 1e-5) return;
        }
        const nextAddr = partial.address || "";
        if (!knownAddr || parseStreetAddress(nextAddr).house) wxState.address = nextAddr;
        wxState.data = partial;
        if ((partial.hail || []).length) {
          syncHailScopeView($("#hs-sheet"), partial, esc, { onRefetch, revealSheet: false });
          setStatus(`Loading storms… ${(partial.hail || []).length} dates`);
        } else {
          patchHailScopePartial($("#hs-sheet"), partial, esc);
        }
      },
    });
    if (gen !== hailTapGen) return;
    if (!data) {
      if (sheet) sheet.innerHTML = `<p class="hs-empty">Could not load storm data. Try another pin.</p>`;
      setStatus("Storms unavailable");
      return;
    }
    wxState.address = data.address || "";
    wxState.data = data;
    syncHailScopeView($("#hs-sheet"), data, esc, { onRefetch, revealSheet: false });
    const fetchedDays = Number(data._meta?.fetchedDays) || 0;
    if (!(data.hail || []).length && fetchedDays < 730) {
      if (sheet) {
        const loading = sheet.querySelector(".hs-empty");
        if (loading) loading.textContent = "Searching a longer hail window…";
      }
      setStatus("Loading storms… longer window");
      const full = await onRefetch({ days: 730 });
      if (gen !== hailTapGen) return;
      if (full) {
        wxState.data = full;
        syncHailScopeView($("#hs-sheet"), full, esc, { onRefetch, revealSheet: false });
      }
    }
    const n = hailScopeDays(wxState.data || data).length;
    setStatus(n ? `Storms ready · ${n} dates` : "No storms at this pin");
  } catch (e) {
    if (gen !== hailTapGen) return;
    if (sheet) sheet.innerHTML = `<p class="hs-empty">${esc(String(e.message || e))}. Check the network and try another pin.</p>`;
    setStatus("Storms unavailable");
  }
}

/* ---------- shell wiring (from wireHsShell, slimmed) ---------- */
function wireSearch() {
  const form = $("#hs-search");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const q = ($("#hs-addr-q")?.value || "").trim();
    if (!q) return;
    const gen = hailTapGen;
    setStatus("Finding place…");
    try {
      const hits = await geocodeAddress(q, { city: db.settings.city || "Edmond" });
      if (gen !== hailTapGen) return;
      const hit = hits[0];
      if (!hit || !Number.isFinite(hit.lat)) throw new Error("no match");
      flyToPin(hit.lat, hit.lon, 20);
      await onHailTap(hit.lat, hit.lon, { address: hit.address || q });
    } catch (err) {
      setStatus(String(err.message || err).slice(0, 48));
    }
  };
  for (const id of ["hs-layers", "hs-composer", "hs-radar-top"]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  }
}

function wireLayerButtons(cfg) {
  const styles = $("#hs-styles");
  if (styles && cfg) {
    styles.innerHTML = baseLayerButtons(cfg, esc);
    styles.onclick = (e) => {
      const b = e.target.closest("button[data-layer]");
      if (!b) return;
      setMapLayer(b.dataset.layer);
      persist();
      styles.querySelectorAll("button[data-layer]").forEach((x) => x.classList.toggle("on", x === b));
    };
  }
}

function paintRadarBar() {
  const shell = $("#hs-map-shell");
  if (!shell) return;
  syncHailScopeRadar(db.settings);
  let bar = $("#hs-radar-bar");
  const on = db.settings.showRadar === true;
  if (!on) {
    bar?.remove();
    shell.classList.remove("hs-radar-open");
    return;
  }
  const html = hailScopeRadarBarHtml(db.settings);
  if (!html) {
    bar?.remove();
    shell.classList.remove("hs-radar-open");
    return;
  }
  if (bar) bar.outerHTML = html;
  else {
    const mapEl = $("#wx-map");
    if (mapEl) mapEl.insertAdjacentHTML("beforebegin", html);
    else shell.insertAdjacentHTML("beforeend", html);
  }
  shell.classList.add("hs-radar-open");
  bindHailScopeRadar(shell);
}

function wireLocateMe() {
  const btn = $("#hs-locate");
  if (!btn) return;
  btn.onclick = async () => {
    setStatus("Locating…");
    try {
      const pos = await locateDevice(db.settings, httpGet, { force: true });
      const lat = Number(pos?.lat);
      const lon = Number(pos?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("no fix");
      flyToPin(lat, lon, 17);
      await onHailTap(lat, lon);
    } catch (err) {
      setStatus(String(err.message || err).slice(0, 48));
    }
  };
}

/* ---------- service worker (same-origin CORS proxy for NOAA) ---------- */
async function registerWebProxy() {
  if (!("serviceWorker" in navigator)) return false;
  const swUrl = new URL("./sw.js", import.meta.url);
  const scope = new URL("./", import.meta.url);
  try {
    const reg = await navigator.serviceWorker.register(swUrl, { scope: scope.href, updateViaCache: "none" });
    await reg.update().catch(() => {});
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => setTimeout(r, 250));
    return Boolean(navigator.serviceWorker.controller);
  } catch (err) {
    console.warn("service worker registration failed", err);
    return false;
  }
}

/* ---------- boot ---------- */
async function boot() {
  setHailScopeMode(true);
  document.body.classList.add("hs-tab", "wx-tab");

  await registerWebProxy();

  const center = defaultMapCenter(db.settings);
  const cfg = quickMapConfig(db.settings);
  wireSearch();
  wireLocateMe();
  wireLayerButtons(cfg);
  mountMap($("#wx-map"), cfg, {
    center,
    onTap: onHailTap,
    onHold: (lat, lon) => onHailTap(lat, lon),
    product: "hail",
    base: "sat",
    initialPin: false,
  });
  clearWxPin();
  wxState.lat = null;
  wxState.lon = null;
  wxState.address = "";
  wxState.data = null;
  wxState.viewport = false;
  bindWxMapScrollExpand($("#view"), $("#hs-map-shell"), $("#hs-sheet"), null);
  bindSelectPinDblTap(onHailViewport);
  bindHailSearchClick(() => {
    setMapViewHailArmed(true);
    void onHailViewport();
  });
  const refetchViewportStorms = async (filters) => {
    const fresh = await viewportDossier(db.settings, filters);
    if (fresh) {
      wxState.data = fresh;
      wxState.viewport = true;
    }
    return fresh;
  };
  bindStormSheetOpen(() => {
    // No house pin: show idle Search storms UI — do not auto-fetch
    if (wxPinSelected()) return;
    const sheet = $("#hs-sheet");
    if (!sheet) return;
    if (sheet.querySelector(".hs-pin-office, .hs-pin-listing, .hs-inv-peek")) return;
    if (wxState.viewport && wxState.data && !wxState.data._meta?.idle) {
      if (!sheet.querySelector(".hs-date") && !sheet.querySelector("#hs-hail-search")) {
        syncHailScopeView(sheet, wxState.data, esc, { onRefetch: refetchViewportStorms, revealSheet: false });
      }
      return;
    }
    paintHailSearchIdle(sheet, esc, { onRefetch: refetchViewportStorms });
  });

  paintRadarBar();
  refreshMapSize();
  if (Number.isFinite(center.lat) && Number.isFinite(center.lon)) {
    flyToPin(center.lat, center.lon, undefined, { stay: true });
  }
  // Storms stay idle until Search storms (or a pin tap) — same as Ground Control.
  paintHailSearchIdle($("#hs-sheet"), esc, { onRefetch: refetchViewportStorms });
  setStatus("");
}

boot().catch((err) => {
  const sheet = $("#hs-sheet");
  if (sheet) sheet.innerHTML = `<p class="hs-empty">Map failed to start: ${esc(String(err?.message || err))}</p>`;
  console.error(err);
});
