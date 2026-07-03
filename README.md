# 🌊 Waterline Scout — coastal-base decision tool

A single static website to browse and compare **120 coastal towns** as a base for
a **July–November 2026** holding pattern: warm swimmable water *now*, fast internet
+ an airport, a timezone that works for North-American interview calls, and rent
near **~C$1,000/mo**. Built from an already-scored shortlist — this is a decision
tool, not new research.

Open **`index.html`** directly in a browser. No server, no build step, no network
required.

---

## Quick start

```bash
# just open it
open index.html          # macOS   (or double-click the file)
xdg-open index.html      # Linux
```

Everything the page needs is committed: town data (`data.js`/`data.json`),
the media manifest (`media.js`), and placeholder art under `images/`.

Want to serve it instead (e.g. to share on a LAN)?

```bash
python3 -m http.server 8000    # then visit http://localhost:8000
```

---

## What you can do

- **Gallery grid** of all 120 towns — hero image, gallery thumbnails, video button.
- **Sort** by score, monthly rent (cheapest first), region, or name.
- **Filter** by:
  - region (Eastern Europe / Africa / Brazil)
  - *warm & swimmable now* (Jul–Nov) — “warm only” or “swimmable (incl. cool-ish)”
  - **monthly rent ceiling** slider in CAD (defaults to *No limit*; drag down to
    hide anything over ~C$1,300 — your target is ~C$1,000)
  - cost tier (`$`…`$$$$`)
  - interview-timezone-friendly (≤ +6h vs Toronto)
  - hide risk-flagged towns
  - free-text search
- **Favorites** ⭐ — click the star on any card. Your shortlist is saved to the
  browser **and** encoded in the URL (`?fav=batumi,ohrid,…`). Use **Copy shareable
  link** to send it, or **Download shortlist JSON** to export it.
- **Compare** 2–4 towns side by side — photo strips + a full stat table.
- **Map** — schematic world map with pins colored by score (favorites ringed gold).

Each **city card** shows: hero + gallery + video, region, water body + type, score,
cost tier + monthly rent in **EUR and CAD**, tourism tier + peak months, visa note,
safety flag (if a real risk), warm-now badge, timezone offset vs Toronto, nearest
airport, and a vibe blurb.

---

## Data provenance — what’s source-of-truth vs derived

Pricing, scores, tourism tiers, peak months, visa clocks, and water-body/type come
**straight from the source CSVs** and are never recomputed. Everything the build
*derives* is flagged in `data.json` under each town’s `_derived` block:

| Field | Source |
|---|---|
| score, cost tier, rent band (EUR), hotel band, tourism tier, peak months, visa clock | **source CSV (verbatim)** |
| rent band in **CAD** | derived: `EUR × 1.48` (disclosed constant, see below) |
| water temp | parsed from the source vibe/tri notes; blank if the note gave none |
| **air temp** | *not in the source data* — shown as “verify locally”, never invented |
| warm-now class | derived from source water temp + regional seasonality |
| timezone vs Toronto | computed vs Toronto EDT (UTC-4) for the Sept/Oct window |
| nearest airport | editorial nearest-airport pick (IATA); caveats noted where inferred |
| map coordinates | approximate town centroids, for pin placement only |
| safety risk level | classified from the flag text (real risks vs neutral notes) |

**EUR→CAD rate.** One disclosed constant, `EUR_TO_CAD = 1.48`, set in
`scripts/build_data.py`. Change it there and rerun the build to reprice everything.

**Price basis caveat.** Eastern-Europe and Africa rent bands are **peak-season**
(they overstate a Jul–Nov shoulder stay); Brazil bands are **Sept 2026 shoulder**
(your actual window). Each card/compare row states its basis.

---

## Photos & video

Media is fetched from **free-licensed sources only** — no hotlinking, no scraping
of copyrighted stock:

- **Openverse** and **Wikimedia Commons** — no API key, CC-licensed *(default)*
- **Unsplash** / **Pexels** — used automatically if you supply an API key
- **YouTube** — one representative video id per town if you supply a key; otherwise
  the card’s “Video ↗” button opens a YouTube search using the town’s query seed

### Why placeholders ship in the box

This project was assembled in a sandbox whose network policy **blocks outbound
access to image/media hosts** (Openverse, Wikimedia, Unsplash, Pexels, YouTube all
returned connection failures). So every town ships with **clean generated SVG
placeholder art** (3 per town) and a ready-to-run fetcher. Run it on any machine
with normal internet and real photos drop in automatically — the site prefers real
photos and falls back to placeholders per town.

### Get real photos

```bash
# keyless (Openverse + Wikimedia), all 120 towns:
node scripts/fetch-media.mjs

# prioritize the top 15 per region first (good if you hit rate limits):
node scripts/fetch-media.mjs --per-region=15

# with keys (higher quality; providers auto-prepended when the key is present):
export UNSPLASH_ACCESS_KEY=xxxx      # https://unsplash.com/developers
export PEXELS_API_KEY=xxxx           # https://www.pexels.com/api/
export YOUTUBE_API_KEY=xxxx          # Google Cloud → YouTube Data API v3
node scripts/fetch-media.mjs
```

Useful flags: `--limit=N`, `--region="Africa"`, `--min-photos=6`, `--max-photos=8`,
`--providers=unsplash,openverse`, `--force` (refetch), `--dry-run` (show the plan).

The fetcher writes photos to `images/<id>/`, saves per-town `credits.json`, and
updates `images/media-manifest.json` + `media.js` **and** the aggregate
`credits/attribution.json` / `credits/attribution.md`. It **persists after every
town**, so a rate-limit interruption never loses finished work — just re-run and it
skips towns that already have enough photos.

---

## Rebuilding the data

```bash
python3 scripts/build_data.py        # CSVs  → data.json + data.js
python3 scripts/gen_placeholders.py  # → images/<id>/placeholder-*.svg + media.js
node    scripts/fetch-media.mjs      # → real photos + credits (needs internet)
```

`scripts/build_data.py` re-reads the source files in `data-src/` (copies of the
manifest + three regional CSVs + regional notes), so the pipeline is reproducible.

---

## File layout

```
index.html                 # the app (loads data.js + media.js + assets/)
assets/styles.css          # styling (responsive, dark coastal theme)
assets/app.js              # all UI logic (vanilla JS, no framework)
data.json                  # canonical town data (served mode)
data.js                    # same payload as a window global (file:// mode)
media.js                   # media manifest as a window global (file:// mode)
images/<id>/               # placeholder-*.svg  (+ photo-*.jpg after fetch)
images/media-manifest.json # per-town placeholders / photos / video / credits
credits/                   # attribution.json + attribution.md (after fetch)
data-src/                  # source CSVs + regional notes (build inputs)
scripts/
  build_data.py            # join + enrich → data.json/data.js
  gen_placeholders.py      # generate placeholder art + media manifest
  fetch-media.mjs          # pull real licensed photos + video
```

---

## Notes & honesty flags

- **Air temperatures** were not in the source data; the tool says so rather than
  guessing. Water temps come from the source notes (blank where the note omitted one).
- **European/African rent bands are peak-season** and overstate a Jul–Nov shoulder
  stay; treat them as ceilings, not what you’d actually pay in October.
- **Airport picks and map coordinates** are editorial/approximate and flagged as such.
- **Timezone friendliness** uses ≤ +6h vs Toronto (EDT) as the cutoff; the raw offset
  is shown on every card so you can judge borderline cases (Baltics/Georgia at +7/+8).
- Verify **visa thresholds and current water/weather** close to travel — the regional
  notes (`data-src/regional-notes.md`) flag several that drift.
```
