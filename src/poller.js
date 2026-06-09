const supabase = require("./supabase");
const { fetchRecentTweets, generateReply } = require("./clients");

const COLORS = ["#d97064","#4a8fd4","#5a9a5a","#8b71c7","#d4943e","#c04040","#4aa88a","#d4703e"];

// Only process tweets posted after this server boot time
const SERVER_START = new Date();
console.log(`[Poll] Server started at ${SERVER_START.toISOString()} — only tweets after this will be processed.`);

async function poll() {
  console.log("[Poll] Starting sweep…");

  const [{ data: accounts }, { data: settings }] = await Promise.all([
    supabase.from("watchlist").select("*").order("created_at"),
    supabase.from("settings").select("*").eq("id", 1).single(),
  ]);

  if (!accounts?.length) {
    console.log("[Poll] Watchlist is empty.");
    return;
  }

  const cfg = settings || {
    brand_voice: "Professional but conversational. Keep replies under 280 characters.",
    tone: "Conversational",
    max_length: 280,
    include_question: true,
  };

  for (const account of accounts) {
    const tweets = await fetchRecentTweets(account.handle);
    console.log(`[Poll] @${account.handle} → ${tweets.length} tweets fetched`);

    for (const tweet of tweets) {
      const tweetId = String(tweet.id);

      // ── Only process tweets posted AFTER server boot ──────────
      // GetXAPI returns createdAt as "Sun Jan 25 13:05:46 +0000 2026"
      const tweetDate = new Date(tweet.createdAt);
      if (isNaN(tweetDate) || tweetDate < SERVER_START) {
        continue; // skip old tweets
      }

      // ── Skip if already seen ──────────────────────────────────
      const { data: existing } = await supabase
        .from("seen_tweets")
        .select("tweet_id")
        .eq("tweet_id", tweetId)
        .maybeSingle();

      if (existing) continue;

      // Mark seen immediately to avoid duplicates
      await supabase.from("seen_tweets").insert({ tweet_id: tweetId });

      console.log(`[Poll] New tweet from @${account.handle} at ${tweetDate.toISOString()}: "${tweet.text?.slice(0, 60)}…"`);

      try {
        const replyText = await generateReply(tweet.text, account.handle, cfg);

        await supabase.from("replies").insert({
          tweet_id:       tweetId,
          account_handle: account.handle,
          account_name:   account.name,
          initials:       account.initials,
          color:          account.color,
          tweet_text:     tweet.text,
          reply_text:     replyText,
          status:         "pending",
        });

        console.log(`[Claude] Draft ready for @${account.handle}`);
      } catch (err) {
        console.error(`[Claude] Failed:`, err.message);
      }
    }
  }

  console.log("[Poll] Sweep done.");
}

module.exports = { poll, COLORS };
