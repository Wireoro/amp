const supabase = require("./supabase");

// Only protect API routes — HTML pages are handled client-side
async function requireAuth(req, res, next) {
  // Only run on /api routes — let all HTML pages through
  if (!req.path.startsWith("/api/")) return next();

  // Skip public API routes
  const publicApi = ["/api/auth/login", "/api/auth/register", "/api/auth/logout"];
  if (publicApi.includes(req.path)) return next();

  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid or expired session" });

  req.user = user;
  next();
}

module.exports = requireAuth;
