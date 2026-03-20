import fs from "fs";
import path from "path";

/**
 * Fetch recent misogyny-related posts from Reddit public JSON endpoints.
 * Saves to site/data/reddit.json for use by the landing page.
 *
 * Run before each deploy: npx ts-node --transpile-only scripts/fetch-reddit.ts
 */

const SUBREDDITS = [
  "NotHowGirlsWork",
  "BlatantMisogyny",
  "IncelTear",
  "WhereAreAllTheGoodMen",
];

const SEARCH_QUERIES = [
  "misogyny",
  "domestic violence women",
  "violence against women",
];

interface RedditPost {
  title: string;
  subreddit: string;
  score: number;
  url: string;
  created: number;
}

async function fetchSubreddit(sub: string): Promise<RedditPost[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${sub}/hot.json?limit=10`,
      { headers: { "User-Agent": "misogyny-exe-bot/1.0" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.data.children.map((c: any) => ({
      title: c.data.title,
      subreddit: c.data.subreddit,
      score: c.data.score,
      url: `https://reddit.com${c.data.permalink}`,
      created: c.data.created_utc,
    }));
  } catch {
    console.error(`Failed to fetch r/${sub}`);
    return [];
  }
}

async function searchReddit(query: string): Promise<RedditPost[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=10`,
      { headers: { "User-Agent": "misogyny-exe-bot/1.0" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.data.children.map((c: any) => ({
      title: c.data.title,
      subreddit: c.data.subreddit,
      score: c.data.score,
      url: `https://reddit.com${c.data.permalink}`,
      created: c.data.created_utc,
    }));
  } catch {
    console.error(`Failed to search: ${query}`);
    return [];
  }
}

async function main() {
  console.log("Fetching Reddit data...");

  const allPosts: RedditPost[] = [];

  for (const sub of SUBREDDITS) {
    const posts = await fetchSubreddit(sub);
    allPosts.push(...posts);
    console.log(`  r/${sub}: ${posts.length} posts`);
  }

  for (const q of SEARCH_QUERIES) {
    const posts = await searchReddit(q);
    allPosts.push(...posts);
    console.log(`  search "${q}": ${posts.length} posts`);
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = allPosts.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Sort by recency
  unique.sort((a, b) => b.created - a.created);

  const outDir = path.join(__dirname, "..", "site", "data");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "reddit.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({
      fetched: new Date().toISOString(),
      count: unique.length,
      posts: unique,
    }, null, 2)
  );

  console.log(`\nSaved ${unique.length} posts to ${outPath}`);
}

main().catch(console.error);
