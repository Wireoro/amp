const supabase = require("./supabase");
const { fetchTweetsForAccounts, generateReply } = require("./clients");

const COLORS = ["#d97064","#4a8fd4","#5a9a5a","#8b71c7","#d4943e","#c04040","#4aa88a","#d4703e"];

let isPolling = false;

async function poll() {
  if (isPolling) { console.log("[Poll] Already running, skipping."); return; }
  isPolling = true;
  console.log("[Poll] Starting sweep…");

  const { data: allAccounts } = await supabase
    .from("watchlist").select("*").is("archived_at", null).order("created_at");

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

    // ── Top 50% filter ────────────────────────────────────────
    // Score = (views ÷ seconds_since_posted) + (likes × 5)
    // Mark all as seen first, then only generate drafts for top half
    function tweetScore(tweet) {
      const seconds = Math.max(1, (Date.now() - new Date(tweet.createdAt || Date.now())) / 1000);
      const velocity = (tweet.viewCount || 0) / seconds;
      return velocity + ((tweet.likeCount || 0) * 5);
    }

    // Separate first-seen tweets (need bookmark) from candidates
    const firstSeen = newTweets.filter(t => {
      const handle = t.author?.userName?.toLowerCase();
      const account = accountMap[handle];
      return account && !account.last_tweet_id;
    });
    const candidates = newTweets.filter(t => {
      const handle = t.author?.userName?.toLowerCase();
      const account = accountMap[handle];
      return account && account.last_tweet_id;
    });

    // Sort candidates by score and keep top 50%
    candidates.sort((a, b) => tweetScore(b) - tweetScore(a));
    const cutoff   = Math.ceil(candidates.length / 2);
    const topHalf  = candidates.slice(0, cutoff);
    const discarded = candidates.slice(cutoff);

    console.log(`[Poll] Filter: ${candidates.length} candidates → top 50% = ${topHalf.length} drafts, ${discarded.length} discarded`);

    // ── Record daily stats (upsert + increment) ───────────────
    // trulyNew = tweets not previously seen today (unique new tweets only)
    const trulyNew = allTweets.filter(t => !seenIds.has(String(t.id)));
    if (trulyNew.length > 0 || discarded.length > 0 || topHalf.length > 0) {
      const today = new Date().toISOString().split("T")[0];
      await supabase.from("daily_stats")
        .upsert({ user_id: userId, date: today, fetched: 0, filtered: 0, selected: 0 },
          { onConflict: "user_id,date", ignoreDuplicates: true });
      const { data: stat } = await supabase.from("daily_stats")
        .select("fetched, filtered, selected").eq("user_id", userId).eq("date", today).single();
      if (stat) {
        await supabase.from("daily_stats").update({
          fetched:  (stat.fetched  || 0) + trulyNew.length,  // unique new tweets only
          filtered: (stat.filtered || 0) + discarded.length,
          selected: (stat.selected || 0) + topHalf.length,
        }).eq("user_id", userId).eq("date", today);
      }
    }

    // Mark discarded tweets as seen so they don't reappear
    for (const tweet of discarded) {
      await supabase.from("seen_tweets").insert({ user_id: userId, tweet_id: String(tweet.id) }).select();
      const handle = tweet.author?.userName?.toLowerCase();
      const account = accountMap[handle];
      if (account) await supabase.from("watchlist").update({ last_tweet_id: String(tweet.id) }).eq("id", account.id);
    }

    // Process: first-seen bookmarks + top half drafts
    for (const tweet of [...firstSeen, ...topHalf]) {
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
        const tweetCreatedAt = tweet.createdAt ? new Date(tweet.createdAt).toISOString() : null;
        // Extract first image URL if tweet has photos
        const tweetImageUrl = tweet.photos?.[0]?.url || tweet.photos?.[0] || null;
        await supabase.from("replies").insert({
          user_id:          userId,
          tweet_id:         tweetId,
          account_handle:   account.handle,
          account_name:     account.name,
          initials:         account.initials,
          color:            account.color,
          tweet_text:       tweet.text,
          reply_text:       replyText,
          status:           "pending",
          tweet_created_at: tweetCreatedAt,
          like_count:       tweet.likeCount   || 0,
          view_count:       tweet.viewCount   || 0,
          tweet_image_url:  tweetImageUrl,
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
  isPolling = false;
}

module.exports = { poll, COLORS };
