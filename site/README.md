# Cogworks docs

The developer documentation site — [Astro](https://astro.build) +
[Starlight](https://starlight.astro.build). Static output, **no React**; the
only shipped client JS is Starlight's vanilla search (Pagefind) and nav.

Themed to the Cogworks brand (cyanotype navy + lime `#B6D14A`, Chakra Petch /
Space Mono) via `src/styles/cogworks.css`.

## Develop

```sh
bun install
bun run dev        # http://localhost:4321/cogworks/docs/
bun run build      # → dist/
```

Content lives in `src/content/docs/*.md` (one page per topic; the sidebar is
defined in `astro.config.mjs`). `base` is `/cogworks/docs` because the built
site is composed under the shared GitHub Pages site (landing at the root,
docs under `/docs/`) — see `.github/workflows/pages.yml`.
