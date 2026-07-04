/* Waterline Scout — decision tool front-end (vanilla JS, no build step). */
(function () {
"use strict";

// ---------- data loading (globals first, fetch fallback for served mode) -----
async function loadData() {
  let data = window.WATERLINE_DATA;
  let media = window.WATERLINE_MEDIA;
  if (!data) {
    try { data = await (await fetch("data.json")).json(); }
    catch (e) { console.error("data load failed", e); }
  }
  if (!media) {
    try { media = await (await fetch("images/media-manifest.json")).json(); }
    catch (e) { media = {}; }
  }
  return { data, media: media || {} };
}

// ---------- helpers ----------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(k => k != null &&
    n.appendChild(typeof k === "string" ? document.createTextNode(k) : k));
  return n;
};
const fmtCAD = n => n == null ? "—" : "C$" + n.toLocaleString("en-CA");
const scoreClass = s => s >= 8 ? "s-hi" : s >= 7 ? "s-good" : s >= 6 ? "s-mid" : s >= 5 ? "s-low" : "s-bad";
const scoreVar = s => getComputedStyle(document.documentElement)
  .getPropertyValue("--" + scoreClass(s)).trim();

// ---------- state ------------------------------------------------------------
let TOWNS = [], MEDIA = {}, META = {};
const favorites = new Set();
const compareSel = new Set();
const filters = {
  regions: new Set(), warm: "any", budget: 3000,
  tiers: new Set(), tz: false, safety: false, favOnly: false, search: "",
};
const BUDGET_MAX = 3000;
const budgetCeil = () => filters.budget >= BUDGET_MAX ? Infinity : filters.budget;
const budgetLabel = () => filters.budget >= BUDGET_MAX ? "No limit" : fmtCAD(filters.budget);
let sort = "score-desc", view = "grid";

// ---------- favorites: localStorage + URL param ------------------------------
function loadFavorites() {
  const p = new URLSearchParams(location.search).get("fav");
  const fromUrl = p ? p.split(",").filter(Boolean) : null;
  let fromLS = [];
  try { fromLS = JSON.parse(localStorage.getItem("waterline_favs") || "[]"); } catch (e) {}
  (fromUrl || fromLS).forEach(id => favorites.add(id));
}
function saveFavorites() {
  try { localStorage.setItem("waterline_favs", JSON.stringify([...favorites])); } catch (e) {}
  const url = new URL(location.href);
  if (favorites.size) url.searchParams.set("fav", [...favorites].join(","));
  else url.searchParams.delete("fav");
  history.replaceState(null, "", url);
}

// ---------- media resolution -------------------------------------------------
// Priority per town: committed local photos -> live-fetched (browser) photos
// -> generated placeholders. Live photos are pulled client-side from Openverse
// (CC-licensed, CORS-enabled) so real imagery appears when the site is hosted /
// viewed on a device with internet — no build script or committed images needed.
let LIVE = true;                     // live-photo mode (persisted)
const liveCache = {};                // id -> { ts, photos:[{src,full,credit,...}] }
const liveTried = new Set();         // ids attempted this session (avoid refetch loops)

function photosFor(id) {
  if (id && typeof id === "object") id = id.id;
  const m = MEDIA[id] || {};
  const local = (m.photos || []).map(p => typeof p === "string" ? { src: p } : p);
  if (local.length) return local;
  const placeholders = (m.placeholders || []).map(src => ({ src, placeholder: true }));
  const live = LIVE && liveCache[id] ? liveCache[id].photos : null;
  if (live && live.length) {
    return live.length >= 3 ? live : live.concat(placeholders).slice(0, 3);
  }
  return placeholders;
}
function videoFor(id) {
  if (id && typeof id === "object") id = id.id;
  return (MEDIA[id] || {}).video || null;
}
function hasLocalPhotos(id) { return ((MEDIA[id] || {}).photos || []).length > 0; }

// ---- live client-side photo fetch (Openverse) -------------------------------
function loadLiveState() {
  try { LIVE = localStorage.getItem("waterline_live") !== "0"; } catch (e) {}
  try { Object.assign(liveCache, JSON.parse(localStorage.getItem("waterline_livecache") || "{}")); } catch (e) {}
}
function saveLiveCache() {
  try { localStorage.setItem("waterline_livecache", JSON.stringify(liveCache)); } catch (e) {}
}
async function fetchLive(id) {
  if (!LIVE || liveCache[id] || liveTried.has(id) || hasLocalPhotos(id)) return;
  liveTried.add(id);
  const t = TOWNS.find(x => x.id === id);
  if (!t) return;
  const q = t.media_query || `${t.town} ${t.country} beach`;
  try {
    const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=8&mature=false`,
      { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const photos = (d.results || []).map(p => ({
      src: p.thumbnail || p.url,
      full: p.url || p.thumbnail,
      credit: p.attribution || p.creator || p.title || "Openverse",
      license: `${(p.license || "").toUpperCase()} ${p.license_version || ""}`.trim(),
      source_url: p.foreign_landing_url || p.url,
      live: true,
    })).filter(p => p.src);
    if (photos.length) {
      liveCache[id] = { ts: Date.now(), photos };
      saveLiveCache();
      refreshCard(id);
    }
  } catch (e) { /* offline / CORS / rate-limited -> keep placeholders */ }
}
// small concurrency queue so we don't burst the API when many cards are visible
const liveQueue = []; let liveActive = 0; const LIVE_MAX = 3;
function queueLive(id) {
  if (!LIVE || liveCache[id] || liveTried.has(id) || hasLocalPhotos(id)) return;
  liveQueue.push(id); pumpLive();
}
function pumpLive() {
  while (liveActive < LIVE_MAX && liveQueue.length) {
    const id = liveQueue.shift(); liveActive++;
    fetchLive(id).finally(() => { liveActive--; pumpLive(); });
  }
}
let liveObserver = null;
function setupLiveObserver() {
  if (liveObserver) liveObserver.disconnect();
  if (!LIVE || !("IntersectionObserver" in window)) return;
  liveObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) { liveObserver.unobserve(e.target); queueLive(e.target.dataset.id); }
    });
  }, { rootMargin: "300px" });
  $$(".card").forEach(cardEl => {
    const id = cardEl.dataset.id;
    if (hasLocalPhotos(id) || liveCache[id] || liveTried.has(id)) return;
    liveObserver.observe(cardEl);
  });
}
function refreshCard(id) {
  const oldNode = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (!oldNode) return;
  const t = TOWNS.find(x => x.id === id);
  if (t) oldNode.replaceWith(card(t));
}

// ---------- filtering + sorting ---------------------------------------------
function passes(t) {
  if (filters.regions.size && !filters.regions.has(t.region)) return false;
  if (filters.tiers.size && !filters.tiers.has(t.cost_tier)) return false;
  if (filters.warm === "warm" && t.warm_now !== "yes") return false;
  if (filters.warm === "swim" && t.warm_now === "cool") return false;
  const low = t.rent_band_cad[0];
  if (low != null && low > budgetCeil()) return false;
  if (filters.tz && !t.na_interview_friendly) return false;
  if (filters.safety && t.has_risk) return false;
  if (filters.favOnly && !favorites.has(t.id)) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    if (!(t.town + " " + t.country + " " + t.region + " " + t.water_body)
      .toLowerCase().includes(q)) return false;
  }
  return true;
}
function sorted(list) {
  const rlo = { "Eastern Europe": 0, "Africa": 1, "Brazil": 2 };
  const by = {
    "score-desc": (a, b) => b.score - a.score,
    "score-asc": (a, b) => a.score - b.score,
    "price-asc": (a, b) => (a.rent_band_cad[0] ?? 9e9) - (b.rent_band_cad[0] ?? 9e9),
    "price-desc": (a, b) => (b.rent_band_cad[0] ?? -1) - (a.rent_band_cad[0] ?? -1),
    "region": (a, b) => (rlo[a.region] - rlo[b.region]) || b.score - a.score,
    "name": (a, b) => a.town.localeCompare(b.town),
  }[sort];
  return list.slice().sort(by);
}

// ---------- card -------------------------------------------------------------
const WARM_LABEL = { yes: "🌡 Warm now", partial: "🌊 Cool-ish", cool: "❄ Wetsuit" };
function card(t) {
  const pics = photosFor(t.id);
  const hero = pics[0];
  const isPh = pics.every(p => p.placeholder);
  const vid = videoFor(t.id);

  const heroImg = el("img", {
    class: "card-hero", src: hero.src, alt: t.town, loading: "lazy",
    onclick: () => openLightbox(t, 0),
  });
  const badges = el("div", { class: "media-badges" }, [
    el("span", { class: "badge warm-" + t.warm_now, text: WARM_LABEL[t.warm_now] }),
    t.has_risk ? el("span", { class: "badge risk risk-" + t.risk_level, text: "⚠ " + t.risk_level }) : null,
  ]);
  const scoreBadge = el("div", {
    class: "score-badge", text: t.score.toFixed(1),
    style: "background:" + scoreVar(t.score),
    title: "Score " + t.score,
  });
  const favBtn = el("button", {
    class: "fav-btn" + (favorites.has(t.id) ? " on" : ""),
    "aria-label": "Toggle favorite", text: favorites.has(t.id) ? "★" : "☆",
    onclick: (e) => { e.stopPropagation(); toggleFav(t.id); },
  });
  const thumbs = el("div", { class: "thumbs" },
    pics.slice(0, 3).map((p, i) => el("img", {
      src: p.src, alt: "", loading: "lazy",
      onclick: () => openLightbox(t, i),
    })));
  const media = el("div", { class: "card-media" }, [
    heroImg, badges, scoreBadge, favBtn, thumbs,
  ]);

  const rentEUR = t.rent_band_eur[0] != null
    ? `€${t.rent_band_eur[0]}–${t.rent_band_eur[1]}` : "—";
  const rentCAD = t.rent_band_cad[0] != null
    ? `${fmtCAD(t.rent_band_cad[0])}–${fmtCAD(t.rent_band_cad[1])}` : "—";
  const tz = t.tz_vs_toronto == null ? "—" : (t.tz_vs_toronto >= 0 ? "+" : "") + t.tz_vs_toronto + "h";

  const body = el("div", { class: "card-body" }, [
    el("div", { class: "card-title" }, [
      el("h3", { text: t.town }),
      el("div", { class: "country", text: t.country }),
    ]),
    el("div", { class: "meta-row", text: `${t.region} · ${t.water_body} · ${t.type}` }),
    el("div", { class: "chips" }, [
      el("span", { class: "chip", html: `Tier <b>${t.cost_tier || "—"}</b>` }),
      el("span", { class: "chip price", html: `Rent <b>${rentEUR}</b> · ${rentCAD}` }),
      el("span", { class: "chip", html: `Tourism <b>${t.tourism_tier || "—"}</b>` }),
      isPh ? el("span", { class: "chip", title: "Generated art — run scripts/fetch-media.mjs for real photos", text: "◇ placeholder art" }) : null,
    ]),
    el("p", { class: "blurb", text: t.blurb }),
    el("div", { class: "stat-line" }, [
      si("✈", t.airport_iata ? `${t.airport_iata} · ${t.airport_name}` : "airport?"),
      si("🕑", `${tz} vs Toronto${t.na_interview_friendly ? " ✓" : ""}`),
      si("📅", "peak " + (t.peak_months || "—")),
      si("🛂", shortVisa(t)),
    ]),
    safetyLine(t),
    el("div", { class: "card-actions" }, [
      el("button", {
        class: "cmp" + (compareSel.has(t.id) ? " on" : ""),
        text: compareSel.has(t.id) ? "✓ Comparing" : "+ Compare",
        onclick: () => toggleCompare(t.id),
      }),
      el("a", {
        class: "vid", href: imgSearch(t), target: "_blank", rel: "noopener",
        text: "🔍 Images ↗", title: "Opens a Google Images search in a new tab (needs internet)",
      }),
      vid
        ? el("button", { class: "vid", text: "▶ Video", onclick: () => openVideo(t) })
        : el("a", {
            class: "vid", href: ytSearch(t), target: "_blank", rel: "noopener",
            text: "▶ Video ↗", title: "Opens a YouTube search (needs internet)",
          }),
    ]),
  ]);

  return el("article", { class: "card", "data-id": t.id }, [media, body]);
}
function safetyLine(t) {
  const f = (t.safety_flag || "").trim();
  if (t.has_risk) {
    return el("div", { class: "meta-row", html: `⚠ <span style="color:var(--ink-dim)">${escapeHtml(f || t.risk_level + " risk")}</span>` });
  }
  const low = f.toLowerCase();
  if (!f || ["none", "none material", "low", "n/a"].includes(low)) return null;
  return el("div", { class: "meta-row", html: `ℹ <span style="color:var(--ink-faint)">${escapeHtml(f)}</span>` });
}
function si(ic, txt) {
  return el("span", { class: "si" }, [el("span", { class: "ic", text: ic }), el("span", { text: txt })]);
}
function shortVisa(t) {
  if (t.region === "Brazil") return "Brazil eVisa";
  const v = (t.visa_clock || "").toLowerCase();
  if (v.includes("own-365") || v.includes("365")) return "365d visa-free";
  if (v.includes("own-90")) return "90d own-clock";
  if (v.includes("schengen")) return "Schengen 90/180";
  if (t.visa_free_days && t.visa_free_days !== "0") return t.visa_free_days + "d visa-free";
  return "visa: check";
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function ytSearch(t) {
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(t.media_query || (t.town + " " + t.country + " beach drone"));
}
function imgSearch(t) {
  return "https://www.google.com/search?tbm=isch&q=" + encodeURIComponent(t.media_query || (t.town + " " + t.country + " beach"));
}
function ovSearch(t) {
  return "https://openverse.org/search/?q=" + encodeURIComponent((t.town + " " + t.country + " beach").trim());
}

// ---------- render dispatch --------------------------------------------------
function render() {
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#" + view + "View").classList.add("active");
  $("#cmpBadge").textContent = compareSel.size;
  $("#favCount").textContent = favorites.size;
  $("#favBtn").classList.toggle("active", filters.favOnly);
  if (view === "grid") renderGrid();
  else if (view === "compare") renderCompare();
  else renderMap();
}

function renderGrid() {
  const list = sorted(TOWNS.filter(passes));
  const grid = $("#grid");
  grid.innerHTML = "";
  list.forEach(t => grid.appendChild(card(t)));
  $("#emptyState").hidden = list.length > 0;
  $("#resultCount").innerHTML = `<b>${list.length}</b> of ${TOWNS.length} towns match`;
  setupLiveObserver();
}

// ---------- compare ----------------------------------------------------------
const CMP_ROWS = [
  ["Region", t => t.region],
  ["Country", t => t.country],
  ["Score", t => t.score.toFixed(1)],
  ["Water", t => `${t.water_body} (${t.type})`],
  ["Water temp", t => t.water_temp || "not in source"],
  ["Warm now (Jul–Nov)", t => ({ yes: "Yes ✓", partial: "Cool-ish", cool: "No — wetsuit" }[t.warm_now])],
  ["Seasonality", t => t.seasonality],
  ["Cost tier", t => t.cost_tier || "—"],
  ["Rent / mo (EUR)", t => t.rent_band_eur[0] != null ? `€${t.rent_band_eur[0]}–${t.rent_band_eur[1]}` : "—"],
  ["Rent / mo (CAD)", t => t.rent_band_cad[0] != null ? `${fmtCAD(t.rent_band_cad[0])}–${fmtCAD(t.rent_band_cad[1])}` : "—"],
  ["Price basis", t => t.price_basis],
  ["Tourism tier", t => t.tourism_tier || "—"],
  ["Peak months", t => t.peak_months || "—"],
  ["TZ vs Toronto", t => (t.tz_vs_toronto >= 0 ? "+" : "") + t.tz_vs_toronto + "h" + (t.na_interview_friendly ? " ✓ NA-friendly" : "")],
  ["Airport", t => t.airport_iata ? `${t.airport_iata} — ${t.airport_name}` : "—"],
  ["Visa", t => t.visa_clock || "—"],
  ["Safety", t => t.has_risk ? `⚠ ${t.risk_level}: ${t.safety_flag}` : (t.safety_flag || "no risk flag")],
];
function renderCompare() {
  const host = $("#compareContent");
  const empty = $("#compareEmpty");
  const ids = [...compareSel];
  host.innerHTML = "";
  empty.style.display = ids.length ? "none" : "block";
  if (!ids.length) return;
  const sel = ids.map(id => TOWNS.find(t => t.id === id)).filter(Boolean);

  const bar = el("div", { class: "compare-bar" },
    sel.map(t => el("span", { class: "pill" }, [
      el("span", { text: `${t.town} (${t.score.toFixed(1)})` }),
      el("button", { text: "✕", "aria-label": "remove", onclick: () => toggleCompare(t.id) }),
    ])).concat(el("button", { class: "link-btn", text: "Clear all", onclick: () => { compareSel.clear(); render(); } })));

  const thead = el("tr", {}, [el("th", { class: "rowhead", text: "" })].concat(
    sel.map(t => {
      const pics = photosFor(t.id);
      return el("th", {}, [
        el("img", { class: "cmp-photo", src: pics[0].src, alt: t.town }),
        el("div", { class: "cmp-strip" }, pics.slice(0, 3).map(p => el("img", { src: p.src, alt: "" }))),
        el("div", { class: "cmp-name", text: t.town, style: "margin-top:6px" }),
      ]);
    })));
  const rows = CMP_ROWS.map(([label, fn]) => el("tr", {}, [el("th", { class: "rowhead", text: label })]
    .concat(sel.map(t => el("td", { text: String(fn(t)) })))));
  const table = el("table", { class: "cmp" }, [el("thead", {}, thead), el("tbody", {}, rows)]);

  host.appendChild(bar);
  host.appendChild(el("div", { class: "cmp-grid" }, table));
}

// ---------- map (schematic equirectangular) ----------------------------------
// bounds cover all town coords: lon [-52,60], lat [-40,64]
const MAP = { W: 1320, H: 660, lonMin: -52, lonMax: 60, latMin: -40, latMax: 64 };
function project(lat, lon) {
  const x = (lon - MAP.lonMin) / (MAP.lonMax - MAP.lonMin) * MAP.W;
  const y = (MAP.latMax - lat) / (MAP.latMax - MAP.latMin) * MAP.H;
  return [x, y];
}
// coarse continent outlines (very approximate, for orientation only)
const LAND = {
  europe: "M300,70 L520,60 L640,120 L700,150 L690,210 L600,250 L560,230 L470,250 L430,300 L360,300 L330,250 L300,210 L280,150 Z",
  africa: "M470,250 L640,250 L700,300 L720,420 L640,560 L560,600 L520,540 L470,470 L440,360 L430,300 Z",
  samerica: "M120,360 L240,340 L300,420 L300,560 L230,660 L160,640 L120,520 L110,430 Z",
};
function renderMap() {
  const host = $("#mapHost");
  host.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${MAP.W} ${MAP.H}`);
  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, at) => { const n = document.createElementNS(ns, tag); for (const k in at) n.setAttribute(k, at[k]); return n; };

  svg.appendChild(mk("rect", { x: 0, y: 0, width: MAP.W, height: MAP.H, fill: "#0c1c28" }));
  // graticule every 15°
  for (let lon = -45; lon <= 60; lon += 15) { const [x] = project(0, lon); svg.appendChild(mk("line", { x1: x, y1: 0, x2: x, y2: MAP.H, stroke: "#16303f", "stroke-width": 1 })); }
  for (let lat = -30; lat <= 60; lat += 15) { const [, y] = project(lat, 0); svg.appendChild(mk("line", { x1: 0, y1: y, x2: MAP.W, y2: y, stroke: "#16303f", "stroke-width": 1 })); }
  // equator emphasis
  const [, eqy] = project(0, 0); svg.appendChild(mk("line", { x1: 0, y1: eqy, x2: MAP.W, y2: eqy, stroke: "#20465b", "stroke-width": 1.5, "stroke-dasharray": "6 6" }));
  Object.values(LAND).forEach(d => svg.appendChild(mk("path", { d, fill: "#12303a", stroke: "#1c4457", "stroke-width": 1 })));

  const list = TOWNS.filter(passes).filter(t => t.coords);
  const tip = ensureTooltip();
  list.forEach(t => {
    const [x, y] = project(t.coords[0], t.coords[1]);
    const r = 4 + (t.score - 3) * 0.9;
    const c = mk("circle", { cx: x, cy: y, r, fill: scoreVar(t.score), "fill-opacity": 0.9, stroke: "#06121a", "stroke-width": 1, class: "map-pin" });
    if (favorites.has(t.id)) { c.setAttribute("stroke", "#ffcf4d"); c.setAttribute("stroke-width", "2.5"); }
    c.addEventListener("mousemove", (e) => {
      tip.style.display = "block"; tip.style.left = (e.clientX + 14) + "px"; tip.style.top = (e.clientY + 14) + "px";
      tip.innerHTML = `<b>${t.town}</b> · ${t.score.toFixed(1)}<br>${t.country} — ${t.water_body}<br>${t.rent_band_cad[0] != null ? fmtCAD(t.rent_band_cad[0]) + "+/mo" : ""} · ${WARM_LABEL[t.warm_now]}`;
    });
    c.addEventListener("mouseleave", () => tip.style.display = "none");
    c.addEventListener("click", () => { view = "grid"; filters.search = t.town; $("#search").value = t.town; render(); });
    svg.appendChild(c);
  });
  host.appendChild(svg);
  $("#mapLegend").innerHTML = "";
  [["≥8.0", "--s-hi"], ["7–8", "--s-good"], ["6–7", "--s-mid"], ["5–6", "--s-low"], ["<5", "--s-bad"]]
    .forEach(([lab, v]) => $("#mapLegend").appendChild(el("span", { class: "lg" }, [
      el("span", { class: "dot", style: "background:var(" + v + ")" }), el("span", { text: lab }),
    ])));
  $("#mapLegend").appendChild(el("span", { class: "lg", html: `<span class="dot" style="background:transparent;border:2px solid var(--star)"></span><span>favorite</span>` }));
  $("#mapLegend").appendChild(el("span", { text: `${list.length} pins` }));
}
function ensureTooltip() {
  let t = $(".map-tooltip");
  if (!t) { t = el("div", { class: "map-tooltip" }); t.style.display = "none"; document.body.appendChild(t); }
  return t;
}

// ---------- lightbox ---------------------------------------------------------
let lbTown = null, lbIdx = 0;
function openLightbox(t, i) { lbTown = t; lbIdx = i; queueLive(t.id); showLb(); $("#lightbox").hidden = false; }
function openVideo(t) {
  const v = videoFor(t);
  const stage = $("#lbStage"); stage.innerHTML = "";
  if (v) stage.appendChild(el("iframe", { src: "https://www.youtube.com/embed/" + v, allow: "accelerometer; encrypted-media; picture-in-picture", allowfullscreen: "" }));
  $("#lbCaption").innerHTML = `${t.town} — representative clip`;
  lbTown = t; lbIdx = -1;
  $("#lightbox").hidden = false;
}
function showLb() {
  const pics = photosFor(lbTown);
  if (lbIdx < 0) lbIdx = 0; if (lbIdx >= pics.length) lbIdx = pics.length - 1;
  const p = pics[lbIdx];
  const stage = $("#lbStage"); stage.innerHTML = "";
  stage.appendChild(el("img", { src: p.full || p.src, alt: lbTown.town }));
  const cap = [];
  cap.push(`<strong>${lbTown.town}</strong> — ${lbIdx + 1}/${pics.length}`);
  if (p.placeholder) cap.push(`generated placeholder — real photos: <a href="${imgSearch(lbTown)}" target="_blank" rel="noopener">Google Images ↗</a> · <a href="${ovSearch(lbTown)}" target="_blank" rel="noopener">Openverse ↗</a> · or run <code>fetch-media</code>`);
  else if (p.credit) cap.push(`${escapeHtml(p.credit)}${p.license ? " · " + escapeHtml(p.license) : ""}${p.source_url ? ` · <a href="${p.source_url}" target="_blank" rel="noopener">source ↗</a>` : ""}${p.live ? " · live via Openverse" : ""}`);
  $("#lbCaption").innerHTML = cap.join(" · ");
}
function lbMove(d) { if (lbIdx < 0) return; lbIdx += d; showLb(); }
function closeLb() { $("#lightbox").hidden = true; $("#lbStage").innerHTML = ""; }

// ---------- toggles ----------------------------------------------------------
function toggleFav(id) {
  favorites.has(id) ? favorites.delete(id) : favorites.add(id);
  saveFavorites();
  // update in place where possible
  render();
}
function toggleCompare(id) {
  if (compareSel.has(id)) compareSel.delete(id);
  else { if (compareSel.size >= 4) { alert("Compare holds up to 4 towns. Remove one first."); return; } compareSel.add(id); }
  render();
}

// ---------- filter UI wiring -------------------------------------------------
function buildFilterUI() {
  const regions = META.regions || ["Eastern Europe", "Africa", "Brazil"];
  const rc = $("#regionFilters");
  regions.forEach(r => {
    const n = TOWNS.filter(t => t.region === r).length;
    rc.appendChild(el("label", {}, [
      el("input", { type: "checkbox", value: r, onchange: e => { e.target.checked ? filters.regions.add(r) : filters.regions.delete(r); render(); } }),
      el("span", { html: `${r} <span class="hint-inline">(${n})</span>` }),
    ]));
  });
  const tiers = [...new Set(TOWNS.map(t => t.cost_tier).filter(Boolean))].sort((a, b) => a.length - b.length);
  const tc = $("#tierFilters");
  tiers.forEach(tier => tc.appendChild(el("label", {}, [
    el("input", { type: "checkbox", value: tier, onchange: e => { e.target.checked ? filters.tiers.add(tier) : filters.tiers.delete(tier); render(); } }),
    el("span", { text: tier }),
  ])));

  $("#budget").addEventListener("input", e => {
    filters.budget = +e.target.value;
    $("#budgetOut").textContent = budgetLabel();
    render();
  });
  $("#budgetOut").textContent = budgetLabel();
  $("#warmFilter").addEventListener("change", e => { filters.warm = e.target.value; render(); });
  $("#tzFilter").addEventListener("change", e => { filters.tz = e.target.checked; render(); });
  $("#safetyFilter").addEventListener("change", e => { filters.safety = e.target.checked; render(); });
  $("#search").addEventListener("input", e => { filters.search = e.target.value.trim(); render(); });
  $("#sort").addEventListener("change", e => { sort = e.target.value; render(); });
  $("#favBtn").addEventListener("click", () => { filters.favOnly = !filters.favOnly; render(); });
  const syncLiveBtn = () => { $("#liveBtn").classList.toggle("active", LIVE); $("#liveBtn").textContent = LIVE ? "📷 Live ✓" : "📷 Live"; };
  $("#liveBtn").addEventListener("click", () => {
    LIVE = !LIVE;
    try { localStorage.setItem("waterline_live", LIVE ? "1" : "0"); } catch (e) {}
    if (LIVE) liveTried.clear();
    syncLiveBtn(); render();
  });
  syncLiveBtn();

  $$(".tab").forEach(b => b.addEventListener("click", () => { view = b.dataset.view; render(); }));
  $("#resetFilters").addEventListener("click", resetFilters);
  $("#clearFromEmpty").addEventListener("click", resetFilters);

  // mobile filter drawer
  const backdrop = el("div", { class: "filter-backdrop" });
  document.body.appendChild(backdrop);
  const closeDrawer = () => { $("#filters").classList.remove("open"); backdrop.classList.remove("show"); document.body.classList.remove("filters-open"); };
  $("#filterToggle").addEventListener("click", () => { $("#filters").classList.add("open"); backdrop.classList.add("show"); document.body.classList.add("filters-open"); });
  backdrop.addEventListener("click", closeDrawer);

  // lightbox controls
  $("#lbClose").addEventListener("click", closeLb);
  $("#lbPrev").addEventListener("click", () => lbMove(-1));
  $("#lbNext").addEventListener("click", () => lbMove(1));
  $("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") closeLb(); });
  document.addEventListener("keydown", e => {
    if ($("#lightbox").hidden) return;
    if (e.key === "Escape") closeLb();
    if (e.key === "ArrowLeft") lbMove(-1);
    if (e.key === "ArrowRight") lbMove(1);
  });
}
function resetFilters() {
  filters.regions.clear(); filters.tiers.clear();
  filters.warm = "any"; filters.budget = BUDGET_MAX; filters.tz = false;
  filters.safety = false; filters.favOnly = false; filters.search = "";
  $$("#regionFilters input,#tierFilters input").forEach(i => i.checked = false);
  $("#warmFilter").value = "any"; $("#tzFilter").checked = false; $("#safetyFilter").checked = false;
  $("#search").value = ""; $("#budget").value = BUDGET_MAX; $("#budgetOut").textContent = budgetLabel();
  render();
}

// ---------- favorites export / share (added to header) -----------------------
function buildFavTools() {
  const bar = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" }, [
    el("button", { class: "link-btn", text: "Copy shareable link", onclick: copyShare }),
    el("button", { class: "link-btn", text: "Download shortlist JSON", onclick: downloadFavs }),
  ]);
  $("#mediaNotice").after(bar);
}
async function copyShare() {
  saveFavorites();
  const url = location.href;
  try { await navigator.clipboard.writeText(url); toast("Link copied — favorites travel in the ?fav= param."); }
  catch (e) { prompt("Copy this link:", url); }
}
function downloadFavs() {
  const ids = filters.favOnly || favorites.size ? [...favorites] : [];
  const picks = TOWNS.filter(t => favorites.has(t.id));
  const blob = new Blob([JSON.stringify({ generated: "waterline-scout", count: picks.length, towns: picks }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "waterline-shortlist.json" });
  document.body.appendChild(a); a.click(); a.remove();
}
function toast(msg) {
  const t = el("div", { text: msg, style: "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#0f2733;border:1px solid #2c4b63;color:#eaf2f7;padding:10px 16px;border-radius:10px;z-index:200;box-shadow:0 6px 24px rgba(0,0,0,.4)" });
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

// ---------- header stats -----------------------------------------------------
function buildHeader() {
  const warm = TOWNS.filter(t => t.warm_now === "yes").length;
  const underBudget = TOWNS.filter(t => t.rent_band_cad[0] != null && t.rent_band_cad[0] <= 1300).length;
  const noRisk = TOWNS.filter(t => !t.has_risk).length;
  const stats = [["120", "towns"], [warm, "warm now"], [underBudget, "≤ C$1.3k"], [noRisk, "no risk flag"]];
  $("#headerStats").innerHTML = "";
  stats.forEach(([b, s]) => $("#headerStats").appendChild(el("div", { class: "stat" }, [el("b", { text: b }), el("span", { text: s })])));
  $("#mediaNotice").textContent = META.media_status || "";
  $("#fxFooter").textContent = META.fx_note ? "Currency: " + META.fx_note + " · budget target C$1,000/mo, ceiling C$1,300/mo." : "";
}

// ---------- boot -------------------------------------------------------------
loadData().then(({ data, media }) => {
  if (!data) { document.body.innerHTML = "<p style='padding:40px'>Could not load data.json. Serve the folder or open with data.js present.</p>"; return; }
  TOWNS = data.towns; META = data.meta || {}; MEDIA = media;
  loadFavorites();
  loadLiveState();
  buildHeader();
  buildFilterUI();
  buildFavTools();
  render();
});
})();
