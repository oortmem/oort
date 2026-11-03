# Oort brand assets

Source files Marcus supplied on 2026-11-03 live in `assets/brand/source/`; everything
else under `assets/brand/` is generated from them by a Pillow script (keying out the
flat background with a soft 70-level edge, forcing dot colour to pure white or near
black so resized edges stay crisp, keeping the blue `#3B82F6` core and comet).

## The mark

A spiral of dots thinning toward a blue core, with one blue point being pulled inward
along a curved trail: the Oort cloud, and a cold memory being hydrated back in. This is
the logo. Do not redraw it; derive from the 1024 sources.

| Use | File |
| --- | --- |
| On dark backgrounds (white dots, transparent) | `assets/brand/mark/oort-mark-for-dark-bg-{1024,512,256,128,64}.png` |
| On light backgrounds (near-black dots, transparent) | `assets/brand/mark/oort-mark-for-light-bg-{1024,512,256,128,64}.png` |
| Favicon (dark tile, works on light and dark tabs) | `assets/brand/icons/favicon.ico` (16/32/48/64), `icon-{16..512}.png` |
| Apple touch icon | `assets/brand/icons/apple-touch-icon.png` (180) |
| Tauri / desktop app icon | `assets/brand/icons/app-icon-1024.png` (square), `app-icon-rounded-1024.png` |
| Social / Open Graph | `assets/brand/social/og-image-1200x630.png`, `social-card-1280x720.png` |
| Hero animation reference | `assets/brand/hero/hero-inspiration-1280x720.png` |

Still to do: a true vector SVG of the mark (trace the 1024 source or rebuild it
parametrically; the spiral is regular enough to generate from a small script, which
would also make it animatable). Tracked in CON-4.

Colours: background `#05070F` (source icon is `#02040D`), star white `#F5F7FF`,
active blue `#3B82F6`, glow `#60A5FA` at low alpha, muted text white at 45%.

## Hero animation brief (landing page and Observatory background)

The hero reference shows the mark as a luminous object in a star field: white dots on
the spiral, a glowing blue core with soft bloom, the comet point on its inward trail,
faint concentric guide rings, and a deep navy field with scattered stars and two faint
galaxies. The brief for `oortcloud.dev` and for the Observatory's Discover background:

1. **Build the spiral procedurally**, not from the PNG: N arms (the source has ~14), dot
   radius and spacing shrinking toward the centre, so every dot is an element we can
   move. Canvas 2D is enough; no WebGL needed.
2. **Idle motion**: the whole spiral rotates very slowly (one turn in roughly 90 s),
   and each dot drifts inward by a tiny amount and respawns at the rim, so the spiral
   looks like it is slowly feeding the core. The star field has two parallax layers
   drifting at different speeds.
3. **The comet**: one dot at a time detaches from an outer arm and follows a curved
   path to the core with a short fading trail, brightening as it arrives; the core
   pulses once on arrival. One comet every 6 to 10 s. On the Observatory map the same
   animation is used for an actual cold-memory hydration, so the hero teaches the
   concept.
4. **On load**: the spiral assembles from the rim inward over about 1.2 s with a
   slight overshoot ease, then the core lights up.
5. **Interaction**: pointer proximity nudges nearby dots outward slightly (a soft
   repulsion field) and returns them; on the landing page a scroll past the hero slows
   the rotation and fades the field to the page background.
6. **Restraint**: nothing else moves; `prefers-reduced-motion` renders the static
   frame with the comet drawn mid-trail. Target 60 fps on a 2020 laptop and under 2%
   CPU idle on the desktop app.

Use the `motion` library for DOM transitions and a hand-written canvas loop for the
spiral; see Observatory issues CON-27 to CON-30 for the shared motion spec.
