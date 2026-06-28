// Copy this file to llm-config.local.js and fill in ONLY the provider key you want to use locally.
// Like the math app's .env.local pattern, keep the real local file out of git.
// This is still browser-loaded config, so it is convenient but not secret.

window.SCIENCE_BOWL_CONFIG = {
  llm: {
    enabled: true,
    // Choose one of: gemini-flash, gemini-pro, haiku, sonnet, opus, gpt-4o-mini, gpt-4o.
    model: 'haiku',

    // --- Hosted mode (Cloudflare Pages + Worker) ---
    // Set proxyUrl to your deployed Worker. When set, the app routes ALL LLM
    // calls through the Worker (which holds the key) and the providerKeys below
    // are IGNORED — so no API key ships in the public site. See docs/DEPLOY.md.
    // proxyUrl: 'https://nsb-llm-proxy.<your-subdomain>.workers.dev',
    // proxyToken: '',   // must match the Worker's APP_TOKEN secret, if you set one

    // --- Local mode only --- put a key here (in the gitignored llm-config.local.js,
    // NEVER in a deployed site). Leave blank in hosted mode.
    providerKeys: {
      anthropic: '',
      openai: '',
      google: '',
    },

    // Hard cap on LLM spend (rolling 24h, client-side). The Worker also clamps
    // per-request output; set a monthly limit in the provider console as the
    // real backstop.
    dailyBudgetUsd: 2.0,
  },
};
