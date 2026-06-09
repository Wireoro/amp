require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const path        = require("path");
const cron        = require("node-cron");

const supabase    = require("./supabase");
const requireAuth = require("./auth");
const { postReply, generateReply, fetchProfile } = require("./clients");
const { poll, COLORS } = require("./poller");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  Polling schedule
// ─────────────────────────────────────────────────────────────
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || "5", 10);
cron.schedule(`*/${INTERVAL} * * * *`, poll);
poll();

function ok(res, data)             { res.json({ success: true, ...data }); }
function err(res, msg, status=500) { res.status(status).json({ error: msg }); }

// ─────────────────────────────────────────────────────────────
//  FULLY PUBLIC — served BEFORE auth middleware
// ─────────────────────────────────────────────────────────────

// Health check for UptimeRobot
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// Login page — must be public, no token yet
app.get("/login",    (req, res) => res.sendFile(path.join(__dirname, "../public/login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "../public/login.html")));

// Auth API routes — no token needed
app.post("/api/auth/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return err(res, "email, password and name are required", 400);
  if (password.length < 6) return err(res, "Password must be at least 6 characters", 400);

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) return err(res, error.message, 400);

  const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) return err(res, signInErr.message, 400);

  ok(res, {
    access_token: session.session.access_token,
    user: { email: data.user.email, name },
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return err(res, "email and password required", 400);

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
//  AUTH WALL — everything below requires a valid session
// ─────────────────────────────────────────────────────────────
app.use(requireAuth);

// Protected static files (dashboard)
app.use(express.static(path.join(__dirname, "../public")));

// ─────────────────────────────────────────────────────────────
//  REPLIES
// ─────────────────────────────────────────────────────────────
app.get("/api/replies", async (req, res) => {
  const { data, error } = await supabase.from("replies").select("*").order("created_at", { ascending: false });
  if (error) return err(res, error.message);
  res.json(data);
});

app.patch("/api/replies/:id/approve", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: reply, error: fetchErr } = await supabase.from("replies").select("*").eq("id", id).single();
  if (fetchErr || !reply) return err(res, "Reply not found", 404);
  if (reply.status !== "pending") return err(res, "Already actioned", 400);
  const replyText = req.body.replyText?.trim() || reply.reply_text;
  try { await postReply(replyText, reply.tweet_id); } catch(e) { return err(res, "Failed to post to X: " + e.message); }
  const { data: updated, error: updateErr } = await supabase.from("replies")
    .update({ status:"approved", reply_text:replyText, actioned_at:new Date().toISOString() })
    .eq("id", id).select().single();
  if (updateErr) return err(res, updateErr.message);
  ok(res, { reply: updated });
});

app.patch("/api/replies/:id/dismiss", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: updated, error } = await supabase.from("replies")
    .update({ status:"dismissed", actioned_at:new Date().toISOString() })
    .eq("id", id).select().single();
  if (error) return err(res, error.message);
  ok(res, { reply: updated });
});

app.patch("/api/replies/:id/regenerate", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { data: reply, error: fetchErr } = await supabase.from("replies").select("*").eq("id", id).single();
  if (fetchErr || !reply) return err(res, "Reply not found", 404);
  const { data: settings } = await supabase.from("settings").select("*").eq("id", 1).single();
  try {
    const newText = await generateReply(reply.tweet_text, reply.account_handle, settings);
    const { data: updated, error: updateErr } = await supabase.from("replies")
      .update({ reply_text: newText }).eq("id", id).select().single();
    if (updateErr) return err(res, updateErr.message);
    ok(res, { reply: updated });
  } catch(e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────
//  WATCHLIST
// ─────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  const { data, error } = await supabase.from("watchlist").select("*").order("created_at");
  if (error) return err(res, error.message);
  res.json(data);
});

app.post("/api/accounts", async (req, res) => {
  const handle = req.body.handle?.replace(/^@/, "").toLowerCase();
  if (!handle) return err(res, "handle required", 400);
  const { data: existing } = await supabase.from("watchlist").select("id").eq("handle", handle).maybeSingle();
  if (existing) return err(res, "Already in watchlist", 409);
  const { data: countRows } = await supabase.from("watchlist").select("id");
  const colorIndex = (countRows?.length || 0) % COLORS.length;
  const displayName = await fetchProfile(handle);
  const { data: account, error: insertErr } = await supabase.from("watchlist")
    .insert({ name:displayName, handle, initials:displayName.slice(0,2).toUpperCase(), color:COLORS[colorIndex] })
    .select().single();
  if (insertErr) return err(res, insertErr.message);
  ok(res, { account });
});

app.delete("/api/accounts/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error } = await supabase.from("watchlist").delete().eq("id", id);
  if (error) return err(res, error.message);
  ok(res, {});
});

// ─────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).single();
  if (error) return err(res, error.message);
  res.json(data);
});

app.put("/api/settings", async (req, res) => {
  const allowed = ["brand_voice","tone","max_length","include_question"];
  const patch = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await supabase.from("settings").update(patch).eq("id", 1).select().single();
  if (error) return err(res, error.message);
  ok(res, { settings: data });
});

// ─────────────────────────────────────────────────────────────
//  MANUAL POLL
// ─────────────────────────────────────────────────────────────
app.post("/api/poll", (req, res) => { poll(); ok(res, { message: "Poll triggered" }); });

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Twitter AMP → http://localhost:${PORT}`);
  console.log(`  Polling every ${INTERVAL} min\n`);
});
