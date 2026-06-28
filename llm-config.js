// Committed default config — SAFE TO DEPLOY. Never put an API key in this file.
//
// • Hosted mode (Azure Static Web Apps): uncomment `proxyUrl` below. The app
//   then routes LLM calls to the same-origin /api/llm managed function, which
//   holds the key (set as an Application Setting) — nothing secret ships in the
//   public site. See DEPLOY.md.
// • Until proxyUrl is set, the app runs the FREE in-browser rule judge (no key,
//   no cost) — a safe default for a public URL.
// • Local dev: llm-config.local.js (gitignored) loads AFTER this file and fully
//   overrides it with your local key for direct API calls.

window.SCIENCE_BOWL_CONFIG = {
  llm: {
    enabled: true,
    model: 'haiku',
    // proxyUrl: '/api/llm',   // Azure Static Web Apps managed function (same-origin)
    // proxyToken: '',         // only if the function sets an APP_TOKEN app setting
    dailyBudgetUsd: 2.0,
    providerKeys: { anthropic: '', openai: '', google: '' },
  },
};
