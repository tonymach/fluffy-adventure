# Photo attribution

No real photos have been fetched yet — every town currently shows **generated SVG
placeholder art** (created by `scripts/gen_placeholders.py`, not stock imagery, so
nothing here needs attribution).

Run the fetcher on a machine with internet to pull free-licensed photos:

```bash
node scripts/fetch-media.mjs            # Openverse + Wikimedia (no key)
```

That regenerates this file (and `attribution.json`) with one credit line per
downloaded photo — creator, license, source URL, and provider — as required by the
Openverse / Wikimedia / Unsplash / Pexels licenses.
