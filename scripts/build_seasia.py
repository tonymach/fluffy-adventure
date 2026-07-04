#!/usr/bin/env python3
"""
Waterline Scout — SE Asia scan (July 2026).

Takes the four research JSON batches (Indonesia, Thailand, Vietnam+Cambodia,
Philippines+Malaysia) gathered via web search — pricing/visa/season/safety facts
with sources — and does the SCOUT SYNTHESIS: assigns a consistent tourism tier,
scores each town against the user's rubric, converts USD rents to EUR for the
shared schema, and writes:

  - data-src/southeastasia.csv   (regional detail file, Brazil-like schema)
  - refreshes the "SE Asia" rows in data-src/manifest.csv (the spine)

Scoring rubric (documented, applied uniformly):
  base 3.6
  + warm-now Jul-Nov:  yes +2.0 | partial +1.0 | no +0.1        (the core criterion)
  + flat open-water swim quality: good +0.8 | ok +0.4 | surf/poor 0
  + budget (EUR low-end rent): <350 +0.9 | <700 +0.55 | <1000 +0.2 | else -0.3
  + founder internet: excellent +0.7 | good +0.35 | weak 0
  + land training (bike/run): good +0.55 | mod +0.3 | poor +0.05
  + Thanyapura endurance hub (Phuket): +0.5
  + visa ease (Canadian): >=90d +0.3 | >=60d +0.15 | >=30d +0.05 | e-visa 0
  + tourism tier: <=2 +0.2 | 3 0 | 4 -0.3
  + safety: none 0 | mild -0.15 | heavy -2.0
  + remote airport (>~3h): -0.3
  - timezone penalty: -0.6 uniformly (all SE Asia is +11/+12h vs Toronto EDT —
    poor for NA interview calls; the tool's tz flag carries the rest of the weight)
  clamped to [3.2, 7.6].

USD->EUR at 0.92 (the app then applies EUR->CAD). All figures trace to the
research sources captured in the scratch JSONs / agent transcripts.
"""
import csv, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data-src"
SCRATCH = Path("/tmp/claude-0/-home-user-fluffy-adventure/"
               "f187fb39-527d-5f02-8e2c-5ba0cb7259d2/scratchpad")
USD_TO_EUR = 0.92

# Curated per-town scout attributes (tourism tier normalized to the original
# scale: higher = more touristy; swim = flat open-water quality; land = bike/run).
ATTR = {
 "Canggu": dict(swim="surf", land="mod", tour=4, sev="mild", far=False,
   flag="Scooter accidents + petty phone-snatching",
   vibe="Bali's nomad epicentre — elite cafes/coworking but a surf-break coast (rips, no reef) that's for surfing not lap swimming, and gnarly scooter traffic."),
 "Sanur": dict(swim="good", land="good", tour=3, sev="mild", far=False, flag="",
   vibe="Bali's best everyday swim base: a reef-protected lagoon flat enough for real open-water sets, plus a 5km beachfront boardwalk for run/ride; the calmest, most grown-up corner of Bali."),
 "Uluwatu/Bingin": dict(swim="surf", land="mod", tour=3, sev="mild", far=False,
   flag="Strong currents/exposed reef; scooter accidents",
   vibe="Clifftop surf glamour on the Bukit — world-class waves but dangerous reef/currents for swimming and the priciest villa market on the island."),
 "Amed": dict(swim="good", land="poor", tour=2, sev="mild", far=True, flag="",
   vibe="Quiet black-sand dive coast in East Bali: calm clear bays and the USS Liberty wreck for open-water, but steep volcanic hills and a long haul from the airport."),
 "Nusa Lembongan": dict(swim="ok", land="poor", tour=3, sev="mild", far=False,
   flag="Strong tidal currents; rough boat crossings",
   vibe="Manta-and-turtle reef island off Bali — stunning water but strong tidal currents and thin roads/internet make it a holiday spot more than a training base."),
 "Kuta Lombok": dict(swim="ok", land="good", tour=2, sev="mild", far=False, flag="",
   vibe="South Lombok's rising nomad coast: sheltered horseshoe bays for swimming, quiet rolling roads far calmer than Bali, and the region's cheapest rents."),
 "Gili Air": dict(swim="good", land="poor", tour=3, sev="mild", far=True, flag="",
   vibe="Car-free reef-flat island with turtles off the beach and an easy pace — great swim/snorkel, but sandy paths and small size mean no real bike/run mileage."),
 "Phuket (Rawai/Nai Harn)": dict(swim="ok", land="mod", tour=3, sev="mild", far=False, thanya=True,
   flag="Monsoon rip currents/red flags on west beaches Jul-Oct",
   vibe="Thailand's endurance HQ (Thanyapura's Olympic pool + track ~40min away) on quieter south Phuket — but the Andaman monsoon (May-Oct) red-flags west-coast swimming through most of your window."),
 "Koh Samui": dict(swim="good", land="mod", tour=4, sev="mild", far=False, flag="",
   vibe="Gulf-side resort island that dodges the SW monsoon — Jul-Sep is its drier, calmer swim window with top-tier internet; turns wet Oct-Dec."),
 "Koh Phangan": dict(swim="good", land="poor", tour=3, sev="mild", far=False,
   flag="Steep roads / scooter accidents",
   vibe="More than the Full Moon party — sheltered west/south bays swim well Jul-Sep and there's a big wellness scene, but the steep hilly interior is rough for cycling."),
 "Koh Lanta": dict(swim="ok", land="good", tour=3, sev="mild", far=True, flag="",
   vibe="Laid-back Andaman island with a long flat quiet coastal road (better riding than Phuket) and KoHub coworking — but monsoon swell muddies the swim Jul-Oct."),
 "Ao Nang / Krabi": dict(swim="ok", land="mod", tour=4, sev="mild", far=False, flag="",
   vibe="Karst-scenery gateway with a growing cafe scene, but a mediocre monsoon-season swim beach and tourist-congested roads Jul-Oct."),
 "Hua Hin": dict(swim="ok", land="good", tour=3, sev="none", far=True, flag="",
   vibe="The group's best land-training base — flat quiet roads, a long run-friendly beach and road-cycling into the hills, mainland (no ferry) with great internet; the catch is a murky beach and Sep-Nov being its wettest."),
 "Koh Tao": dict(swim="good", land="poor", tour=3, sev="mild", far=True,
   flag="Steep roads/scooter injuries; limited medical (evac to Samui)",
   vibe="Dive-and-swim paradise: Jul-Sep brings warm clear calm water ideal for open-water volume — but it's a tiny steep island with weak internet and no real bike/run terrain."),
 "Da Nang": dict(swim="ok", land="good", tour=3, sev="none", far=False, flag="",
   vibe="Vietnam's founder city — elite fibre, a flat beachfront promenade and mountain climbs; swims well Jul-Aug but Sep-Dec turns wet with Oct-Nov the peak typhoon window."),
 "Nha Trang": dict(swim="ok", land="good", tour=4, sev="mild", far=False,
   flag="Petty theft on the tourist strip",
   vibe="Big beach-city with a flat run-friendly boulevard and cheap rents; dry and swimmable through ~Aug, then Oct-Nov is its wettest and roughest."),
 "Phu Quoc": dict(swim="ok", land="mod", tour=3, sev="none", far=False, flag="",
   vibe="Gulf island with warm water year-round and cheap living, but the SW monsoon batters its west coast Jul-Sep (calm by mid-Nov)."),
 "Mui Ne": dict(swim="ok", land="good", tour=3, sev="none", far=True, flag="",
   vibe="One of SEA's driest coasts — mornings stay swimmable and the quiet dune roads are great for cycling — but it's kitesurf-offseason Jul-Oct and the nearest airport is ~3.5h away (until Phan Thiet opens)."),
 "Kampot": dict(swim="poor", land="good", tour=2, sev="none", far=True, flag="",
   vibe="Mellow riverside town and a cyclist's dream (flat lanes + the Bokor climb, near-zero traffic) — but you swim in the river; the nearest sea (Kep) is monsoon-rough Jul-Oct."),
 "Koh Rong / Sihanoukville": dict(swim="ok", land="poor", tour=4, sev="heavy", far=False,
   flag="Cyber-scam compounds + casino-linked trafficking (Amnesty 2025-26); general crime in Sihanoukville",
   vibe="Warm dry-season water and cheap rooms, but the gateway (Sihanoukville) carries a serious 2025-26 crime/trafficking advisory and island internet is weak — a hard flag for a working base."),
 "Siargao": dict(swim="surf", land="good", tour=3, sev="none", far=False, flag="",
   vibe="Surf-and-nomad darling with a flat coastal road for riding — but Jul-Nov is peak Pacific swell + typhoon season, so it's for surfing, not flat open-water swimming."),
 "Moalboal": dict(swim="ok", land="mod", tour=3, sev="none", far=True, flag="",
   vibe="Cebu's turtle-and-sardine dive town, tucked in the sheltered Tanon Strait so it stays mostly swimmable in the wet months; hilly rides toward Kawasan."),
 "Dumaguete": dict(swim="good", land="good", tour=2, sev="none", far=False, flag="",
   vibe="Cheap, calm university city on a sheltered strait — arguably the most reliable Jul-Nov swim of the Philippine picks, with flat run/ride roads and an airport in town."),
 "La Union (San Juan)": dict(swim="surf", land="mod", tour=3, sev="none", far=True, flag="",
   vibe="Luzon's surf-town weekend escape with a flat coastal highway — but west-facing and Jul-Oct is habagat surf season plus higher typhoon exposure, so flat swimming is inconsistent."),
 "Penang (Batu Ferringhi)": dict(swim="ok", land="mod", tour=3, sev="none", far=False, flag="",
   vibe="George Town's resort strip: warm calm swimmable water, elite internet, real-city services and a 90-day visa-free stay — Malaysia's best all-round base, if a slightly silty beach."),
 "Langkawi": dict(swim="ok", land="good", tour=3, sev="none", far=False, flag="",
   vibe="Duty-free Andaman island with warm calm water and quiet cycling roads on a 90-day visa — swims best Jul-Sep before October's downpours."),
}

SWIM = {"good": 0.8, "ok": 0.4, "surf": 0.0, "poor": 0.0}
LAND = {"good": 0.55, "mod": 0.3, "poor": 0.05}
INET = {"excellent": 0.7, "good": 0.35, "weak": 0.0}
WARM = {"yes": 2.0, "partial": 1.0, "no": 0.1}
SEV = {"none": 0.0, "mild": -0.15, "heavy": -2.0}


def eur(usd): return round(usd * USD_TO_EUR)
def base_town(t): return re.sub(r"\s*\(.*?\)\s*", " ", t).replace("/", " ").strip()


def cost_tier(lo):
    return "$" if lo < 350 else "$$" if lo < 700 else "$$$" if lo < 1000 else "$$$$"


def score(t, a):
    lo = eur(t["rent_usd_month_1br"][0])
    s = 3.6
    s += WARM[t["warm_now_jul_nov"]]
    s += SWIM[a["swim"]]
    s += 0.9 if lo < 350 else 0.55 if lo < 700 else 0.2 if lo < 1000 else -0.3
    s += INET[t["internet_quality"]]
    s += LAND[a["land"]]
    if a.get("thanya"): s += 0.5
    d = t["cad_visa_free_days"]
    s += 0.3 if d >= 90 else 0.15 if d >= 60 else 0.05 if d >= 30 else 0.0
    s += 0.2 if a["tour"] <= 2 else 0.0 if a["tour"] == 3 else -0.3
    s += SEV[a["sev"]]
    if a.get("far"): s -= 0.3
    s -= 0.6  # timezone penalty (all SE Asia +11/+12h vs Toronto)
    return round(max(3.2, min(7.6, s)), 1)


def load():
    towns = []
    for f in ["sea_id.json", "sea_th.json", "sea_vn_kh.json", "sea_ph_my.json"]:
        towns += json.loads((SCRATCH / f).read_text())
    return towns


def main():
    towns = load()
    rows, manifest_rows = [], []
    for t in towns:
        a = ATTR[t["town"]]
        lo_e, hi_e = eur(t["rent_usd_month_1br"][0]), eur(t["rent_usd_month_1br"][1])
        hlo, hhi = eur(t["hotel_usd_night"][0]), eur(t["hotel_usd_night"][1])
        sc = score(t, a)
        tier = cost_tier(lo_e)
        media = f"{base_town(t['town'])} {t['country']} beach aerial drone 4k"
        tri = f"{t['swim_note']} | {t['bike_run_note']}"
        rows.append({
            "town": t["town"], "region": t["country"], "water": t["water"], "type": t["type"],
            "visa_clock": t["canadian_visa"], "cad_visa_free_days": t["cad_visa_free_days"],
            "col_tier": tier,
            "airbnb_month_shoulder_eur": f"{lo_e}-{hi_e} (long-stay est, USD->EUR)",
            "hotel_night_shoulder_eur": f"{hlo}-{hhi} EST",
            "tourism_tier": a["tour"], "peak_months": t["peak_months"],
            "warm_now_jul_nov": t["warm_now_jul_nov"], "tri_note": tri, "flag": a["flag"],
            "score": sc,
            "coords": f"{t['coords'][0]},{t['coords'][1]}",
            "airport_iata": t["airport_iata"], "airport_name": t["airport_name"],
        })
        manifest_rows.append({
            "scan": "SE Asia", "town": t["town"], "country_or_region": t["country"],
            "water_body": t["water"], "type": t["type"], "score": sc, "flag": a["flag"],
            "vibe_note": a["vibe"], "suggested_media_search": media,
        })

    # write regional detail CSV
    cols = ["town", "region", "water", "type", "visa_clock", "cad_visa_free_days",
            "col_tier", "airbnb_month_shoulder_eur", "hotel_night_shoulder_eur",
            "tourism_tier", "peak_months", "warm_now_jul_nov", "tri_note", "flag",
            "score", "coords", "airport_iata", "airport_name"]
    with open(SRC / "southeastasia.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader(); w.writerows(rows)

    # refresh SE Asia rows in the manifest (idempotent: drop existing, re-append)
    man_path = SRC / "manifest.csv"
    with open(man_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f); man_cols = reader.fieldnames
        existing = [r for r in reader if r["scan"] != "SE Asia"]
    with open(man_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=man_cols)
        w.writeheader(); w.writerows(existing)
        for m in manifest_rows:
            w.writerow({c: m.get(c, "") for c in man_cols})

    rows.sort(key=lambda r: -r["score"])
    print(f"Wrote {len(rows)} SE Asia towns -> southeastasia.csv + manifest.csv")
    print("Ranking:")
    for r in rows:
        print(f"  {r['score']:>4}  {r['town']:<26} {r['region']:<12} {r['col_tier']:<5} "
              f"warm={r['warm_now_jul_nov']:<7} €{r['airbnb_month_shoulder_eur'].split(' ')[0]}")


if __name__ == "__main__":
    main()
