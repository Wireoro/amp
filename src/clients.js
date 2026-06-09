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

// ── Fetch recent tweets for a handle ─────────────────────────
// Uses advanced_search with from:handle — the correct GetXAPI endpoint
async function fetchRecentTweets(handle) {
  try {
    const res = await xapi.get("/tweet/advanced_search", {
      params: {
        q: `from:${handle} -is:reply -is:retweet`,
        product: "Latest",
      },
    });
    // GetXAPI returns { tweets: [...] }
    return res.data?.tweets || [];
  } catch (err) {
    console.error(`[GetXAPI] tweets @${handle}:`, err.response?.data || err.message);
    return [];
  }
}

// ── Fetch profile name for a handle ──────────────────────────
async function fetchProfile(handle) {
  try {
    const res = await xapi.get("/user/info", { params: { userName: handle } });
    return res.data?.name || handle;
  } catch (_) {
    return handle;
  }
}

// ── Post a reply to X ─────────────────────────────────────────
async function postReply(replyText, tweetId) {
  const res = await xapi.post("/tweet/create", {
    text: replyText,
    reply: { in_reply_to_tweet_id: tweetId },
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

module.exports = { fetchRecentTweets, fetchProfile, postReply, generateReply };
