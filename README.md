# ✝ Church Giving Platform — Phase 1 (Cloudflare + Supabase)

**Frontend** → GitHub Pages
**Backend API** → Cloudflare Workers (free, full CORS support)
**Database** → Supabase PostgreSQL (free 500MB)
**Email** → Resend (free 3,000/month)
**Payments** → PayChangu
**Notifications** → Telegram Bot API

---

## Why this stack?

| | Cloudflare Workers |
|---|---|
| CORS | ✅ Full control |
| Free outbound HTTP | ✅ PayChangu, Telegram, email all work |
| Credit card needed | ❌ No |
| Free requests | 100,000/day |
| Cold starts | ~0ms (V8 isolates) |

---

## File Structure

```
church-giving/
├── frontend/                  ← GitHub Pages
│   ├── index.html
│   ├── success.html
│   ├── failed.html
│   └── assets/
│       ├── style.css
│       └── form.js            ← Update API_BASE here
│
├── worker/                    ← Cloudflare Worker
│   ├── src/
│   │   └── index.js           ← Entire backend
│   ├── wrangler.toml          ← Config (non-secret vars go here)
│   ├── supabase-setup.sql     ← Run once in Supabase SQL Editor
│   └── package.json
│
└── .github/workflows/
    └── deploy.yml             ← Auto-deploys both on push to main
```

---

## Setup Guide

### Step 1 — Accounts to create (all free, no credit card)

| Service | URL | What for |
|---------|-----|----------|
| Cloudflare | cloudflare.com | Worker hosting |
| Supabase | supabase.com | PostgreSQL database |
| Resend | resend.com | Transactional email |

---

### Step 2 — Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Wait for it to provision (~1 minute)
3. Go to **SQL Editor → New query**
4. Paste the entire contents of `worker/supabase-setup.sql` and click **Run**
5. Confirm both tables appear: `transactions` and `error_log`
6. Go to **Project Settings → API**
7. Copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** key (under "Project API Keys") → this is your `SUPABASE_SERVICE_KEY`

> ⚠️ Use the **service_role** key (not anon key) — it bypasses Row Level Security which is needed for the Worker.

---

### Step 3 — Set up the GAS Email Microservice

Email is sent via a small standalone Google Apps Script that acts as an email relay.
The Cloudflare Worker calls it server-to-server — no CORS issues at all.

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Name it **"Church Giving — Email Service"**
3. Paste the contents of `worker/EmailService.gs` into the editor
4. Edit the two variables at the top:
   ```js
   var EMAIL_SECRET = "any-long-random-string-you-choose";
   var CHURCH_NAME  = "Your Church Name";
   ```
5. Click **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy** — copy the Web App URL
7. This URL becomes your `GAS_EMAIL_URL` secret
8. The random string you set becomes your `GAS_EMAIL_SECRET` secret

> Uses your existing Google account's Gmail quota — 100 emails/day free.
> No new account, no credit card, no domain verification needed.

---

### Step 4 — Set up Cloudflare Worker (browser only, no terminal)

Everything in this step happens inside your browser at dash.cloudflare.com.
No terminal, no Node.js, no commands to run.

---

#### 4a — Create a Cloudflare account

1. Go to [cloudflare.com](https://cloudflare.com) and click **Sign Up**
2. Enter your email and a password — free, no credit card needed
3. Verify your email when the confirmation arrives

---

#### 4b — Create the Worker

1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com)
2. In the left sidebar click **Workers & Pages**
3. Click the **Create** button (top right)
4. Click **Create Worker**
5. Change the auto-generated name to `church-giving-api`
6. Click **Deploy** (ignore the default code for now — you will replace it next)

---

#### 4c — Paste your Worker code

After clicking Deploy you land on the Worker overview page.

1. Click **Edit Code** (top right)
2. You will see a code editor with some default Hello World code
3. **Select all of it and delete it** (Ctrl+A then Delete)
4. Get the code from your GitHub repo:
   - Go to your repo on GitHub
   - Click the `worker` folder → `src` folder → `index.js`
   - Click the **Raw** button (top right of the file view)
   - Select all the text (Ctrl+A) and copy it (Ctrl+C)
5. Paste it into the Cloudflare code editor
6. Click **Save and Deploy** (top right of the editor)

Your Worker is now live. You will see its URL at the top of the page — it looks like:
```
https://church-giving-api.YOUR_SUBDOMAIN.workers.dev
```
**Copy this URL — you will need it in the next two sub-steps.**

---

#### 4d — Add environment variables (non-secret config)

1. Click the **Settings** tab on your Worker page
2. Scroll down to find **Variables and Secrets**
3. Click **Add** under the Variables section and add all four of these:

| Variable name | Value |
|---|---|
| `CHURCH_NAME` | Your church name e.g. `Beacon of Light Church` |
| `FRONTEND_BASE_URL` | Your GitHub Pages URL e.g. `https://danyankho.github.io/church-giving` |
| `MIN_AMOUNT` | `500` |
| `WORKER_BASE_URL` | The Worker URL you copied above e.g. `https://church-giving-api.xyz.workers.dev` |

4. Click **Save and deploy** after adding all four

---

#### 4e — Add secrets (sensitive values)

Still on the same **Variables and Secrets** page, add each of these as a **Secret** (not a plain variable). Secrets are encrypted and the value is never shown again after saving — that is intentional.

Click **Add** under the Secrets section for each one:

| Secret name | Where to get the value |
|---|---|
| `PAYCHANGU_SECRET_KEY` | PayChangu dashboard → API Keys |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → `service_role` key |
| `GAS_EMAIL_URL` | Your GAS Email Service web app URL (from Step 3) |
| `GAS_EMAIL_SECRET` | The random secret string you set in `EmailService.gs` |
| `ADMIN_EMAIL` | The email address to receive all giving notifications |
| `TELEGRAM_BOT_TOKEN` | From @BotFather on Telegram |
| `TELEGRAM_ADMIN_CHAT_ID` | Your admin group or personal Telegram chat ID |

Click **Save and deploy** after adding all secrets.

---

#### 4f — Verify it is working

Open a new browser tab and visit:
```
https://church-giving-api.YOUR_SUBDOMAIN.workers.dev/api/categories
```

You should see a response like:
```json
{
  "success": true,
  "church_name": "Beacon of Light Church",
  "giving_types": [...]
}
```

If you see that — your Worker is live, your secrets are loaded, and the backend is ready. If you see an error instead, go back to Variables and Secrets and confirm every value was saved.

---

### Step 5 — Update the frontend

1. Open `frontend/assets/form.js`
2. Update line 8:
   ```js
   var API_BASE = "https://church-giving-api.YOUR_SUBDOMAIN.workers.dev";
   ```
3. Open `frontend/index.html` and update the church name in `<h1>` and `<title>`
4. Do the same in `success.html` and `failed.html`

---

### Step 6 — Set up GitHub Actions (auto-deploy)

1. In your GitHub repo → **Settings → Secrets and variables → Actions**
2. Add a new secret:
   - Name: `CLOUDFLARE_API_TOKEN`
   - Value: Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Use **"Edit Cloudflare Workers"** template
3. Enable GitHub Pages: **Settings → Pages → Source: GitHub Actions**
4. Push to `main` — both the Worker and Pages will deploy automatically

---

### Step 7 — Configure PayChangu webhook

In your PayChangu dashboard, set the webhook URL to:
```
https://church-giving-api.YOUR_SUBDOMAIN.workers.dev/api/webhook
```

---

### Step 8 — Test

Run through the full test checklist:

- [ ] `GET https://your-worker.workers.dev/api/categories` returns JSON with giving types
- [ ] Giving form loads on GitHub Pages with no console errors
- [ ] Submitting the form redirects to PayChangu payment page
- [ ] Completing a test payment creates a row in Supabase `transactions` table
- [ ] Admin receives email within 60 seconds
- [ ] Admin receives Telegram notification
- [ ] Donor receives receipt email (if email given)
- [ ] Cancelling payment shows `failed.html`

---

## Environment Variables Reference

| Variable | Where to get it | Secret? |
|----------|----------------|---------|
| `CHURCH_NAME` | Your choice | No — set in wrangler.toml |
| `FRONTEND_BASE_URL` | Your GitHub Pages URL | No — set in wrangler.toml |
| `MIN_AMOUNT` | Your choice (default 500) | No — set in wrangler.toml |
| `WORKER_BASE_URL` | Your Worker URL after deploy | Yes — wrangler secret |
| `PAYCHANGU_SECRET_KEY` | PayChangu dashboard | Yes — wrangler secret |
| `SUPABASE_URL` | Supabase project settings | Yes — wrangler secret |
| `SUPABASE_SERVICE_KEY` | Supabase project settings | Yes — wrangler secret |
| `GAS_EMAIL_URL` | GAS Web App URL (Step 3) | Yes — wrangler secret |
| `GAS_EMAIL_SECRET` | Random string you set in EmailService.gs | Yes — wrangler secret |
| `ADMIN_EMAIL` | Your admin email address | Yes — wrangler secret |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram | Yes — wrangler secret |
| `TELEGRAM_ADMIN_CHAT_ID` | Telegram getUpdates API | Yes — wrangler secret |

---

## Troubleshooting

**CORS errors** → Should not happen with Cloudflare Workers. If they do, check that your Worker URL in `form.js` matches exactly.

**"Failed to fetch"** → Check that the Worker is deployed and the URL in `API_BASE` is correct.

**No database entries** → Check `error_log` table in Supabase. Check Worker logs: `npx wrangler tail` in the `worker/` directory.

**No emails** → Confirm `RESEND_API_KEY` secret was set. Check Resend dashboard for delivery logs.

**Worker logs (live):**
```bash
cd worker && npx wrangler tail
```
This streams live logs from your deployed Worker — very useful for debugging webhooks.
