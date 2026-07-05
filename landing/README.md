# Cogworks landing

The marketing landing page — **pure static HTML/CSS/JS, no framework, no build step**.

```
landing/
  index.html   — markup + inline design tokens + critical CSS (Google Fonts via <link>)
  app.js        — vanilla JS: the animated "machine" (imperative SVG), the cycling
                  terminal, and the interactive "gears" spec-browser
  assets/       — static + animated gear-mark logos (currentColor)
```

## Design
Recreated from the Cogworks "Base Page" design brief. Signature element is an
animated technical-blueprint **machine** (flywheel → gear train → belts, rpm
gauge, two roof-mounted control units for Admin UI + MCP, a ratchet flap,
status LEDs, and an interactive power lever). The primary token is
**`--pc: #B6D14A`** (lime); the SVG accent (`belt2`) is derived from it.

Interactions: hover the machine to spin up (1.6×→5×), click the power lever to
freeze it, hover/click the gear list to inspect each subsystem, and the terminal
cycles through five sessions. Honors `prefers-reduced-motion`.

## Develop / deploy
No toolchain. Open `index.html` over any static server:

```sh
python3 -m http.server -d landing 8000   # or: npx serve landing
```

Deploy = serve the folder (Cloudflare Pages / Netlify / any static host).
`scripts/publish-web.sh` subtree-splits `landing/` to its deploy repo.

> Note: the original design prototype (`*.dc.html` + `support.js`) is a
> reference runtime that pulls React off a CDN — it is **not** used here. This
> is a from-scratch vanilla reimplementation.
