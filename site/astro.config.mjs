// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Docs are composed into the shared GitHub Pages site under /cogworks/docs/
// (the landing page occupies the root /cogworks/). See .github/workflows/pages.yml.
export default defineConfig({
  site: "https://go4cas.github.io",
  base: "/cogworks/docs",
  outDir: "./dist",
  integrations: [
    starlight({
      title: "Cogworks",
      tagline: "The works, without the work.",
      description:
        "Self-hosted, single-binary backend-as-a-service — database, REST APIs, realtime, queues, search, auth, storage, and AI (MCP).",
      logo: { src: "./src/assets/cogworks-logo.svg", replacesTitle: false },
      customCss: ["./src/styles/cogworks.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/go4cas/cogworks" },
      ],
      editLink: {
        baseUrl: "https://github.com/go4cas/cogworks/edit/main/site/",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "introduction" },
            { label: "Getting started", slug: "getting-started" },
            { label: "Examples", slug: "examples" },
          ],
        },
        {
          label: "Core",
          items: [
            { label: "Data model", slug: "data-model" },
            { label: "REST API", slug: "rest-api" },
            { label: "Authentication", slug: "authentication" },
            { label: "Realtime", slug: "realtime" },
            { label: "Files & storage", slug: "files" },
          ],
        },
        {
          label: "Extend",
          items: [
            { label: "Extensibility", slug: "extensibility" },
            { label: "Platform features", slug: "platform" },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Observability", slug: "observability" },
            { label: "Operations", slug: "operations" },
            { label: "Deployment", slug: "deployment" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "CLI & reference", slug: "reference" }],
        },
      ],
    }),
  ],
});
