const supabase = require("./supabase");
const { fetchRecentTweets, generateReply } = require("./clients");

const COLORS = ["#d97064","#4a8fd4","#5a9a5a","#8b71c7","#d4943e","#c04040","#4aa88a","#d4703e"];

async function poll() {
  console.log("[Poll] Starting sweep…");

  // Load watchlist and settings from Supabase
  const [{ data: accounts }, { data: settingsRows }] = await Promise.all([
    supabase.from("watchlist").select("*").order("created_at"),
    supabase.from("settings").select("*").eq("id", 1).single(),
  ]);

  if (!accounts?.length) {
    console.log("[Poll] Watchlist is empty — nothing to check.");
    return;
  }

  const settings = settingsRows || {
    brand_voice: "Professional but conversational. Keep replies under 280 characters.",
    tone: "Conversational",
    max_length: 280,
    include_question: true,
  };

  for (const account of accounts) {
    const tweets = await fetchRecentTweets(account.handle);

    for (const tweet of tweets) {
      // Check if we've already seen this tweet
      const { data: existing } = await supabase
        .from("seen_tweets")
        .select("tweet_id")
        .eq("tweet_id", tweet.id)
        .maybeSingle();

      if (existing) continue;

      // Mark as seen immediately to avoid race conditions
      await supabase.from("seen_tweets").insert({ tweet_id: tweet.id });

      console.log(`[Poll] New tweet from @${account.handle}: "${tweet.text.slice(0, 60)}…"`);

      try {
        const replyText = await generateReply(tweet.text, account.handle, settings);

        await supabase.from("replies").insert({
          tweet_id:       tweet.id,
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
        console.error(`[Claude] Generation failed:`, err.message);
      }
    }
  }

  console.log("[Poll] Sweep done.");
}

module.exports = { poll, COLORS };
