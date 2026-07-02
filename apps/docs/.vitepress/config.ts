import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Meridian",
  description:
    "Stablecoin yield aggregator on Stellar, built for emerging market savers.",
  base: "/docs/",
  vite: { server: { port: 3002 } },
  themeConfig: {
    logo: {
      svg: '<svg viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg"><path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775ca"/><path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#fff"/></svg>',
    },
    nav: [
      { text: "Overview", link: "/overview/introduction" },
      { text: "Architecture", link: "/architecture/monorepo" },
      { text: "Operations", link: "/operations/local-development" },
      { text: "App", link: "https://meridian-web.vercel.app/app/" },
      { text: "GitHub", link: "https://github.com/drydocs/meridian" },
    ],
    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "Introduction", link: "/overview/introduction" },
          { text: "Why Meridian", link: "/overview/why-meridian" },
          { text: "How It Works", link: "/overview/how-it-works" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Monorepo Structure", link: "/architecture/monorepo" },
          { text: "Frontend", link: "/architecture/frontend" },
          { text: "API Layer", link: "/architecture/api" },
          { text: "Vault Contract", link: "/architecture/vault-contract" },
          { text: "Signing Flow", link: "/architecture/signing-flow" },
        ],
      },
      {
        text: "Operations",
        items: [
          { text: "Local Development", link: "/operations/local-development" },
          {
            text: "Testnet Deployment",
            link: "/operations/testnet-deployment",
          },
          {
            text: "Environment Variables",
            link: "/operations/environment-variables",
          },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/drydocs/meridian" },
    ],
    footer: {
      message: "Open source on Stellar.",
      copyright: "MIT License",
    },
    search: {
      provider: "local",
    },
  },
});
