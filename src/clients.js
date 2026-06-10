const Anthropic = require("@anthropic-ai/sdk");
const axios = require("axios");

// ── Anthropic client ─────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GetXAPI client ───────────────────────────────────────────
const xapi = axios.create({
  baseURL: "https://api.getxapi.com/twitter",
  headers: { Authorization: `Bearer ${process.env.GETX_API_KEY}` },
  timeout: 15000,
});

// ── Get today's date string for the since: filter ─────────────
function sinceYesterday() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

// ── Fetch tweets from the last 24h for a batch of handles ─────
async function fetchTweetsForAccounts(handles) {
  const CHUNK_SIZE = 30;
  const allTweets = [];
  const since = sinceYesterday();

  for (let i = 0; i < handles.length; i += CHUNK_SIZE) {
    const chunk = handles.slice(i, i + CHUNK_SIZE);
    const query = chunk.map(h => `from:${h}`).join(" OR ");

    try {
      const res = await xapi.get("/tweet/advanced_search", {
        params: {
          q: `(${query}) -is:reply -is:retweet since:${since}`,
          product: "Latest",
        },
      });
      const tweets = res.data?.tweets || [];
      console.log(`[GetXAPI] Batch ${Math.floor(i/CHUNK_SIZE)+1}: ${tweets.length} tweets (last 24h) for ${chunk.length} accounts`);
      allTweets.push(...tweets);
    } catch (err) {
      console.error(`[GetXAPI] Batch fetch failed:`, err.response?.data || err.message);
    }
  }

  return allTweets;
}

// ── Fetch profile name for a single handle ────────────────────
async function fetchProfile(handle) {
  try {
    const res = await xapi.get("/user/info", { params: { userName: handle } });
    return res.data?.name || handle;
  } catch (_) {
    return handle;
  }
}

// ── Post a reply to X using the user's own auth_token ────────
async function postReply(replyText, tweetId, authToken) {
  if (!authToken) throw new Error("No X auth_token found. Please connect your Twitter account in Settings.");
  const res = await xapi.post("/tweet/create", {
    auth_token: authToken,
    text: replyText,
    reply_to_tweet_id: tweetId,
  });
  return res.data;
}

// ── Generate a reply with Claude ─────────────────────────────
async function generateReply(tweetText, authorHandle, settings) {
  const system = `You write Twitter/X replies on behalf of a user.

Brand voice:
${settings.brand_voice}

Rules:
- Tone: ${settings.tone}
- Maximum length: ${settings.max_length} characters — hard limit, never exceed it
- ${settings.include_question ? "End with a short genuine question to drive engagement." : "Do not add a question."}
- Never include URLs or hashtags
- Sound like a real thoughtful person, not a bot
- Output ONLY the reply text — no quotes, no preamble, nothing else`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system,
    messages: [
      {
        role: "user",
        content: `@${authorHandle} just tweeted:\n\n"${tweetText}"\n\nWrite a reply.`,
      },
    ],
  });

  return msg.content[0].text.trim();
}

module.exports = { fetchTweetsForAccounts, fetchProfile, postReply, generateReply };
