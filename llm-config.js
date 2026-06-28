// Committed default config — SAFE TO DEPLOY. Never put an API key in this file.
//
// • Hosted mode (Cloudflare Pages): uncomment `proxyUrl` and point it at your
//   deployed Worker (see DEPLOY.md). All LLM calls then go through the Worker,
//   which holds the key — nothing secret ships in the public site.
// • Until proxyUrl is set, the app runs the FREE in-browser rule judge (no key,
//   no cost) — a safe default for a public URL.
// • Local dev: llm-config.local.js (gitignored) loads AFTER this file and fully
//   overrides it with your local key for direct API calls.

window.SCIENCE_BOWL_CONFIG = {
  llm: {
    enabled: true,
    model: 'haiku',
    // proxyUrl: 'https://nsb-llm-proxy.<your-subdomain>.workers.dev',
    // proxyToken: '',   // only if the Worker sets an APP_TOKEN secret
    dailyBudgetUsd: 2.0,
    providerKeys: { anthropic: '', openai: '', google: '' },
  },
};
