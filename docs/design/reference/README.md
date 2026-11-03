# Observatory: visual reference

Seven reference frames Marcus supplied on 2026-11-03 for the memory viewer
("Observatory"). They come from a third-party concept app for "wishes"; we borrow the
visual language, not the product. Our own touch is required (see the design doc §13):
these are a mood and an interaction vocabulary, not a spec to copy.

| File | What it shows | What we take from it |
| --- | --- | --- |
| `01-dive-query-orbit.png` | A query ("I want to design houses") under an orbiting planet with small coloured satellites; a white pill button "Dive" and a secondary star button | The recall interaction: a query becomes a body, matching memories orbit it, "Dive" runs the search. Pill button + secondary icon button pattern. |
| `02-timeline-entries.png` | Vertical timeline on a star field: each entry is a glowing blue node on a thin line, title text, muted "Tap to see results" | The chronological feed: memories as nodes on a line, muted secondary line (ours: age, tier, type). |
| `03-timeline-long-entry.png` | Same timeline with a long multi-line entry and a status bar | Entries can be long; wrap, do not truncate. Header "Discover wishstars" → ours "Discover memories". |
| `04-star-map-clusters.png` | Star map: clusters drawn as faint circles containing bright square-ish stars and a few blue spherical nodes; scattered background stars | The map view: a cluster per project (or topic), stars per memory. Bright white squares = active (hot/warm), blue spheres = the ones the current query lit up. |
| `05-cluster-labels-closeup.png` | Cluster circles labelled "Design", "Business" with a thin leader line to the label | Cluster labelling: thin leader line from the circle's edge to a label, never inside the circle. |
| `06-star-map-labeled.png` | Wider map with several labelled clusters ("Health", "Design", "Business") and the bottom nav | Layout: clusters spread on a dark navy-to-black gradient, generous spacing, labels sparse. |
| `07-bottom-nav.png` | Bottom navigation: "Discover" (active, circled magnifier with blue glow ring), "My Space" (three dots cluster icon), "Me" (person icon) | Three top-level destinations. Ours: **Discover** (map + dive), **Timeline**, **Settings**. Active state = glow ring, not a filled pill. |

Palette read from the frames: background `#05070F` to `#0B1226` gradient, star white
`#F5F7FF`, active blue `#3B82F6` with outer glow `#60A5FA` at low alpha, accent
magenta/orange satellites only as tiny points, text white at 90% and muted at 45%.
Type is a geometric sans at generous size; nothing is bold.

Things to deliberately do differently (our touch): tiers are visible (cold memories are
faint and far from the cluster centre, hot ones bright and central), hydration is an
animation (a cold star drifts inward and brightens when a query pulls it back),
supersede chains are drawn as a short trail from the old star to the new one, and every
star opens to the memory's explanation (why stored, why recalled, decisions).
