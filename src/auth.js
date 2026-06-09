const supabase = require("./supabase");

async function requireAuth(req, res, next) {
  const token = req.headers["authorization"]?.replace("Bearer ", "");

  if (!token) {
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  req.user = user;
  next();
}

module.exports = requireAuth;
