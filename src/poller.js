const supabase = require("./supabase");
const { fetchRecentTweets, generateReply } = require("./clients");

const COLORS = ["#d97064","#4a8fd4","#5a9a5a","#8b71c7","#d4943e","#c04040","#4aa88a","#d4703e"];

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
    console.log(`[Poll] @${account.handle} → ${tweets.length} tweets found`);

    for (const tweet of tweets) {
      // GetXAPI advanced_search returns tweet.id as string
      const tweetId = String(tweet.id);

      // Skip if already seen
      const { data: existing } = await supabase
        .from("seen_tweets")
        .select("tweet_id")
        .eq("tweet_id", tweetId)
        .maybeSingle();

      if (existing) continue;

      // Mark seen immediately
      await supabase.from("seen_tweets").insert({ tweet_id: tweetId });

      console.log(`[Poll] New tweet from @${account.handle}: "${tweet.text?.slice(0, 60)}…"`);

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
