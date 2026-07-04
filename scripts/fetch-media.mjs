#!/usr/bin/env node
/**
 * Waterline Scout — media fetcher.
 *
 * Pulls 4–8 free-licensed photos (and, with a key, one representative YouTube
 * video id) per town, saves them under images/<id>/, records attribution, and
 * updates images/media-manifest.json + media.js so the site swaps placeholders
 * for real photos automatically.
 *
 * PROVIDERS (in order; first that returns enough wins per town):
 *   - unsplash   (needs UNSPLASH_ACCESS_KEY)   — high quality, attribution required
 *   - pexels     (needs PEXELS_API_KEY)        — high quality, attribution required
 *   - openverse  (no key)                      — CC-licensed aggregator  [default]
 *   - wikimedia  (no key)                      — Wikimedia Commons        [default]
 * By default only the two keyless providers run. If you export a key, that
 * provider is automatically added to the FRONT of the chain. Override the whole
 * order with --providers=unsplash,openverse.
 *
 * YouTube: set YOUTUBE_API_KEY to resolve one video id per town. Without it the
 * site falls back to a "Video ↗" link that opens a YouTube search.
 *
 * This script does NOT hotlink or scrape stock sites — it downloads only from
 * the licensed APIs above and keeps a credits list.
 *
 * USAGE
 *   node scripts/fetch-media.mjs                 # all 120, keyless providers
 *   node scripts/fetch-media.mjs --per-region=15 # top 15 by score per region first
 *   node scripts/fetch-media.mjs --limit=20      # only the 20 highest-scored towns
 *   node scripts/fetch-media.mjs --region="Africa" --min-photos=6
 *   node scripts/fetch-media.mjs --force         # refetch even if photos exist
 *   node scripts/fetch-media.mjs --dry-run       # show the plan, fetch nothing
 *   UNSPLASH_ACCESS_KEY=xxx node scripts/fetch-media.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES = path.join(ROOT, "images");

// ---------- args -------------------------------------------------------------
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const MIN_PHOTOS = +(args["min-photos"] || 4);
const MAX_PHOTOS = +(args["max-photos"] || 8);
const PER_REGION = args["per-region"] ? +args["per-region"] : null;
const LIMIT = args["limit"] ? +args["limit"] : null;
const ONLY_REGION = args["region"] || null;
const FORCE = !!args["force"];
const DRY = !!args["dry-run"];
const CONCURRENCY = +(args["concurrency"] || 3);
const DELAY_MS = +(args["delay"] || 400);

// ---------- providers --------------------------------------------------------
const KEYS = {
  unsplash: process.env.UNSPLASH_ACCESS_KEY,
  pexels: process.env.PEXELS_API_KEY,
  youtube: process.env.YOUTUBE_API_KEY,
  googleKey: process.env.GOOGLE_CSE_KEY,   // Custom Search JSON API key
  googleCx: process.env.GOOGLE_CSE_ID,     // Programmable Search Engine id (cx)
};
// usage-rights filter for Google CSE (CC only by default; override via env)
const GOOGLE_RIGHTS = process.env.GOOGLE_CSE_RIGHTS ||
  "cc_publicdomain|cc_attribute|cc_sharealike|cc_noncommercial";
let providerOrder;
if (args["providers"]) providerOrder = String(args["providers"]).split(",").map(s => s.trim());
else {
  providerOrder = ["openverse", "wikimedia"];
  if (KEYS.googleKey && KEYS.googleCx) providerOrder.unshift("google");
  if (KEYS.pexels) providerOrder.unshift("pexels");
  if (KEYS.unsplash) providerOrder.unshift("unsplash");
}

const UA = { "User-Agent": "WaterlineScout/1.0 (personal research tool)" };

async function jget(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// each provider returns [{url, credit, license, source_url, provider}]
const PROVIDERS = {
  async unsplash(q) {
    if (!KEYS.unsplash) return [];
    const d = await jget(`https://api.unsplash.com/search/photos?per_page=${MAX_PHOTOS}&orientation=landscape&query=${encodeURIComponent(q)}`,
      { Authorization: `Client-ID ${KEYS.unsplash}` });
    return (d.results || []).map(p => ({
      url: p.urls.regular,
      credit: `Photo by ${p.user.name} on Unsplash`,
      license: "Unsplash License",
      source_url: p.links.html,
      provider: "unsplash",
      // Unsplash guideline: ping download endpoint (best-effort)
      _download: p.links.download_location,
    }));
  },
  async pexels(q) {
    if (!KEYS.pexels) return [];
    const d = await jget(`https://api.pexels.com/v1/search?per_page=${MAX_PHOTOS}&orientation=landscape&query=${encodeURIComponent(q)}`,
      { Authorization: KEYS.pexels });
    return (d.photos || []).map(p => ({
      url: p.src.large2x || p.src.large,
      credit: `Photo by ${p.photographer} on Pexels`,
      license: "Pexels License",
      source_url: p.url,
      provider: "pexels",
    }));
  },
  async google(q) {
    if (!KEYS.googleKey || !KEYS.googleCx) return [];
    const num = Math.min(10, MAX_PHOTOS); // API max 10/request
    const d = await jget("https://www.googleapis.com/customsearch/v1?" +
      `key=${KEYS.googleKey}&cx=${KEYS.googleCx}&searchType=image&num=${num}` +
      `&safe=active&imgSize=large&rights=${encodeURIComponent(GOOGLE_RIGHTS)}` +
      `&q=${encodeURIComponent(q)}`);
    return (d.items || []).map(it => ({
      url: it.link,
      credit: `${it.title || "Image"}${it.displayLink ? " — " + it.displayLink : ""}`,
      // CSE returns the rights *filter*, not the exact license; the source
      // page carries the real license — recorded so it can be verified.
      license: `CC (Google rights=${GOOGLE_RIGHTS})`,
      source_url: it.image?.contextLink || it.link,
      provider: "google-cse",
    }));
  },
  async openverse(q) {
    const d = await jget(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${MAX_PHOTOS}&license_type=all&mature=false`);
    return (d.results || []).map(p => ({
      url: p.url,
      credit: p.attribution || `${p.title || "Untitled"}${p.creator ? " — " + p.creator : ""}`,
      license: `${(p.license || "").toUpperCase()} ${p.license_version || ""}`.trim(),
      source_url: p.foreign_landing_url || p.url,
      provider: `openverse/${p.source || "?"}`,
    }));
  },
  async wikimedia(q) {
    const d = await jget(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=${MAX_PHOTOS}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1280&format=json&origin=*`);
    const pages = d.query?.pages || {};
    return Object.values(pages).map(pg => {
      const ii = (pg.imageinfo || [])[0]; if (!ii) return null;
      const em = ii.extmetadata || {};
      const strip = s => (s || "").replace(/<[^>]+>/g, "").trim();
      return {
        url: ii.thumburl || ii.url,
        credit: strip(em.Artist?.value) || pg.title,
        license: strip(em.LicenseShortName?.value) || "see source",
        source_url: ii.descriptionurl || ii.url,
        provider: "wikimedia",
      };
    }).filter(Boolean);
  },
};

function extFromType(ct) {
  if (/jpe?g/i.test(ct)) return "jpg";
  if (/png/i.test(ct)) return "png";
  if (/webp/i.test(ct)) return "webp";
  if (/gif/i.test(ct)) return "gif";
  return null;
}
function extFromUrl(u) { const m = u.match(/\.(jpe?g|png|webp)(\?|$)/i); return m ? m[1].toLowerCase().replace("jpeg", "jpg") : null; }

// download to a path WITHOUT extension; returns the extension actually written
// (decided from the response content-type, falling back to the URL). Rejects
// anything that isn't really an image (e.g. an HTML error/consent page).
async function download(url, destNoExt) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (!/^image\//i.test(ct)) throw new Error(`not an image (${ct || "no content-type"})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2500) throw new Error("suspiciously small file");
  const ext = extFromType(ct) || extFromUrl(url) || "jpg";
  await fs.writeFile(`${destNoExt}.${ext}`, buf);
  return ext;
}

async function resolveVideo(q) {
  if (!KEYS.youtube) return null;
  try {
    const d = await jget(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&videoEmbeddable=true&q=${encodeURIComponent(q)}&key=${KEYS.youtube}`);
    return d.items?.[0]?.id?.videoId || null;
  } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchTown(town, manifest) {
  const id = town.id;
  const dir = path.join(IMAGES, id);
  const entry = manifest[id] || (manifest[id] = { placeholders: [], photos: [], video: null, credits: [] });
  if (!FORCE && (entry.photos?.length || 0) >= MIN_PHOTOS) {
    return { id, status: "skip (has photos)" };
  }
  const query = town.media_query || `${town.town} ${town.country} beach aerial drone`;
  let candidates = [];
  for (const prov of providerOrder) {
    if (!PROVIDERS[prov]) continue;
    try {
      const got = await PROVIDERS[prov](query);
      candidates.push(...got.filter(c => c.url && /^https?:/i.test(c.url)));
    } catch (e) { /* provider miss — try next */ }
    if (candidates.length >= MIN_PHOTOS) break;
  }
  if (!candidates.length) return { id, status: "no results" };

  await fs.mkdir(dir, { recursive: true });
  const photos = [], credits = [];
  let n = 0;
  for (const c of candidates) {
    if (n >= MAX_PHOTOS) break;
    const base = path.join(dir, `photo-${n + 1}`);
    try {
      const ext = await download(c.url, base); // content-type decides the ext
      if (c._download && KEYS.unsplash) fetch(`${c._download}&client_id=${KEYS.unsplash}`, { headers: UA }).catch(() => {});
      const rec = { src: `images/${id}/photo-${n + 1}.${ext}`, credit: c.credit, license: c.license, source_url: c.source_url, provider: c.provider };
      photos.push(rec); credits.push(rec); n++;
      await sleep(DELAY_MS);
    } catch (e) { /* skip this image */ }
  }
  if (!photos.length) return { id, status: "download failed" };
  entry.photos = photos;
  entry.credits = credits;
  entry.video = await resolveVideo(query);
  await fs.writeFile(path.join(dir, "credits.json"), JSON.stringify(credits, null, 2));
  return { id, status: `${photos.length} photos${entry.video ? " + video" : ""}` };
}

function orderTowns(towns) {
  let list = towns.slice();
  if (ONLY_REGION) list = list.filter(t => t.region === ONLY_REGION);
  const rlo = { "Eastern Europe": 0, "Africa": 1, "Brazil": 2 };
  if (PER_REGION) {
    // top-N per region first (by score), then the remainder
    const head = [], tail = [];
    const byRegion = {};
    list.sort((a, b) => (rlo[a.region] - rlo[b.region]) || b.score - a.score);
    for (const t of list) {
      byRegion[t.region] = (byRegion[t.region] || 0) + 1;
      (byRegion[t.region] <= PER_REGION ? head : tail).push(t);
    }
    list = head.concat(tail);
  } else {
    list.sort((a, b) => b.score - a.score);
  }
  if (LIMIT) list = list.slice(0, LIMIT);
  return list;
}

async function main() {
  const data = JSON.parse(await fs.readFile(path.join(ROOT, "data.json"), "utf8"));
  const manifestPath = path.join(IMAGES, "media-manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {}

  const list = orderTowns(data.towns);
  console.log(`Providers: ${providerOrder.join(" → ")}${KEYS.youtube ? " (+youtube)" : ""}`);
  console.log(`Plan: ${list.length} towns, ${MIN_PHOTOS}-${MAX_PHOTOS} photos each${DRY ? "  [DRY RUN]" : ""}`);
  if (DRY) {
    list.slice(0, 20).forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t.town} (${t.region}, ${t.score})  q="${t.media_query}"`));
    if (list.length > 20) console.log(`  … and ${list.length - 20} more`);
    console.log("Dry run — no network calls made.");
    return;
  }

  // simple concurrency pool
  let idx = 0, done = 0;
  async function worker() {
    while (idx < list.length) {
      const t = list[idx++];
      try {
        const r = await fetchTown(t, manifest);
        console.log(`[${String(++done).padStart(3)}/${list.length}] ${t.town}: ${r.status}`);
      } catch (e) {
        console.log(`[${String(++done).padStart(3)}/${list.length}] ${t.town}: ERROR ${e.message}`);
      }
      // persist progress after each town so rate-limits don't lose work
      await writeManifest(manifestPath, manifest);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));

  await writeManifest(manifestPath, manifest);
  await writeCredits(manifest, data.towns);
  const withPhotos = Object.values(manifest).filter(m => (m.photos || []).length).length;
  console.log(`\nDone. ${withPhotos}/${data.towns.length} towns now have real photos.`);
  console.log("Reload index.html to see them (placeholders remain as fallback).");
}

async function writeManifest(manifestPath, manifest) {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(ROOT, "media.js"),
    "// Auto-generated media manifest (placeholders + fetched photos/video).\n" +
    "// Regenerated by scripts/gen_placeholders.py and scripts/fetch-media.mjs.\n" +
    "window.WATERLINE_MEDIA = " + JSON.stringify(manifest) + ";\n");
}

async function writeCredits(manifest, towns) {
  const nameById = Object.fromEntries(towns.map(t => [t.id, t.town]));
  const all = [];
  for (const [id, m] of Object.entries(manifest)) {
    for (const c of (m.credits || [])) all.push({ town: nameById[id] || id, ...c });
  }
  await fs.mkdir(path.join(ROOT, "credits"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "credits", "attribution.json"), JSON.stringify(all, null, 2));
  const lines = ["# Photo attribution", "",
    "Auto-generated by scripts/fetch-media.mjs. One entry per downloaded photo.", ""];
  let cur = "";
  for (const c of all) {
    if (c.town !== cur) { cur = c.town; lines.push(`\n## ${cur}`); }
    lines.push(`- ${c.credit || "Unknown"} — ${c.license || "see source"} — <${c.source_url || ""}> (${c.provider})`);
  }
  await fs.writeFile(path.join(ROOT, "credits", "attribution.md"), lines.join("\n") + "\n");
  console.log(`Wrote credits/attribution.json + attribution.md (${all.length} photos).`);
}

main().catch(e => { console.error(e); process.exit(1); });
