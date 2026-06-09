const supabase = require("./supabase");

// ── Middleware: verify Supabase session token on every request ─
async function requireAuth(req, res, next) {
  // Public routes — no auth needed
  const publicPaths = ["/health", "/login", "/register", "/api/auth/login", "/api/auth/register"];
  if (publicPaths.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }

  const token = req.headers["authorization"]?.replace("Bearer ", "") ||
                req.cookies?.amp_token;

  if (!token) {
    // HTML request → redirect to login
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Verify token with Supabase
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  req.user = user;
  next();
}

module.exports = requireAuth;
