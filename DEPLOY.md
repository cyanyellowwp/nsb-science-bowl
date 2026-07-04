# Deploying the Science Bowl app (Azure Static Web Apps + LLM proxy)

The app is a **static site** — no build step. Azure Static Web Apps (SWA) hosts
it at a URL your kids open on their own laptops, and its built-in **managed
function** (`/api/llm`) acts as the LLM proxy, holding the Anthropic key
server-side so it never reaches the browser. Both run on the SWA **Free** plan.

Division of labor: all the code is in this repo. You run the Azure-portal steps
(create the SWA, set the key) — those need your account.

Layout the deploy uses:
- App (static): repo root `/`
- API (managed function): `api/`  → served at `/api/llm`

---

## Part A — Create the Static Web App  ·  free

1. Push the repo to GitHub (already done).
2. Azure Portal → **Create resource → Static Web App**.
   - Plan: **Free**
   - Deployment source: **GitHub** → repo `cyanyellowwp/nsb-science-bowl`, branch `main`
   - Build preset: **Custom**
   - **App location:** `/`
   - **Api location:** `api`
   - **Output location:** *(leave blank)*
3. Create. Azure adds a GitHub Actions workflow and deploys. You get a URL like
   `https://<name>.azurestaticapps.net`.
4. Confirm the generated workflow has `app_location: "/"` and
   `api_location: "api"`.

At this point the app works with the **free rule-based judge** (no key, no cost).
That's already fine for kids in guided-review mode. To add Claude's semantic
grading + explanations, do Part B.

---

## Part B — Turn on the LLM proxy  ·  free tier

1. Azure Portal → your Static Web App → **Configuration → Application settings**
   → add:
   - `ANTHROPIC_API_KEY` = your `sk-ant-…` key
   - *(optional)* `GOOGLE_API_KEY` if you use Gemini
   - *(optional)* `APP_TOKEN` = any random string (a shared gate)
   Save. These are server-side only — never in the repo.
2. Edit `llm-config.js` (committed, safe — no key) and uncomment:
   ```js
   proxyUrl: '/api/llm',
   // proxyToken: 'the-same-APP_TOKEN-if-you-set-one',
   ```
3. Commit + push → SWA auto-redeploys. The app now sends LLM calls to
   `/api/llm`, which injects the key. Nothing secret ships to the browser.

> The function is **same-origin** (`/api/llm`), so there's no CORS or separate
> URL to manage.

---

## Part C — Lock it to your family (recommended)

The proxy spends your API credits, so gate who can use it. Two layers:

1. **SWA auth** (free): require login for the whole app. Add this route rule to
   `staticwebapp.config.json` and invite your family's accounts in the portal
   (Static Web App → Role management → Invite):
   ```json
   "routes": [
     { "route": "/api/*", "allowedRoles": ["authenticated"] },
     { "route": "/*",     "allowedRoles": ["authenticated"] }
   ]
   ```
   (Ask me to add this — I left it out by default so the site stays open until
   you decide.)
2. **Backstops:** the function clamps output tokens, the app enforces the
   `dailyBudgetUsd` cap, and — most important — set a **monthly spend limit in
   the Anthropic Console** as the real hard ceiling. Optionally also set
   `APP_TOKEN` (step B1) + `proxyToken` (step B2).

---

## Cost summary
- SWA hosting + managed function: **$0** (Free plan).
- LLM usage: pennies, only when judge/explanations run; capped client-side and
  by your provider's monthly limit.

## Updating later
Push to `main` → SWA redeploys the site **and** the function automatically.

## Local development is unchanged
`llm-config.local.js` (gitignored) still loads last and overrides everything, so
locally you keep using your direct key with `python3 -m http.server 3000`. The
`/api/llm` path only exists once deployed to Azure.
