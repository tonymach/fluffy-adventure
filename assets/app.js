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
  // Clean query: the media_query seed ("…beach aerial drone 4k") is tuned for
  // YouTube/Google and returns nothing on Openverse's CC corpus.
  const baseTown = t.town.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
  const loc = t.region === "Brazil" ? "Brazil" : t.country;
  const q = `${baseTown} ${loc}`.trim();
  try {
    const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=8`,
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
// ---- recognizable coastline outlines, authored in [lat, lon] and projected --
// Simplified but geographically faithful enough that pins land on/near real
// coasts. Only the regions that actually hold towns are detailed.
const COAST = {
  africa: [
    [35.9,-5.4],[35.7,-2.9],[37.0,3.0],[37.3,9.9],[33.9,10.9],[32.1,15.0],
    [30.4,19.2],[31.2,27.0],[31.4,30.0],[31.2,32.3],[30.0,32.6],[27.3,33.8],
    [25.0,35.0],[22.0,36.8],[18.0,38.5],[15.0,40.0],[12.5,43.3],[11.5,45.0],
    [11.8,51.0],[2.0,45.5],[-4.0,39.6],[-6.9,39.5],[-10.5,40.5],[-16.0,40.0],
    [-20.0,34.9],[-26.0,32.9],[-29.0,31.5],[-33.0,27.9],[-34.0,25.6],
    [-34.8,22.0],[-34.5,20.0],[-34.4,18.4],[-31.0,17.5],[-29.0,16.5],
    [-26.6,15.1],[-22.7,14.5],[-17.9,11.8],[-12.5,13.4],[-8.8,13.2],
    [-6.0,12.3],[-1.0,8.9],[1.9,9.6],[3.9,9.0],[4.3,6.0],[6.4,3.4],
    [5.8,0.5],[4.9,-3.0],[4.4,-7.5],[6.3,-10.8],[8.5,-13.3],[11.3,-15.9],
    [13.5,-16.8],[14.7,-17.5],[16.0,-16.5],[20.8,-17.0],[23.7,-16.0],
    [27.7,-13.2],[30.4,-9.7],[33.3,-8.6],[35.2,-6.1],
  ],
  sinai: [[30.1,32.4],[29.9,34.9],[27.9,34.0]],
  samerica: [
    [4.0,-51.5],[0.0,-50.0],[-2.5,-44.0],[-3.7,-38.5],[-5.0,-35.5],
    [-8.0,-34.8],[-10.5,-36.2],[-13.0,-38.5],[-15.5,-39.0],[-18.5,-39.7],
    [-20.3,-40.3],[-22.9,-42.0],[-23.0,-43.2],[-23.4,-45.0],[-25.5,-48.5],
    [-27.6,-48.5],[-28.5,-48.8],[-30.0,-50.5],[-33.0,-52.0],[-38.0,-60.0],
    [-10.0,-66.0],[3.0,-58.0],[4.0,-51.5],
  ],
  // Eurasia outer ring: Med north shore -> Anatolia/Caucasus -> east edge ->
  // top -> Scandinavia -> Iberia. Black Sea + Baltic are cut as holes below.
  eurasia: [
    [36.1,-5.3],[36.7,-4.4],[36.8,-2.5],[37.6,-1.0],[39.5,-0.3],[41.4,2.2],[42.3,3.2],
    [43.0,3.1],[43.3,5.4],[43.7,7.3],[44.4,8.9],[43.5,10.3],[41.8,12.4],[40.8,14.2],
    [38.0,15.7],[40.0,16.5],[40.0,18.4],
    [42.0,14.5],[45.4,12.4],[45.7,13.7],
    [45.0,14.4],[44.1,15.2],[43.5,16.4],[42.6,18.1],[42.3,18.8],[41.0,19.4],[40.0,19.4],
    [39.0,20.3],[36.7,21.7],[36.4,22.5],[36.4,23.2],[37.9,23.7],
    [40.6,22.9],[40.8,24.9],[39.5,26.5],[38.4,27.0],[37.0,27.4],
    [36.6,30.5],[36.2,33.3],[36.6,34.5],[36.6,36.0],
    [37.2,38.5],[38.0,42.0],[39.5,46.0],[42.0,48.0],[45.0,50.0],[47.0,55.0],[48.0,60.0],
    [55.0,60.0],[60.0,60.0],[64.0,60.0],
    [64.0,50.0],[64.0,40.0],[64.0,30.0],[64.0,15.0],[64.0,11.0],
    [63.5,9.5],[62.5,6.0],[60.4,5.2],[59.0,5.7],[58.1,6.6],[57.7,10.6],
    [57.0,8.1],[53.6,7.0],[52.5,4.4],[51.0,2.5],[49.5,-1.5],[48.6,-4.7],[46.5,-1.5],
    [43.4,-1.8],[43.5,-6.0],[43.0,-9.2],[39.4,-9.4],[37.0,-8.9],
  ],
  blacksea: [
    [42.5,27.5],[43.2,27.9],[44.2,28.6],[46.5,30.7],[45.3,33.5],[45.3,36.5],
    [44.6,37.8],[43.4,39.9],[41.7,41.7],[41.0,39.7],[41.3,36.3],[42.0,35.2],
    [41.5,31.5],[41.2,29.0],[42.0,28.0],
  ],
  baltic: [
    [54.5,10.0],[54.2,12.0],[54.2,14.0],[54.2,15.6],[54.4,18.6],[54.9,20.0],
    [55.7,21.1],[56.5,21.0],[57.0,24.0],[58.4,24.5],[58.6,23.0],[59.4,24.7],
    [60.2,25.0],[60.4,28.0],[61.5,21.5],[63.5,21.5],[63.5,19.0],[60.5,17.5],
    [59.3,18.6],[57.0,16.5],[55.4,13.0],[55.0,12.5],
  ],
};
// standalone islands (some hold towns)
const ISLANDS = [
  [[50.1,-5.6],[51.6,-4.5],[53.4,-4.8],[54.8,-5.0],[58.6,-5.0],[57.5,-2.0],[56.0,-2.5],[55.0,-1.4],[52.9,1.7],[51.4,1.4],[50.6,-1.5],[50.1,-3.5]], // Great Britain
  [[51.5,-10.2],[53.1,-10.3],[54.5,-8.5],[55.3,-7.2],[54.3,-5.9],[52.2,-6.2],[51.6,-9.5]], // Ireland
  [[43.0,9.4],[42.5,9.6],[41.4,9.6],[39.2,9.6],[38.9,8.9],[39.9,8.4],[41.2,8.4],[42.6,8.7]], // Corsica+Sardinia
  [[38.3,15.3],[37.1,15.3],[36.7,14.5],[37.6,12.4],[38.2,13.4]], // Sicily
  [[35.6,23.6],[35.3,24.7],[35.4,26.3],[35.0,25.7],[34.9,24.0]], // Crete
  [[35.7,32.3],[35.4,34.6],[34.9,34.0],[34.6,32.9]], // Cyprus
  [[-12.0,49.3],[-15.5,50.4],[-25.5,47.0],[-25.0,44.0],[-16.0,43.5],[-12.3,48.5]], // Madagascar
  [[-5.6,39.2],[-5.9,39.5],[-6.4,39.5],[-6.3,39.1]], // Zanzibar
  [[16.35,-23.15],[16.85,-22.65],[16.15,-22.55],[16.05,-23.05]], // Cape Verde (Sal/Boa Vista)
  [[16.75,-25.15],[17.05,-24.8],[16.75,-24.75]], // Cape Verde (Sao Vicente)
  [[15.05,-23.6],[15.35,-23.5],[15.0,-23.35]], // Cape Verde (Santiago)
  [[-19.95,57.35],[-19.95,57.67],[-20.55,57.62],[-20.55,57.38]], // Mauritius
  [[-3.8,-32.5],[-3.8,-32.34],[-3.92,-32.34],[-3.92,-32.5]], // Fernando de Noronha
];
// build an SVG path string from a [lat,lon] ring
function coastPath(ring) {
  return ring.map((p, i) => (i ? "L" : "M") + project(p[0], p[1]).map(n => n.toFixed(1)).join(" ")).join("") + "Z";
}
function renderMap() {
  const host = $("#mapHost");
  host.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${MAP.W} ${MAP.H}`);
  const mk = (tag, at) => { const n = document.createElementNS(ns, tag); for (const k in at) n.setAttribute(k, at[k]); return n; };
  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // --- defs: ocean + land gradients, coast blur, pin glow ---
  const defs = mk("defs", {});
  const grad = (id, stops, attrs = {}) => {
    const g = mk("linearGradient", Object.assign({ id, x1: 0, y1: 0, x2: 0, y2: 1 }, attrs));
    stops.forEach(([o, c]) => g.appendChild(mk("stop", { offset: o, "stop-color": c })));
    defs.appendChild(g);
  };
  grad("oceanGrad", [["0", "#0a1a26"], ["0.55", "#0b2130"], ["1", "#0e2a3b"]]);
  grad("landGrad", [["0", "#1a3846"], ["1", "#122e3b"]]);
  const glow = mk("filter", { id: "pinGlow", x: "-60%", y: "-60%", width: "220%", height: "220%" });
  glow.appendChild(mk("feGaussianBlur", { stdDeviation: "2.6" }));
  defs.appendChild(glow);
  svg.appendChild(defs);

  // --- ocean ---
  svg.appendChild(mk("rect", { x: 0, y: 0, width: MAP.W, height: MAP.H, fill: "url(#oceanGrad)" }));

  // --- graticule every 15° ---
  const grat = mk("g", { stroke: "#173243", "stroke-width": 1, opacity: 0.6 });
  for (let lon = -45; lon <= 60; lon += 15) { const [x] = project(0, lon); grat.appendChild(mk("line", { x1: x, y1: 0, x2: x, y2: MAP.H })); }
  for (let lat = -30; lat <= 60; lat += 15) { const [, y] = project(lat, 0); grat.appendChild(mk("line", { x1: 0, y1: y, x2: MAP.W, y2: y })); }
  svg.appendChild(grat);
  const [, eqy] = project(0, 0);
  svg.appendChild(mk("line", { x1: 0, y1: eqy, x2: MAP.W, y2: eqy, stroke: "#2a5066", "stroke-width": 1.4, "stroke-dasharray": "7 8", opacity: 0.8 }));
  // graticule labels
  const labels = mk("g", { fill: "#4f7286", "font-size": "12", "font-family": "system-ui, sans-serif" });
  for (let lat = -30; lat <= 60; lat += 30) { const [, y] = project(lat, 0); labels.appendChild(mk("text", { x: 6, y: y - 4, opacity: 0.8 })).textContent = (lat > 0 ? lat + "°N" : lat < 0 ? -lat + "°S" : "0°"); }
  svg.appendChild(labels);

  // --- land ---
  const landStroke = "#356279";
  const landStyle = { fill: "url(#landGrad)", stroke: landStroke, "stroke-width": 1.2, "stroke-linejoin": "round" };
  // Eurasia with Black Sea + Baltic cut out as holes (even-odd)
  svg.appendChild(mk("path", Object.assign({
    d: coastPath(COAST.eurasia) + coastPath(COAST.blacksea) + coastPath(COAST.baltic),
    "fill-rule": "evenodd",
  }, landStyle)));
  [COAST.africa, COAST.sinai, COAST.samerica].forEach(r => svg.appendChild(mk("path", Object.assign({ d: coastPath(r) }, landStyle))));
  ISLANDS.forEach(r => svg.appendChild(mk("path", Object.assign({ d: coastPath(r) }, landStyle))));

  const list = TOWNS.filter(passes).filter(t => t.coords);
  const tip = ensureTooltip();
  const pinR = t => 4.5 + (t.score - 3) * 0.95;

  // soft color glow layer (blurred copies of each pin)
  const glowG = mk("g", { filter: "url(#pinGlow)", opacity: 0.5 });
  list.forEach(t => {
    const [x, y] = project(t.coords[0], t.coords[1]);
    glowG.appendChild(mk("circle", { cx: x, cy: y, r: pinR(t) + 1.5, fill: scoreVar(t.score) }));
  });
  svg.appendChild(glowG);

  // crisp interactive pins
  const pinsG = mk("g", {});
  list.forEach(t => {
    const [x, y] = project(t.coords[0], t.coords[1]);
    const r = pinR(t);
    if (favorites.has(t.id)) {
      pinsG.appendChild(mk("circle", { cx: x, cy: y, r: r + 3, fill: "none", stroke: cv("--star"), "stroke-width": 2, "stroke-opacity": 0.95 }));
    }
    const c = mk("circle", { cx: x, cy: y, r, fill: scoreVar(t.score), stroke: "#08151d", "stroke-width": 1.2, class: "map-pin" });
    c.addEventListener("mousemove", (e) => {
      tip.style.display = "block"; tip.style.left = (e.clientX + 14) + "px"; tip.style.top = (e.clientY + 14) + "px";
      tip.innerHTML = `<b>${t.town}</b> · ${t.score.toFixed(1)}<br>${t.country} — ${t.water_body}<br>${t.rent_band_cad[0] != null ? fmtCAD(t.rent_band_cad[0]) + "+/mo" : ""} · ${WARM_LABEL[t.warm_now]}`;
    });
    c.addEventListener("mouseleave", () => tip.style.display = "none");
    c.addEventListener("click", () => { view = "grid"; filters.search = t.town; $("#search").value = t.town; render(); });
    pinsG.appendChild(c);
  });
  svg.appendChild(pinsG);
  host.appendChild(svg);

  $("#mapLegend").innerHTML = "";
  [["≥8.0", "--s-hi"], ["7–8", "--s-good"], ["6–7", "--s-mid"], ["5–6", "--s-low"], ["<5", "--s-bad"]]
    .forEach(([lab, v]) => $("#mapLegend").appendChild(el("span", { class: "lg" }, [
      el("span", { class: "dot", style: "background:var(" + v + ")" }), el("span", { text: lab }),
    ])));
  $("#mapLegend").appendChild(el("span", { class: "lg", html: `<span class="dot fav"></span><span>favorite</span>` }));
  $("#mapLegend").appendChild(el("span", { class: "lg hint", html: `<span class="dot sm"></span><span class="dot lg2"></span><span>dot size = score</span>` }));
  $("#mapLegend").appendChild(el("span", { class: "count", text: `${list.length} pins` }));
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
