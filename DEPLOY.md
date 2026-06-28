# Deploying the Science Bowl app (Cloudflare Pages + LLM proxy Worker)

The app is a **static site** — no build step. These steps host it at a URL your
kids open on their own laptops, with the Anthropic key kept server-side on a
Cloudflare Worker (never shipped to the browser).

Division of labor: the code is all in this repo. You run the Cloudflare-account
steps (login, secrets, connect repo) — those need your account.

Prerequisites
- A free Cloudflare account.
- This repo pushed to GitHub (`cyanyellowwp/quiz-practice`).
- `npm i -g wrangler` (Cloudflare CLI) for the Worker.

---

## Part A — Host the static site (Cloudflare Pages)  ·  free

1. Push the repo to GitHub (the app lives in `science-bowl-quiz/`).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick `cyanyellowwp/quiz-practice`. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `science-bowl-quiz`
4. Deploy. You'll get a URL like `https://nsb-quiz.pages.dev`.

At this point the app works with the **free rule-based judge** (no key, no cost).
That alone is a fine setup for kids using guided-review mode. To add Claude's
semantic grading + explanations, do Part B.

---

## Part B — LLM proxy Worker (keeps your key off the kids' laptops)  ·  free tier

From the `science-bowl-quiz/worker/` folder:

1. `wrangler login`
2. Set the key(s) as secrets (never committed):
   ```
   wrangler secret put ANTHROPIC_API_KEY      # paste your sk-ant-... key
   # wrangler secret put GOOGLE_API_KEY        # only if you use Gemini
   ```
3. Edit `wrangler.toml` → set `ALLOWED_ORIGIN` to your Pages URL from Part A
   (e.g. `https://nsb-quiz.pages.dev`). This locks the proxy to your site.
4. `wrangler deploy` → you'll get a Worker URL like
   `https://nsb-llm-proxy.<your-subdomain>.workers.dev`.

Then point the app at it:

5. Edit `llm-config.js` (committed, safe — no key) and uncomment/set:
   ```js
   proxyUrl: 'https://nsb-llm-proxy.<your-subdomain>.workers.dev',
   ```
6. Commit + push → Cloudflare Pages auto-redeploys. The hosted app now sends LLM
   calls to the Worker, which injects the key.

> The committed `llm-config.js` contains **no secret** — just the Worker URL. The
> key lives only in the Worker secret and your local `llm-config.local.js`.

---

## Part C — Lock it to your family (recommended)  ·  free

The proxy spends your API credits, so gate who can load the app:

- Cloudflare dashboard → **Zero Trust → Access → Applications → Add → Self-hosted**.
- Point it at the Pages domain; policy = **Allow** the specific emails (you + kids).
- Now only those emails can open the app at all.

Backstops (do at least one):
- The Worker is already locked to `ALLOWED_ORIGIN` and clamps output tokens.
- Set a **monthly spend limit** in the Anthropic Console — the real hard cap.
- Optional extra gate: `wrangler secret put APP_TOKEN`, then set a matching
  `proxyToken` in `llm-config.js`.

---

## Cost summary
- Pages hosting: **$0** (free tier).
- Worker: **$0** (free tier, 100k requests/day).
- LLM usage: pennies, only when the judge/explanations run; capped client-side
  (`dailyBudgetUsd`) and by your provider's monthly limit.

## Updating later
Push to GitHub → Pages redeploys the site automatically. Re-run `wrangler deploy`
from `worker/` only when the Worker code changes.

## Local development is unchanged
`llm-config.local.js` (gitignored) still loads last and overrides everything, so
locally you keep using your direct key with `python3 -m http.server 3000`.
