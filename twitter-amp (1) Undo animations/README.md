# Twitter AMP

AI-powered Twitter/X reply outreach dashboard.
Watches accounts → fetches tweets via GetXAPI → Claude generates drafts → you approve → posts to X.

**Stack:** Node.js + Express · Supabase (Postgres) · Render (hosting) · Anthropic Claude Haiku · GetXAPI

---

## Architecture

```
Browser (dashboard UI)
       ↕  REST /api/*
Render — Express server       ← always-on, runs cron poll every 5 min
       ↕  SQL via supabase-js
Supabase — Postgres           ← watchlist · replies · settings · seen_tweets
       ↕
GetXAPI (read tweets + post)  +  Anthropic Claude API (generate drafts)
```

---

## Local dev setup

### 1. Install
```bash
npm install
```

### 2. Environment variables
```bash
cp .env.example .env
```
Fill in `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...          # console.anthropic.com
GETX_API_KEY=...                      # getxapi.com → dashboard
SUPABASE_URL=https://jbdxnyauuyfazxhitokf.supabase.co
SUPABASE_SERVICE_KEY=...              # supabase.com → project → Settings → API → service_role
POLL_INTERVAL_MINUTES=5
PORT=3000
```

### 3. Run
```bash
npm run dev    # auto-restarts on file changes
# or
npm start
```

Open http://localhost:3000

---

## Deploy to Render

1. **Push to GitHub**
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/YOUR_USER/twitter-amp.git
   git push -u origin main
   ```

2. **Create Web Service on Render**
   - Go to render.com → New → Web Service
   - Connect your GitHub repo
   - Render auto-detects `render.yaml` — settings are pre-filled

3. **Add secret env vars** (not in render.yaml for security)
   In Render dashboard → Environment:
   | Key | Value |
   |-----|-------|
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `GETX_API_KEY` | your GetXAPI key |
   | `SUPABASE_SERVICE_KEY` | service_role key from Supabase |

4. **Deploy** — Render builds and starts automatically. Your live URL will be:
   `https://twitter-amp.onrender.com`

> Use the **Starter ($7/mo)** plan — the free plan spins down after inactivity
> and the polling loop would stop running.

---

## Supabase

Project: `jbdxnyauuyfazxhitokf` (already migrated — tables are live)

Tables created:
- `watchlist` — accounts you're monitoring
- `replies` — tweet + AI draft + approval status
- `settings` — brand voice, tone, preferences (single row, id=1)
- `seen_tweets` — prevents double-processing across server restarts

To get your service_role key:
supabase.com → your project → Settings → API → **service_role** (secret)

---

## File structure

```
twitter-amp/
├── render.yaml          ← Render deploy config
├── package.json
├── .env.example
├── .gitignore
├── src/
│   ├── server.js        ← Express API routes
│   ├── poller.js        ← Cron loop: fetch tweets → generate replies
│   ├── clients.js       ← GetXAPI + Anthropic helpers
│   └── supabase.js      ← Supabase client singleton
└── public/
    └── index.html       ← Full dashboard UI
```

---

## Customising the Claude prompt

Open `src/clients.js` → `generateReply()`.
The system prompt is built from your Settings page in the UI — edit brand voice,
tone, max length, and include-question toggle there. Changes save to Supabase
and take effect on the next poll.
