const supabase = require("./supabase");
const { fetchTweetsForAccounts, generateReply } = require("./clients");

const COLORS = ["#d97064","#4a8fd4","#5a9a5a","#8b71c7","#d4943e","#c04040","#4aa88a","#d4703e"];

async function poll() {
  console.log("[Poll] Starting sweep…");

  const { data: allAccounts } = await supabase
    .from("watchlist").select("*").order("created_at");

  if (!allAccounts?.length) { console.log("[Poll] No accounts."); return; }

  // Group accounts by user_id — each user processed independently
  const byUser = {};
  allAccounts.forEach(a => {
    if (!byUser[a.user_id]) byUser[a.user_id] = [];
    byUser[a.user_id].push(a);
  });

  for (const userId of Object.keys(byUser)) {
    const accounts = byUser[userId];

    // Get this user's settings
    const { data: settings } = await supabase.from("settings")
      .select("*").eq("user_id", userId).single();

    const cfg = settings || {
      brand_voice: "Professional but conversational. Keep replies under 280 characters.",
      tone: "Conversational", max_length: 280, include_question: true,
    };

    // Batch fetch tweets for this user's watchlist
    const handles = accounts.map(a => a.handle);
    const allTweets = await fetchTweetsForAccounts(handles);

    // Build handle → account lookup
    const accountMap = {};
    accounts.forEach(a => { accountMap[a.handle.toLowerCase()] = a; });

    // Get seen tweet IDs for THIS user only
    const { data: seenRows } = await supabase.from("seen_tweets")
      .select("tweet_id").eq("user_id", userId);
    const seenIds = new Set((seenRows || []).map(r => r.tweet_id));

    const newTweets = allTweets.filter(t => !seenIds.has(String(t.id)));
    console.log(`[Poll] User ${userId.slice(0,8)}… → ${newTweets.length} new tweet(s)`);

    for (const tweet of newTweets) {
      const tweetId = String(tweet.id);
      const handle  = tweet.author?.userName?.toLowerCase();
      const account = accountMap[handle];
      if (!account) continue;

      // Mark seen for this user specifically
      await supabase.from("seen_tweets").insert({ user_id: userId, tweet_id: tweetId });

      if (!account.last_tweet_id) {
        await supabase.from("watchlist").update({ last_tweet_id: tweetId }).eq("id", account.id);
        console.log(`[Poll] @${handle} — first seen for user ${userId.slice(0,8)}…`);
        continue;
      }

      try {
        const replyText = await generateReply(tweet.text, handle, cfg);
        await supabase.from("replies").insert({
          user_id:        userId,
          tweet_id:       tweetId,
          account_handle: account.handle,
          account_name:   account.name,
          initials:       account.initials,
          color:          account.color,
          tweet_text:     tweet.text,
          reply_text:     replyText,
          status:         "pending",
        });
        await supabase.from("watchlist")
          .update({ last_tweet_id: tweetId }).eq("id", account.id);
        console.log(`[Claude] Draft ready for @${handle} → user ${userId.slice(0,8)}…`);
      } catch (err) {
        console.error(`[Claude] Failed:`, err.message);
      }
    }
  }

  console.log("[Poll] Sweep done.");
}

module.exports = { poll, COLORS };
