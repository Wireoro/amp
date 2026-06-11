require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const path        = require("path");
const cron        = require("node-cron");

const supabase    = require("./supabase");
const requireAuth = require("./auth");
const { generateReply, fetchProfile } = require("./clients");
const { poll, COLORS } = require("./poller");

const app = express();
app.use(cors());
app.use(express.json());
app.use(requireAuth);

// ─────────────────────────────────────────────────────────────
//  Smart polling — Paris time (UTC+2 summer)
//  00:00–11:00 Paris → no calls
//  11:00–14:00 Paris → every 15 min
//  14:00–23:30 Paris → every 10 min
//  23:30–00:00 Paris → no calls
// ─────────────────────────────────────────────────────────────
function parisHour() {
  const now = new Date();
  return (now.getUTCHours() + 2) % 24;
}
function parisMinute() {
  return new Date().getUTCMinutes();
}
function shouldPollNow(min) {
  const h = parisHour();
  const m = parisMinute();
  const totalMins = h * 60 + m;
  const start15 = 11 * 60;
  const start10 = 14 * 60;
  const end     = 23 * 60 + 30;
  if (totalMins < start15) return false;
  if (totalMins >= end)    return false;
  if (totalMins < start10) return min % 15 === 0;
  return min % 10 === 0;
}

cron.schedule("* * * * *", () => {
  const min = new Date().getUTCMinutes();
  if (shouldPollNow(min)) {
    const h = parisHour();
    const m = parisMinute();
    const total = h * 60 + m;
    const label = total < 14*60 ? "11:00–14:00 (15min)" : "14:00–23:30 (10min)";
    console.log(`[Poll] Triggered — Paris ${h}:${String(m).padStart(2,"0")} — ${label}`);
    poll();
  }
});

poll();

function ok(res, data)             { res.json({ success: true, ...data }); }
function err(res, msg, status=500) { res.status(status).json({ error: msg }); }

// ─────────────────────────────────────────────────────────────
//  HTML
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));
app.get("/login",  (req, res) => res.sendFile(path.join(__dirname, "../views/login.html")));
app.use(express.static(path.join(__dirname, "../public")));

// ─────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return err(res, "All fields required", 400);
  if (password.length < 6) return err(res, "Password must be at least 6 characters", 400);
  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) return err(res, error.message, 400);
  await supabase.from("settings").insert({
    user_id: data.user.id,
    brand_voice: "Professional but conversational. Sharp and insight-driven.",
    tone: "Conversational", max_length: 280, include_question: true,
  });
  const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) return err(res, signInErr.message, 400);
  ok(res, { access_token: session.session.access_token, user: { email, name } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return err(res, "Email and password required", 400);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return err(res, "Invalid email or password", 401);
  ok(res, {
    access_token: data.session.access_token,
    user: { email: data.user.email, name: data.user.user_metadata?.full_name },
  });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (token) { try { await supabase.auth.admin.signOut(token); } catch(_) {} }
  ok(res, {});
});

// ─────────────────────────────────────────────────────────────
//  REPLIES
// ─────────────────────────────────────────────────────────────
app.get("/api/replies", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const { data, error } = await supabase.from("replies")
    .select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (error) return err(res, error.message);
  res.json(data);
});

app.patch("/api/replies/:id/dismiss", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const id = parseInt(req.params.id, 10);
  const { data: updated, error } = await supabase.from("replies")
    .update({ status:"dismissed", actioned_at:new Date().toISOString() })
    .eq("id", id).eq("user_id", req.user.id).select().single();
  if (error) return err(res, error.message);
  ok(res, { reply: updated });
});

app.patch("/api/replies/:id/regenerate", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const id = parseInt(req.params.id, 10);
  const { data: reply, error: fetchErr } = await supabase.from("replies")
    .select("*").eq("id", id).eq("user_id", req.user.id).single();
  if (fetchErr || !reply) return err(res, "Reply not found", 404);
  const { data: settings } = await supabase.from("settings")
    .select("*").eq("user_id", req.user.id).single();
  try {
    const newText = await generateReply(reply.tweet_text, reply.account_handle, settings);
    const { data: updated, error: upErr } = await supabase.from("replies")
      .update({ reply_text: newText }).eq("id", id).select().single();
    if (upErr) return err(res, upErr.message);
    ok(res, { reply: updated });
  } catch(e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────
//  WATCHLIST
// ─────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const showArchived = req.query.archived === "true";
  let q = supabase.from("watchlist").select("*").eq("user_id", req.user.id).order("created_at");
  if (!showArchived) q = q.is("archived_at", null);
  const { data, error } = await q;
  if (error) return err(res, error.message);
  res.json(data);
});

app.post("/api/accounts", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const handle = req.body.handle?.replace(/^@/, "").toLowerCase();
  if (!handle) return err(res, "handle required", 400);
  const { data: existing } = await supabase.from("watchlist")
    .select("id, archived_at").eq("handle", handle).eq("user_id", req.user.id).maybeSingle();
  if (existing && !existing.archived_at) return err(res, "Already in watchlist", 409);
  if (existing?.archived_at) {
    const { data: account } = await supabase.from("watchlist")
      .update({ archived_at: null, last_tweet_id: null })
      .eq("id", existing.id).select().single();
    return ok(res, { account });
  }
  const { data: countRows } = await supabase.from("watchlist")
    .select("id").eq("user_id", req.user.id).is("archived_at", null);
  const colorIndex = (countRows?.length || 0) % COLORS.length;
  const displayName = await fetchProfile(handle);
  const { data: account, error: insertErr } = await supabase.from("watchlist")
    .insert({ user_id:req.user.id, name:displayName, handle, initials:displayName.slice(0,2).toUpperCase(), color:COLORS[colorIndex] })
    .select().single();
  if (insertErr) return err(res, insertErr.message);
  ok(res, { account });
});

app.delete("/api/accounts/:id", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const id = parseInt(req.params.id, 10);
  const { error } = await supabase.from("watchlist")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", req.user.id);
  if (error) return err(res, error.message);
  ok(res, {});
});

// ─────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  let { data, error } = await supabase.from("settings")
    .select("*").eq("user_id", req.user.id).single();
  if (error || !data) {
    const { data: created } = await supabase.from("settings").insert({
      user_id: req.user.id,
      brand_voice: "Professional but conversational. Keep replies under 280 characters.",
      tone: "Conversational", max_length: 280, include_question: true,
    }).select().single();
    data = created;
  }
  res.json(data);
});

app.put("/api/settings", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const allowed = ["brand_voice","max_length","include_question","max_replies_per_hour"];
  const patch = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await supabase.from("settings")
    .update(patch).eq("user_id", req.user.id).select().single();
  if (error) return err(res, error.message);
  ok(res, { settings: data });
});

app.post("/api/poll", (req, res) => { poll(); ok(res, { message: "Poll triggered" }); });

// ─────────────────────────────────────────────────────────────
//  ANALYTICS
// ─────────────────────────────────────────────────────────────
app.get("/api/analytics", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows } = await supabase.from("replies")
    .select("status, account_handle, created_at, actioned_at")
    .eq("user_id", req.user.id).gte("created_at", since).order("created_at", { ascending: true });

  if (!rows) return ok(res, { daily: [], accounts: [] });

  const { data: archivedAccounts } = await supabase.from("watchlist")
    .select("handle, archived_at").eq("user_id", req.user.id).not("archived_at", "is", null);
  const archivedSet = new Set((archivedAccounts || []).map(a => a.handle.toLowerCase()));

  const dailyMap = {};
  rows.forEach(r => {
    const day = r.created_at.split("T")[0];
    if (!dailyMap[day]) dailyMap[day] = { date: day, generated: 0, approved: 0, dismissed: 0, posted: 0 };
    dailyMap[day].generated++;
    if (r.status === "approved")  dailyMap[day].approved++;
    if (r.status === "dismissed") dailyMap[day].dismissed++;
  });
  rows.forEach(r => {
    if (r.status === "approved" && r.actioned_at) {
      const day = r.actioned_at.split("T")[0];
      if (!dailyMap[day]) dailyMap[day] = { date: day, generated: 0, approved: 0, dismissed: 0, posted: 0 };
      dailyMap[day].posted = (dailyMap[day].posted || 0) + 1;
    }
  });
  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  const postedMap = {};
  rows.filter(r => r.status === "approved" && r.actioned_at).forEach(r => {
    const day = r.actioned_at.split("T")[0];
    postedMap[day] = (postedMap[day] || 0) + 1;
  });
  const postedByDay = Object.entries(postedMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const { data: watchlistRows } = await supabase.from("watchlist")
    .select("handle, name, initials, color, archived_at").eq("user_id", req.user.id);
  const watchlistMap = {};
  (watchlistRows || []).forEach(w => { watchlistMap[w.handle.toLowerCase()] = w; });

  const accountMap = {};
  rows.forEach(r => {
    const h = r.account_handle;
    const wl = watchlistMap[h.toLowerCase()] || {};
    if (!accountMap[h]) accountMap[h] = {
      handle: h, name: wl.name || h, initials: wl.initials || h.slice(0,2).toUpperCase(),
      color: wl.color || "#888", generated: 0, approved: 0, dismissed: 0, pending: 0,
      archived: archivedSet.has(h.toLowerCase())
    };
    accountMap[h].generated++;
    if (r.status === "approved")  accountMap[h].approved++;
    if (r.status === "dismissed") accountMap[h].dismissed++;
    if (r.status === "pending")   accountMap[h].pending++;
  });
  const accounts = Object.values(accountMap).sort((a, b) => b.generated - a.generated).slice(0, 20);

  const total        = rows.length;
  const approved     = rows.filter(r => r.status === "approved").length;
  const dismissed    = rows.filter(r => r.status === "dismissed").length;
  const approvalRate = total > 0 ? Math.round((approved / (approved + dismissed || 1)) * 100) : 0;

  const { data: fetchStats } = await supabase.from("daily_stats")
    .select("date, fetched, filtered, selected").eq("user_id", req.user.id)
    .gte("date", since.split("T")[0]).order("date", { ascending: true });

  const today = new Date().toISOString().split("T")[0];
  const todayStat     = (fetchStats || []).find(s => s.date === today) || { fetched: 0, filtered: 0, selected: 0 };
  const todayReplied  = rows.filter(r => r.status === "approved"  && r.created_at?.startsWith(today)).length;
  const todayDismissed= rows.filter(r => r.status === "dismissed" && r.created_at?.startsWith(today)).length;
  const funnel = {
    fetched: todayStat.fetched, filtered: todayStat.filtered, selected: todayStat.selected,
    replied: todayReplied, dismissed: todayDismissed,
  };

  ok(res, { daily, accounts, summary: { total, approved, dismissed, approvalRate }, fetchStats: fetchStats || [], funnel, postedByDay });
});

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Draftillery → http://localhost:${PORT}`);
  console.log(`  Paris schedule: silent 00-11, 15min 11-14, 10min 14-23:30\n`);
});
