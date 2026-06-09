const supabase = require("./supabase");
const { fetchTweetsForAccounts, generateReply } = require("./clients");

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

  // ── Build a lookup map: handle → account row ─────────────────
  const accountMap = {};
  accounts.forEach(a => { accountMap[a.handle.toLowerCase()] = a; });

  // ── ONE batch fetch for all accounts ─────────────────────────
  const handles = accounts.map(a => a.handle);
  const allTweets = await fetchTweetsForAccounts(handles);

  console.log(`[Poll] ${allTweets.length} total tweets across ${accounts.length} accounts`);

  // ── Build set of already-seen tweet IDs ──────────────────────
  const { data: seenRows } = await supabase.from("seen_tweets").select("tweet_id");
  const seenIds = new Set((seenRows || []).map(r => r.tweet_id));

  // ── Process only new tweets ───────────────────────────────────
  const newTweets = allTweets.filter(t => !seenIds.has(String(t.id)));
  console.log(`[Poll] ${newTweets.length} new tweet(s) to process`);

  for (const tweet of newTweets) {
    const tweetId = String(tweet.id);
    // GetXAPI returns author info in tweet.author.userName
    const handle = tweet.author?.userName?.toLowerCase();
    const account = accountMap[handle];

    if (!account) continue; // tweet from someone not in watchlist (shouldn't happen)

    // Mark seen immediately
    await supabase.from("seen_tweets").insert({ tweet_id: tweetId });

    // ── First-time accounts: just set bookmark, don't reply ──────
    if (!account.last_tweet_id) {
      await supabase.from("watchlist").update({ last_tweet_id: tweetId }).eq("id", account.id);
      account.last_tweet_id = tweetId; // update local copy
      console.log(`[Poll] @${handle} — first seen, bookmark set`);
      continue;
    }

    console.log(`[Poll] New tweet from @${handle}: "${tweet.text?.slice(0, 60)}…"`);

    try {
      const replyText = await generateReply(tweet.text, handle, cfg);

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

      // Update bookmark
      await supabase.from("watchlist").update({ last_tweet_id: tweetId }).eq("id", account.id);
      console.log(`[Claude] Draft ready for @${handle}`);
    } catch (err) {
      console.error(`[Claude] Failed for @${handle}:`, err.message);
    }
  }

  console.log("[Poll] Sweep done.");
}

module.exports = { poll, COLORS };
