- Oort marketing site, console and app demos use shared mock data in src/lib/oort-data.ts; no backend yet, so sign-in is a UI demo that routes to /dashboard. Why: one source for tiers, pricing and demo content.

## North star

Developers ship apps that remember their users over time.

Metric: developers who sign in to the Oort console each week.

## Rules for this package

- The site must not claim anything untrue today. Unbuilt features carry a visible "Planned" or "Concept" label.
- Numbers on the site are measured numbers with their setup next to them, or labelled targets.
- Deploy target is Cloudflare Workers (`wrangler.jsonc`). Do not deploy from a worktree.
