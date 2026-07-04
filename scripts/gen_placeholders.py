#!/usr/bin/env python3
"""
Generate lightweight, attractive SVG placeholder "postcards" for every town so
the whole grid renders offline before any real photos are fetched.

For each town we write images/<id>/placeholder-1.svg ... placeholder-3.svg with
three different compositions (horizon, aerial coast, beach bands). They are
clearly generated art — NOT stock photos — and are replaced/augmented by
scripts/fetch-media.mjs when run on a networked machine. A per-town media.json
manifest is written so the site knows what exists.

Palette is keyed by region + water type; a small deterministic hash of the town
name varies the hue/among the abstract shapes so no two look identical.
"""
import json, re, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# region base gradients (top -> bottom sky/water)
REGION_THEME = {
    "Eastern Europe": [("#1e3a5f", "#2e6b8f", "#7fb2c9"), ("#22506e", "#3f86a5")],
    "Africa":         [("#0f4c5c", "#2a9d8f", "#e9c46a"), ("#166b6b", "#3bb2a6")],
    "Brazil":         [("#0a6c74", "#12a6a6", "#8fe3cf"), ("#0d7a86", "#1fb6b0")],
    "SE Asia":        [("#12566b", "#1f9e9e", "#7fe0c8"), ("#0e6b6b", "#2bb39a")],
}
LAKE_TINT = ("#2d6a4f", "#52b788")   # lakes / lagoons skew greener


def slugify(name):
    s = name.lower().replace("ã", "a").replace("é", "e").replace("í", "i").replace("ç", "c")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def h(name, salt=""):
    return int(hashlib.md5((name + salt).encode()).hexdigest(), 16)


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def score_color(score):
    if score >= 8.0: return "#2ecc71"
    if score >= 7.0: return "#8bc34a"
    if score >= 6.0: return "#f1c40f"
    if score >= 5.0: return "#e67e22"
    return "#e74c3c"


def svg_header(w, h_):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h_}" '
            f'viewBox="0 0 {w} {h_}" role="img">')


def base_defs(gid, colors, angle=0):
    stops = "".join(
        f'<stop offset="{int(i/(len(colors)-1)*100)}%" stop-color="{c}"/>'
        for i, c in enumerate(colors))
    return (f'<defs><linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1" '
            f'gradientTransform="rotate({angle} .5 .5)">{stops}</linearGradient>'
            f'<linearGradient id="{gid}s" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0%" stop-color="#ffffff" stop-opacity=".18"/>'
            f'<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>'
            f'</linearGradient></defs>')


def label_block(town, water, wtype, score, w, hh):
    # Placeholders are pure abstract art (no baked text) so the card's own
    # overlay chrome — name, score, badges, thumbnails — reads cleanly, exactly
    # as it will over the real photos fetched later. A faint corner wordmark is
    # the only mark, to signal "generated" if the SVG is viewed on its own.
    return (f'<text x="{w-16}" y="{hh-14}" font-size="11" fill="#ffffff" '
            f'opacity=".28" text-anchor="end" '
            f'font-family="system-ui,sans-serif">waterline placeholder</text>')


def comp_horizon(town, colors, seed, water, wtype, score, w=800, hh=520):
    ang = seed % 12 - 6
    sun_x = 120 + (seed % 5) * 130
    hz = 300 + (seed % 4) * 20
    sky = colors
    s = svg_header(w, hh) + base_defs("g", sky, ang)
    s += f'<rect width="{w}" height="{hh}" fill="url(#g)"/>'
    # sun / moon
    s += f'<circle cx="{sun_x}" cy="{hz-90}" r="46" fill="#ffe9b0" opacity=".85"/>'
    # water reflection band
    s += f'<rect x="0" y="{hz}" width="{w}" height="{hh-hz}" fill="#06222e" opacity=".33"/>'
    # wave lines
    for i in range(5):
        y = hz + 26 + i * 30
        off = (seed >> i) % 40
        s += (f'<path d="M0 {y} Q {200+off} {y-12} 400 {y} T 800 {y}" '
              f'stroke="#ffffff" stroke-opacity="{0.16-i*0.02:.2f}" fill="none" stroke-width="3"/>')
    s += f'<rect width="{w}" height="{hh}" fill="url(#gs)"/>'
    s += label_block(town, water, wtype, score, w, hh) + "</svg>"
    return s


def comp_aerial(town, colors, seed, water, wtype, score, w=800, hh=520):
    s = svg_header(w, hh) + base_defs("g", colors, (seed % 8))
    s += f'<rect width="{w}" height="{hh}" fill="url(#g)"/>'
    # land mass blob (sand) sweeping in from a corner
    corner = seed % 4
    sand = "#e9d8a6"
    if corner == 0:
        d = f"M0 0 Q {260+seed%120} {120} {w} {40+seed%80} L {w} 0 Z"
    elif corner == 1:
        d = f"M{w} 0 Q {520-seed%160} {160} 0 {60+seed%80} L 0 0 Z"
    elif corner == 2:
        d = f"M0 {hh} Q {300+seed%120} {hh-160} {w} {hh-40} L {w} {hh} Z"
    else:
        d = f"M0 {hh-40} Q {360} {hh-200} {w} {hh-90} L {w} {hh} L 0 {hh} Z"
    s += f'<path d="{d}" fill="{sand}" opacity=".9"/>'
    s += f'<path d="{d}" fill="none" stroke="#ffffff" stroke-opacity=".5" stroke-width="4"/>'
    # scattered reef/boat dots
    for i in range(7):
        cx = 60 + (h(town, "a"+str(i)) % (w-120))
        cy = 80 + (h(town, "b"+str(i)) % (hh-200))
        r = 3 + (h(town, "c"+str(i)) % 6)
        s += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" opacity=".22"/>'
    s += f'<rect width="{w}" height="{hh}" fill="url(#gs)"/>'
    s += label_block(town, water, wtype, score, w, hh) + "</svg>"
    return s


def comp_bands(town, colors, seed, water, wtype, score, w=800, hh=520):
    s = svg_header(w, hh) + base_defs("g", colors, 0)
    s += f'<rect width="{w}" height="{hh}" fill="url(#g)"/>'
    # diagonal beach bands: water / foam / sand
    skew = (seed % 60) - 30
    bands = [("#edd7a3", hh-150), ("#ffffff", hh-176), ("#bfe7e0", hh-210)]
    for col, y in bands:
        op = ".9" if col != "#ffffff" else ".55"
        s += (f'<path d="M0 {y} L {w} {y+skew} L {w} {hh} L 0 {hh} Z" '
              f'fill="{col}" opacity="{op}"/>')
    # sun
    s += f'<circle cx="{140+(seed%4)*150}" cy="110" r="40" fill="#fff2c9" opacity=".8"/>'
    s += f'<rect width="{w}" height="{hh}" fill="url(#gs)"/>'
    s += label_block(town, water, wtype, score, w, hh) + "</svg>"
    return s


def main():
    d = json.loads((ROOT / "data.json").read_text())
    towns = d["towns"]
    comps = [comp_horizon, comp_aerial, comp_bands]
    media_manifest = {}
    for t in towns:
        slug, town = t["id"], t["town"]
        region = t["region"]
        wtype = t["type"]
        themes = REGION_THEME[region]
        colors = list(themes[h(town) % len(themes)])
        if "lake" in wtype or "lagoon" in wtype:
            colors = [colors[0], LAKE_TINT[0], LAKE_TINT[1]]
        outdir = ROOT / "images" / slug
        outdir.mkdir(parents=True, exist_ok=True)
        files = []
        for i, comp in enumerate(comps, 1):
            seed = h(town, str(i)) % 9973
            svg = comp(town, colors, seed, t["water_body"], wtype, t["score"])
            fn = outdir / f"placeholder-{i}.svg"
            fn.write_text(svg)
            files.append(f"images/{slug}/placeholder-{i}.svg")
        media_manifest[slug] = {
            "placeholders": files,
            "photos": [],          # populated by fetch-media.mjs
            "video": None,         # populated by fetch-media.mjs
            "credits": [],
        }
    (ROOT / "images" / "media-manifest.json").write_text(
        json.dumps(media_manifest, ensure_ascii=False, indent=2))
    # file://-friendly mirror so index.html works with no server
    (ROOT / "media.js").write_text(
        "// Auto-generated media manifest (placeholders + fetched photos/video).\n"
        "// Regenerated by scripts/gen_placeholders.py and scripts/fetch-media.mjs.\n"
        "window.WATERLINE_MEDIA = " +
        json.dumps(media_manifest, ensure_ascii=False) + ";\n")
    print(f"Generated placeholders for {len(towns)} towns "
          f"({len(towns)*3} SVGs) + images/media-manifest.json + media.js")


if __name__ == "__main__":
    main()
