#!/usr/bin/env python3
"""
Waterline Scout — data build.

Joins the ALL-TOWNS manifest (the spine, 120 towns) with the three per-region
detail CSVs (eastern europe / africa / brazil) by exact town name, lightly
enriches each town, and emits:

  - data.json  (canonical, read when the page is served over http)
  - data.js    (same payload assigned to window.WATERLINE_DATA, so index.html
                works when opened directly from disk with no server)

DESIGN RULE: pricing, scores, tourism tiers, peak months, visa clocks and
water-body/type come straight from the source CSVs and are NEVER recomputed or
invented. Everything this script *derives* (EUR->CAD, timezone offset, warm-now
class, airport, coordinates, parsed water temp) is marked in the record with a
`_derived` provenance block and, where relevant, a human-readable note, so the
UI can flag anything that is not source-of-truth.
"""

import csv, json, re, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data-src"

# --- single, disclosed FX assumption (see README) ----------------------------
# Approximate EUR->CAD used only for the CAD display + budget slider. Change in
# ONE place here (and it is echoed into the data file so the UI can show it).
EUR_TO_CAD = 1.48
FX_NOTE = f"1 EUR ≈ {EUR_TO_CAD} CAD (approximate, build-time constant)"

# Toronto reference for the interview window (Sept/Oct 2026 -> EDT, UTC-4).
TORONTO_UTC = -4


def slugify(name: str) -> str:
    s = name.lower()
    s = s.replace("ã", "a").replace("é", "e").replace("í", "i").replace("ç", "c")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


# --- timezone: UTC offset during the Jul–Nov window (summer DST where it applies)
# value = town local UTC offset; tz_vs_toronto is computed as value - (-4).
TZ_BY_COUNTRY = {
    "Georgia": 4, "Estonia": 3, "Latvia": 3, "Lithuania": 3,
    "Poland": 2, "Hungary": 2, "Slovenia": 2, "Croatia": 2,
    "Montenegro": 2, "Albania": 2, "North Macedonia": 2,
    "Bulgaria": 3, "Romania": 3,
    "Mauritius": 4, "Morocco": 1, "Western Sahara (MA-admin)": 1,
    "Egypt": 3, "Cape Verde": -1, "Senegal": 0, "The Gambia": 0,
    "Kenya": 3, "South Africa": 2, "Zanzibar": 3, "Mozambique": 2,
    "Tunisia": 1, "Namibia": 2, "Malawi": 2,
}
# Brazil towns are all UTC-3 (no DST since 2019).
TZ_BRAZIL = -3

# Nearest usable airport (IATA). note != "" means inferred / caveat.
AIRPORTS = {
    "Batumi": ("BUS", "Batumi Int'l", ""),
    "Parnu": ("TLL", "Tallinn (~2h)", "no major airport at Pärnu"),
    "Split": ("SPU", "Split", ""),
    "Tallinn": ("TLL", "Tallinn", ""),
    "Zadar": ("ZAD", "Zadar", ""),
    "Siofok": ("BUD", "Budapest (~1.5h)", "Hévíz-Balaton SOB seasonal, closer"),
    "Ohrid": ("OHD", "Ohrid St. Paul", ""),
    "Balatonfured": ("BUD", "Budapest (~1.5h)", "Hévíz-Balaton SOB seasonal, closer"),
    "Rovinj": ("PUY", "Pula (~40min)", ""),
    "Sibenik": ("SPU", "Split (~1h)", "Zadar ZAD similar distance"),
    "Sopot": ("GDN", "Gdańsk (~25min)", ""),
    "Kotor": ("TIV", "Tivat", ""),
    "Gdansk": ("GDN", "Gdańsk", ""),
    "Budva": ("TIV", "Tivat (~20min)", ""),
    "Tivat": ("TIV", "Tivat", ""),
    "Varna": ("VAR", "Varna", ""),
    "Nida": ("PLQ", "Palanga", "ferry + drive from Nida"),
    "Haapsalu": ("TLL", "Tallinn (~1.5h)", ""),
    "Bled": ("LJU", "Ljubljana (~40min)", ""),
    "Klaipeda": ("PLQ", "Palanga (~30min)", ""),
    "Burgas": ("BOJ", "Burgas", ""),
    "Saaremaa (Kuressaare)": ("URE", "Kuressaare", "small; via Tallinn or ferry"),
    "Constanta": ("CND", "Constanța", ""),
    "Herceg Novi": ("TIV", "Tivat", "Dubrovnik DBV similar via border"),
    "Hvar": ("SPU", "Split + ferry", ""),
    "Mamaia": ("CND", "Constanța", ""),
    "Palanga": ("PLQ", "Palanga", ""),
    "Jurmala": ("RIX", "Riga (~30min)", ""),
    "Piran": ("TRS", "Trieste, IT (~45min)", "Ljubljana LJU ~1.5h alt"),
    "Saranda": ("TIA", "Tirana (~3.5h)", "Corfu CFU by ferry, closer"),
    "Bohinj": ("LJU", "Ljubljana (~1h)", ""),
    "Vlore": ("TIA", "Tirana (~2.5h)", "new Vlorë airport pending"),
    "Hiiumaa (Kardla)": ("KDL", "Kärdla", "small; via Tallinn or ferry"),
    "Pomorie": ("BOJ", "Burgas (~20min)", ""),
    "Neringa/Juodkrante": ("PLQ", "Palanga", "ferry + drive"),
    "Sozopol": ("BOJ", "Burgas (~40min)", ""),
    "Kolobrzeg": ("SZZ", "Szczecin (~2h)", "regional/seasonal links closer"),
    "Wladyslawowo/Hel": ("GDN", "Gdańsk (~1.5h)", ""),
    "Golden Sands": ("VAR", "Varna (~30min)", ""),
    "Dhermi/Himare": ("TIA", "Tirana (~3h)", "Corfu CFU by ferry alt"),
    "Durres": ("TIA", "Tirana (~40min)", ""),
    "Tamarin": ("MRU", "Mauritius SSR", ""),
    "Agadir": ("AGA", "Agadir–Al Massira", ""),
    "El Gouna": ("HRG", "Hurghada (~25min)", ""),
    "Dahab": ("SSH", "Sharm el-Sheikh (~1.5h)", ""),
    "Diani Beach": ("UKA", "Ukunda", "avoid Likoni ferry; Mombasa MBA alt"),
    "Wilderness": ("GRJ", "George (~15min)", ""),
    "Paje": ("ZNZ", "Zanzibar", ""),
    "Sedgefield": ("GRJ", "George (~30min)", ""),
    "Mindelo": ("VXE", "São Pedro, São Vicente", ""),
    "Dakar": ("DSS", "Blaise Diagne", ""),
    "Flic-en-Flac": ("MRU", "Mauritius SSR", ""),
    "Santa Maria": ("SID", "Amílcar Cabral, Sal", ""),
    "Taghazout": ("AGA", "Agadir (~40min)", ""),
    "Muizenberg": ("CPT", "Cape Town", ""),
    "Tofo": ("INH", "Inhambane (~30min)", ""),
    "Vilanculos": ("VNX", "Vilankulo", ""),
    "Jambiani": ("ZNZ", "Zanzibar", ""),
    "Kendwa": ("ZNZ", "Zanzibar", ""),
    "Sal Rei": ("BVC", "Rabil, Boa Vista", ""),
    "Mirleft": ("AGA", "Agadir (~2h)", "Guelmim GLN small, closer"),
    "Watamu": ("MYD", "Malindi (~40min)", ""),
    "Nungwi": ("ZNZ", "Zanzibar", ""),
    "Pereybere": ("MRU", "Mauritius SSR", ""),
    "Essaouira": ("ESU", "Essaouira–Mogador", ""),
    "Oualidia": ("CMN", "Casablanca (~2.5h)", "no close commercial field"),
    "Grand Baie": ("MRU", "Mauritius SSR", ""),
    "Sidi Ifni": ("AGA", "Agadir (~3h)", "remote south coast"),
    "Matemwe": ("ZNZ", "Zanzibar", ""),
    "Dakhla": ("VIL", "Dakhla", ""),
    "Knysna": ("GRJ", "George (~45min)", ""),
    "Malindi": ("MYD", "Malindi", ""),
    "Plettenberg Bay": ("GRJ", "George (~1h)", "PBZ small, in town"),
    "Nkhata Bay": ("ZZU", "Mzuzu (~1h)", "regional"),
    "Cape Maclear": ("LLW", "Lilongwe (~4h)", "remote; Blantyre BLZ alt"),
    "Cape Town": ("CPT", "Cape Town", ""),
    "Hammamet": ("NBE", "Enfidha–Hammamet", ""),
    "Sousse": ("MIR", "Monastir (~40min)", "Enfidha NBE alt"),
    "Monastir": ("MIR", "Monastir", ""),
    "Kalk Bay": ("CPT", "Cape Town (~40min)", ""),
    "Djerba Houmt Souk": ("DJE", "Djerba–Zarzis", ""),
    "Kololi Kotu": ("BJL", "Banjul", ""),
    "Sahl Hasheesh": ("HRG", "Hurghada (~20min)", ""),
    "Hurghada": ("HRG", "Hurghada", ""),
    "Popenguine": ("DSS", "Blaise Diagne (~40min)", ""),
    "Swakopmund": ("WVB", "Walvis Bay (~40min)", ""),
    "Hermanus": ("CPT", "Cape Town (~1.5h)", "no commercial field in town"),
    "Marsa Alam": ("RMF", "Marsa Alam", ""),
    "Saly": ("DSS", "Blaise Diagne (~40min)", ""),
    "Jeffreys Bay": ("PLZ", "Gqeberha/PE (~1h)", ""),
    "Stone Town": ("ZNZ", "Zanzibar", ""),
    "Joao Pessoa": ("JPA", "João Pessoa", ""),
    "Pipa (Praia da Pipa)": ("NAT", "Natal (~1.5h)", ""),
    "Fortaleza (Praia do Futuro)": ("FOR", "Fortaleza", ""),
    "Cumbuco": ("FOR", "Fortaleza (~30min)", ""),
    "Joao Pessoa (Cabo Branco cluster)": ("JPA", "João Pessoa", ""),
    "Natal (Ponta Negra)": ("NAT", "Natal", ""),
    "Recife (Boa Viagem)": ("REC", "Recife", ""),
    "Porto de Galinhas": ("REC", "Recife (~1h)", ""),
    "Itacare": ("IOS", "Ilhéus (~1.5h)", ""),
    "Maceio (Pajucara)": ("MCZ", "Maceió", ""),
    "Buzios (Armacao dos Buzios)": ("CFB", "Cabo Frio (~1h)", "Rio GIG ~2.5h"),
    "Maragogi": ("MCZ", "Maceió (~2h)", "Recife REC similar"),
    "Cabo Frio": ("CFB", "Cabo Frio", ""),
    "Arraial do Cabo": ("CFB", "Cabo Frio (~30min)", ""),
    "Arraial dAjuda": ("BPS", "Porto Seguro + ferry", ""),
    "Ubatuba": ("SJK", "São José dos Campos (~2h)", "GRU ~3h alt"),
    "Morro de Sao Paulo": ("SSA", "Salvador + boat", ""),
    "Paraty": ("GIG", "Rio Galeão (~3.5h)", "no close commercial field"),
    "Ilhabela": ("SJK", "São José dos Campos + ferry", ""),
    "Ubatuba (Itamambuca cluster)": ("SJK", "São José dos Campos (~2h)", ""),
    "Florianopolis (Lagoa da Conceicao)": ("FLN", "Florianópolis", ""),
    "Garopaba": ("FLN", "Florianópolis (~1h)", ""),
    "Imbituba": ("FLN", "Florianópolis (~1.5h)", ""),
    "Bombinhas": ("NVT", "Navegantes (~1h)", "FLN ~1.5h alt"),
    "Florianopolis (Praia Mole/Barra)": ("FLN", "Florianópolis", ""),
    "Rio de Janeiro (Copacabana/Ipanema)": ("GIG", "Rio Galeão", "SDU domestic closer"),
    "Salvador (Barra/Rio Vermelho)": ("SSA", "Salvador", ""),
    "Fernando de Noronha": ("FEN", "Fernando de Noronha", ""),
}

# Approximate town coordinates [lat, lng] for the map (public geographic
# reference; town-level precision, flagged approximate in the UI).
COORDS = {
    "Batumi": [41.65, 41.64], "Parnu": [58.39, 24.50], "Split": [43.51, 16.44],
    "Tallinn": [59.44, 24.75], "Zadar": [44.12, 15.23], "Siofok": [46.90, 18.06],
    "Ohrid": [41.12, 20.80], "Balatonfured": [46.96, 17.89], "Rovinj": [45.08, 13.64],
    "Sibenik": [43.73, 15.90], "Sopot": [54.44, 18.56], "Kotor": [42.42, 18.77],
    "Gdansk": [54.35, 18.65], "Budva": [42.29, 18.84], "Tivat": [42.43, 18.70],
    "Varna": [43.20, 27.91], "Nida": [55.30, 21.00], "Haapsalu": [58.94, 23.54],
    "Bled": [46.37, 14.11], "Klaipeda": [55.70, 21.14], "Burgas": [42.51, 27.46],
    "Saaremaa (Kuressaare)": [58.25, 22.49], "Constanta": [44.18, 28.63],
    "Herceg Novi": [42.45, 18.53], "Hvar": [43.17, 16.44], "Mamaia": [44.25, 28.61],
    "Palanga": [55.92, 21.07], "Jurmala": [56.97, 23.77], "Piran": [45.53, 13.57],
    "Saranda": [39.87, 20.01], "Bohinj": [46.28, 13.88], "Vlore": [40.47, 19.49],
    "Hiiumaa (Kardla)": [58.99, 22.75], "Pomorie": [42.56, 27.62],
    "Neringa/Juodkrante": [55.54, 21.12], "Sozopol": [42.42, 27.70],
    "Kolobrzeg": [54.18, 15.58], "Wladyslawowo/Hel": [54.79, 18.42],
    "Golden Sands": [43.28, 28.04], "Dhermi/Himare": [40.15, 19.65],
    "Durres": [41.32, 19.44],
    "Tamarin": [-20.33, 57.37], "Agadir": [30.42, -9.60], "El Gouna": [27.40, 33.68],
    "Dahab": [28.49, 34.51], "Diani Beach": [-4.30, 39.58], "Wilderness": [-33.99, 22.58],
    "Paje": [-6.27, 39.53], "Sedgefield": [-34.02, 22.79], "Mindelo": [16.89, -24.99],
    "Dakar": [14.72, -17.47], "Flic-en-Flac": [-20.27, 57.37], "Santa Maria": [16.60, -22.90],
    "Taghazout": [30.54, -9.71], "Muizenberg": [-34.10, 18.47], "Tofo": [-23.85, 35.54],
    "Vilanculos": [-22.00, 35.31], "Jambiani": [-6.28, 39.55], "Kendwa": [-5.72, 39.29],
    "Sal Rei": [16.18, -22.92], "Mirleft": [29.58, -10.03], "Watamu": [-3.35, 40.02],
    "Nungwi": [-5.72, 39.30], "Pereybere": [-20.00, 57.59], "Essaouira": [31.51, -9.77],
    "Oualidia": [32.73, -9.03], "Grand Baie": [-20.01, 57.58], "Sidi Ifni": [29.38, -10.17],
    "Matemwe": [-5.86, 39.36], "Dakhla": [23.71, -15.94], "Knysna": [-34.04, 23.05],
    "Malindi": [-3.22, 40.12], "Plettenberg Bay": [-34.05, 23.37], "Nkhata Bay": [-11.61, 34.30],
    "Cape Maclear": [-14.02, 34.83], "Cape Town": [-33.92, 18.42], "Hammamet": [36.40, 10.62],
    "Sousse": [35.83, 10.64], "Monastir": [35.78, 10.83], "Kalk Bay": [-34.13, 18.45],
    "Djerba Houmt Souk": [33.88, 10.86], "Kololi Kotu": [13.44, -16.70],
    "Sahl Hasheesh": [27.08, 33.79], "Hurghada": [27.26, 33.81], "Popenguine": [14.55, -17.10],
    "Swakopmund": [-22.68, 14.53], "Hermanus": [-34.42, 19.24], "Marsa Alam": [25.07, 34.90],
    "Saly": [14.44, -17.00], "Jeffreys Bay": [-34.05, 24.91], "Stone Town": [-6.16, 39.19],
    "Joao Pessoa": [-7.12, -34.85], "Pipa (Praia da Pipa)": [-6.23, -35.05],
    "Fortaleza (Praia do Futuro)": [-3.73, -38.47], "Cumbuco": [-3.62, -38.73],
    "Joao Pessoa (Cabo Branco cluster)": [-7.15, -34.80], "Natal (Ponta Negra)": [-5.88, -35.18],
    "Recife (Boa Viagem)": [-8.12, -34.90], "Porto de Galinhas": [-8.51, -35.00],
    "Itacare": [-14.28, -38.99], "Maceio (Pajucara)": [-9.67, -35.71],
    "Buzios (Armacao dos Buzios)": [-22.75, -41.88], "Maragogi": [-9.01, -35.22],
    "Cabo Frio": [-22.88, -42.02], "Arraial do Cabo": [-22.97, -42.03],
    "Arraial dAjuda": [-16.49, -39.07], "Trancoso": [-16.59, -39.09],
    "Ubatuba": [-23.43, -45.07],
    "Morro de Sao Paulo": [-13.38, -38.91], "Paraty": [-23.22, -44.71],
    "Ilhabela": [-23.78, -45.36], "Ubatuba (Itamambuca cluster)": [-23.38, -45.00],
    "Florianopolis (Lagoa da Conceicao)": [-27.60, -48.47], "Garopaba": [-28.02, -48.62],
    "Imbituba": [-28.24, -48.67], "Bombinhas": [-27.14, -48.52],
    "Florianopolis (Praia Mole/Barra)": [-27.60, -48.43],
    "Rio de Janeiro (Copacabana/Ipanema)": [-22.97, -43.19],
    "Salvador (Barra/Rio Vermelho)": [-13.01, -38.53], "Fernando de Noronha": [-3.85, -32.42],
}

# Water-body seasonality vs the Jul–Nov window (drives an honest warm-now note).
def seasonality(country, region, water):
    w = water.lower()
    if region == "Brazil":
        # NE Brazil tropical year-round; SE/South cool in the austral winter.
        if "Santa Catarina" in region_full or "Sao Paulo SE" in region_full:
            return "austral-winter (coldest Jul–Sep)"
        return "tropical / warm year-round"
    if any(k in country for k in ["Egypt"]):
        return "Red Sea, warm year-round"
    if country in ("Mauritius", "Kenya", "Zanzibar", "Mozambique"):
        return "Indian Ocean, warm year-round"
    if country in ("Cape Verde", "Senegal", "The Gambia"):
        return "tropical Atlantic, warm year-round"
    if country in ("Morocco", "Western Sahara (MA-admin)", "Namibia"):
        return "cool Atlantic (upwelling), wetsuit-leaning"
    if country == "South Africa":
        return "cool-temperate, warmest Dec–Mar"
    if country in ("Estonia", "Latvia", "Lithuania", "Poland"):
        return "Baltic, warm only mid-summer"
    if country == "Tunisia":
        return "Mediterranean, warm Jun–Oct then cools"
    # EE Adriatic / Black Sea / Balkan lakes
    return "warm mid-summer, cools through Oct–Nov"


WATER_RE = re.compile(r"(\d{2})\s*-\s*(\d{2})\s*C")
WATER_SINGLE_RE = re.compile(r"~?\s*(\d{2})\s*C")


def parse_water_temp(*texts):
    """Pull the first explicit water temp (e.g. '24-26C' or '~27C') from source
    strings. Returns (low, high, label) or (None, None, '')."""
    for t in texts:
        if not t:
            continue
        m = WATER_RE.search(t)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            return lo, hi, f"{lo}–{hi}°C"
        m = WATER_SINGLE_RE.search(t)
        if m:
            v = int(m.group(1))
            return v, v, f"~{v}°C"
    return None, None, ""


def warm_class(low, high, brazil_flag, country, water):
    """Three-state warm-now class for the Jul–Nov window.
       yes  = comfortably swimmable now
       partial = swimmable but cool / wetsuit-optional
       cool = wetsuit / not swimmable in this window
    """
    if brazil_flag:  # explicit source column for Brazil
        f = brazil_flag.strip().lower()
        if f == "yes":
            return "yes"
        if f == "partial":
            return "partial"
        if f == "no":
            return "cool"
    # Tropical / warm-year-round seas: swimmable across the whole Jul–Nov window
    # even where the source note omitted an explicit temperature.
    if country in ("Egypt", "Mauritius", "Kenya", "Zanzibar", "Mozambique",
                   "Cape Verde", "Senegal", "The Gambia"):
        if low is None or low >= 23:
            return "yes"
        return "partial"
    # Cool-water regions regardless of a summer temp reading.
    if country in ("Estonia", "Latvia", "Lithuania", "Poland",
                   "Morocco", "Western Sahara (MA-admin)", "Namibia"):
        # Baltic warmest bays reach ~20-23 in Aug -> partial; open/cold -> cool
        if low is not None and low >= 20:
            return "partial"
        return "cool"
    if country == "South Africa":
        return "cool" if (low is None or low < 20) else "partial"
    if low is None:
        return "partial"
    if low >= 24:
        return "yes"
    if low >= 20:
        return "partial"
    return "cool"


def price_band(s):
    """First 'NNN-NNN' range from an airbnb band string -> (low, high)."""
    m = re.search(r"(\d+)\s*-\s*(\d+)", s or "")
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d+)", s or "")
    if m:
        return int(m.group(1)), int(m.group(1))
    return None, None


RISK_HIGH = ["homicide", "terror", "kidnap", "gang", "do not travel",
             "do-not-travel", "highest", "violence", " war"]
RISK_MED = ["crime", "robbery", "theft", "snatch", "harass", "bumster",
            "dangerous", "bilharzia", "malaria", "cyclone", "flooding",
            "water-quality", "water quality", "shark", "road-safety",
            "road safety", "scam", "pickpocket", "tension", "disputed"]
RISK_LOW = ["awareness", "caution", "vigilant", "petty", "situational"]


def classify_safety(flag_text):
    """Return (risk_level, has_risk). Neutral/positive notes -> ('none', False)."""
    low = (flag_text or "").lower().strip()
    if low in ("", "none", "none material", "low", "n/a"):
        return "none", False
    if any(k in low for k in RISK_HIGH):
        return "high", True
    if any(k in low for k in RISK_MED):
        return "medium", True
    if any(k in low for k in RISK_LOW):
        return "low", True
    return "none", False


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    manifest = read_csv(SRC / "manifest.csv")
    ee = {r["town"]: r for r in read_csv(SRC / "easterneurope.csv")}
    af = {r["town"]: r for r in read_csv(SRC / "africa.csv")}
    br = {r["town"]: r for r in read_csv(SRC / "brazil.csv")}
    detail_by_region = {"Eastern Europe": ee, "Africa": af, "Brazil": br}

    global region_full  # used by seasonality()
    towns = []
    misses = []
    for row in manifest:
        region = row["scan"].strip()
        town = row["town"].strip()
        detail = detail_by_region.get(region, {}).get(town)
        if detail is None:
            misses.append((region, town))
            detail = {}
        region_full = detail.get("region", "") or row.get("country_or_region", "")

        country = row["country_or_region"].strip()
        water = row["water_body"].strip()
        wtype = row["type"].strip()
        score = float(row["score"])
        detail_flag = (detail.get("flag") or "").strip()
        manifest_flag = (row.get("flag") or "").strip()
        # display the more descriptive flag; classify on both combined
        safety_flag = manifest_flag if manifest_flag else detail_flag
        risk_level, has_risk = classify_safety(f"{manifest_flag} | {detail_flag}")
        vibe_note = (row.get("vibe_note") or "").strip()
        media_q = (row.get("suggested_media_search") or "").strip()
        tri_note = (detail.get("tri_note") or "").strip()

        # --- pricing straight from source (never recomputed) -----------------
        col_tier = (detail.get("col_tier") or "").strip()
        airbnb_key = "airbnb_month_peak_eur" if "airbnb_month_peak_eur" in detail \
            else "airbnb_month_shoulder_eur"
        airbnb_raw = (detail.get(airbnb_key) or "").strip()
        hotel_key = "hotel_night_peak_eur" if "hotel_night_peak_eur" in detail \
            else "hotel_night_shoulder_eur"
        hotel_raw = (detail.get(hotel_key) or "").strip()
        tourism_tier = (detail.get("tourism_tier") or "").strip()
        peak_months = (detail.get("peak_months") or "").strip()
        visa_clock = (detail.get("visa_clock") or "").strip()
        visa_days = (detail.get("cad_visa_free_days") or "").strip()

        rent_lo, rent_hi = price_band(airbnb_raw)
        price_basis = ("Sept 2026 shoulder (your window)" if region == "Brazil"
                       else "peak season (overstates Jul–Nov shoulder)")
        rent_lo_cad = round(rent_lo * EUR_TO_CAD) if rent_lo else None
        rent_hi_cad = round(rent_hi * EUR_TO_CAD) if rent_hi else None

        # --- water temp (parsed from source text) ----------------------------
        wlo, whi, wlabel = parse_water_temp(vibe_note, tri_note,
                                            row.get("suggested_media_search"))
        brazil_warm = detail.get("warm_now_jul_nov") if region == "Brazil" else None
        warm = warm_class(wlo, whi, brazil_warm, country, water)

        # --- timezone --------------------------------------------------------
        if region == "Brazil":
            utc = TZ_BRAZIL
        else:
            utc = TZ_BY_COUNTRY.get(country)
        tz_vs = (utc - TORONTO_UTC) if utc is not None else None
        # interview-friendly: a normal ET morning/mid-day call stays in local
        # daytime/early evening -> offset <= +6.
        na_friendly = (tz_vs is not None and tz_vs <= 6)

        # --- airport + coords -------------------------------------------------
        iata, aname, anote = AIRPORTS.get(town, ("", "", "not resolved — verify"))
        coords = COORDS.get(town)

        # --- composed vibe blurb (2–3 sentences, from source facts only) -----
        warm_phrase = {
            "yes": "Warm and swimmable across the Jul–Nov window",
            "partial": "Swimmable but on the cool side in this window (wetsuit-optional)",
            "cool": "Cool water for Jul–Nov — wetsuit territory or off-season",
        }[warm]
        s2 = warm_phrase
        if wlabel:
            s2 += f" (source notes ~{wlabel}; {seasonality(country, region, water)})."
        else:
            s2 += f" ({seasonality(country, region, water)})."
        if tz_vs is not None:
            tzdir = f"{tz_vs:+d}h vs Toronto"
            fit = ("comfortable for NA interview calls" if na_friendly
                   else "afternoon-ET calls land late locally")
            s3 = f"{aname} airport; {tzdir} — {fit}."
        else:
            s3 = f"{aname} airport."
        blurb = " ".join(x for x in [vibe_note.rstrip('.') + '.', s2, s3] if x).strip()

        slug = slugify(town)
        towns.append({
            "id": slug,
            "town": town,
            "region": region,
            "region_detail": region_full,
            "country": country,
            "water_body": water,
            "type": wtype,
            "score": score,
            "safety_flag": safety_flag,
            "risk_level": risk_level,
            "has_risk": has_risk,
            "vibe_note": vibe_note,
            "tri_note": tri_note,
            "blurb": blurb,
            "media_query": media_q,
            # pricing (source of truth)
            "cost_tier": col_tier,
            "rent_band_eur": [rent_lo, rent_hi],
            "rent_band_eur_raw": airbnb_raw,
            "rent_band_cad": [rent_lo_cad, rent_hi_cad],
            "hotel_night_eur_raw": hotel_raw,
            "price_basis": price_basis,
            "tourism_tier": tourism_tier,
            "peak_months": peak_months,
            "visa_clock": visa_clock,
            "visa_free_days": visa_days,
            # enrichment (derived — flagged)
            "water_temp": wlabel,
            "water_temp_low": wlo,
            "water_temp_high": whi,
            "warm_now": warm,
            "seasonality": seasonality(country, region, water),
            "air_temp_note": "not in source data — verify locally",
            "tz_utc": utc,
            "tz_vs_toronto": tz_vs,
            "na_interview_friendly": na_friendly,
            "airport_iata": iata,
            "airport_name": aname,
            "airport_note": anote,
            "coords": coords,
            "_derived": {
                "fx": FX_NOTE,
                "water_temp": "parsed from source vibe/tri notes" if wlabel else "not stated in source",
                "warm_now": "derived from source water temp + region seasonality",
                "timezone": "computed vs Toronto EDT (UTC-4) for the Sep/Oct window",
                "airport": "editorial nearest-airport pick" + (f"; {anote}" if anote else ""),
                "coords": "approximate town centroid for map display",
            },
        })

    # region order + within-region by score desc
    region_order = {"Eastern Europe": 0, "Africa": 1, "Brazil": 2}
    towns.sort(key=lambda t: (region_order.get(t["region"], 9), -t["score"]))

    payload = {
        "meta": {
            "generated_from": "waterline-scout manifest + 3 regional CSVs",
            "town_count": len(towns),
            "fx_eur_cad": EUR_TO_CAD,
            "fx_note": FX_NOTE,
            "budget_target_cad": 1000,
            "budget_ceiling_cad": 1300,
            "toronto_ref": "EDT (UTC-4) for the Sept/Oct 2026 interview window",
            "media_status": "placeholder art shipped; run scripts/fetch-media.mjs "
                            "on a networked machine to populate images/<id>/",
            "regions": ["Eastern Europe", "Africa", "Brazil"],
        },
        "towns": towns,
    }

    (ROOT / "data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    (ROOT / "data.js").write_text(
        "// Auto-generated by scripts/build_data.py — do not edit by hand.\n"
        "// Lets index.html work when opened directly from disk (file://).\n"
        "window.WATERLINE_DATA = " +
        json.dumps(payload, ensure_ascii=False) + ";\n")

    print(f"Wrote data.json + data.js: {len(towns)} towns")
    if misses:
        print(f"WARNING: {len(misses)} manifest rows had no regional match:")
        for r, t in misses:
            print(f"   - [{r}] {t}")
    else:
        print("All 120 manifest rows joined to a regional detail row.")

    # quick provenance summary
    warm_counts = {}
    for t in towns:
        warm_counts[t["warm_now"]] = warm_counts.get(t["warm_now"], 0) + 1
    print("warm_now distribution:", warm_counts)
    no_price = [t["town"] for t in towns if t["rent_band_eur"][0] is None]
    if no_price:
        print("WARNING: no rent band parsed for:", no_price)


if __name__ == "__main__":
    main()
