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
app.use(requireAuth);

// ─────────────────────────────────────────────────────────────
//  Polling
// ─────────────────────────────────────────────────────────────
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MINUTES || "5", 10);
cron.schedule(`*/${INTERVAL} * * * *`, poll);
poll();

function ok(res, data)             { res.json({ success: true, ...data }); }
function err(res, msg, status=500) { res.status(status).json({ error: msg }); }

// ─────────────────────────────────────────────────────────────
//  HTML — all public, auth is client-side
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));
app.get("/login",  (req, res) => res.sendFile(path.join(__dirname, "../views/login.html")));
app.use(express.static(path.join(__dirname, "../public")));

// ─────────────────────────────────────────────────────────────
//  AUTH — public endpoints
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

  // Create a default settings row for this new user
  await supabase.from("settings").insert({
    user_id:          data.user.id,
    brand_voice:      "Professional but conversational. Sharp and insight-driven. Keep replies under 280 characters.",
    tone:             "Conversational",
    max_length:       280,
    include_question: true,
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
//  REPLIES — scoped to req.user.id
// ─────────────────────────────────────────────────────────────
app.get("/api/replies", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const { data, error } = await supabase.from("replies")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return err(res, error.message);
  res.json(data);
});

app.patch("/api/replies/:id/approve", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const id = parseInt(req.params.id, 10);
  const { data: reply, error: fetchErr } = await supabase.from("replies")
    .select("*").eq("id", id).eq("user_id", req.user.id).single();
  if (fetchErr || !reply) return err(res, "Reply not found", 404);
  if (reply.status !== "pending") return err(res, "Already actioned", 400);
  const replyText = req.body.replyText?.trim() || reply.reply_text;
  // Get this user's X auth_token from their settings
  const { data: userSettings } = await supabase.from("settings")
    .select("x_auth_token").eq("user_id", req.user.id).single();
  if (!userSettings?.x_auth_token) return err(res, "No Twitter account connected. Please add your auth_token in Settings.", 400);
  try { await postReply(replyText, reply.tweet_id, userSettings.x_auth_token); } catch(e) { return err(res, "Failed to post to X: " + e.message); }
  const { data: updated, error: upErr } = await supabase.from("replies")
    .update({ status:"approved", reply_text:replyText, actioned_at:new Date().toISOString() })
    .eq("id", id).select().single();
  if (upErr) return err(res, upErr.message);
  ok(res, { reply: updated });
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
//  WATCHLIST — scoped to req.user.id
// ─────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const { data, error } = await supabase.from("watchlist")
    .select("*").eq("user_id", req.user.id).order("created_at");
  if (error) return err(res, error.message);
  res.json(data);
});

app.post("/api/accounts", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const handle = req.body.handle?.replace(/^@/, "").toLowerCase();
  if (!handle) return err(res, "handle required", 400);
  const { data: existing } = await supabase.from("watchlist")
    .select("id").eq("handle", handle).eq("user_id", req.user.id).maybeSingle();
  if (existing) return err(res, "Already in watchlist", 409);
  const { data: countRows } = await supabase.from("watchlist")
    .select("id").eq("user_id", req.user.id);
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
    .delete().eq("id", id).eq("user_id", req.user.id);
  if (error) return err(res, error.message);
  ok(res, {});
});

// ─────────────────────────────────────────────────────────────
//  SETTINGS — scoped to req.user.id
// ─────────────────────────────────────────────────────────────
app.get("/api/settings", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  let { data, error } = await supabase.from("settings")
    .select("*").eq("user_id", req.user.id).single();
  // Auto-create settings row if missing (legacy accounts)
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
  const allowed = ["brand_voice","max_length","include_question"];
  const patch = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  const { data, error } = await supabase.from("settings")
    .update(patch).eq("user_id", req.user.id).select().single();
  if (error) return err(res, error.message);
  ok(res, { settings: data });
});

// ─────────────────────────────────────────────────────────────
//  TWITTER ACCOUNT CONNECTION
// ─────────────────────────────────────────────────────────────

// Save user's X auth_token and handle
app.put("/api/settings/twitter", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const { x_auth_token, x_handle } = req.body;
  if (!x_auth_token) return err(res, "auth_token required", 400);
  if (!x_handle) return err(res, "handle required", 400);

  const handle = x_handle.replace(/^@/, "").toLowerCase();

  const { data, error } = await supabase.from("settings")
    .update({ x_auth_token, x_handle: handle, updated_at: new Date().toISOString() })
    .eq("user_id", req.user.id).select().single();
  if (error) return err(res, error.message);
  ok(res, { handle });
});

// Get connection status (never return the actual token to browser)
app.get("/api/settings/twitter", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  const { data } = await supabase.from("settings")
    .select("x_handle, x_auth_token").eq("user_id", req.user.id).single();
  res.json({
    connected: !!data?.x_auth_token,
    handle:    data?.x_handle || null,
  });
});

// Disconnect Twitter account
app.delete("/api/settings/twitter", async (req, res) => {
  if (!req.user) return err(res, "Not authenticated", 401);
  await supabase.from("settings")
    .update({ x_auth_token: null, x_handle: null })
    .eq("user_id", req.user.id);
  ok(res, {});
});

app.post("/api/poll", (req, res) => { poll(); ok(res, { message: "Poll triggered" }); });

// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Twitter AMP → http://localhost:${PORT}`);
  console.log(`  Polling every ${INTERVAL} min\n`);
});
