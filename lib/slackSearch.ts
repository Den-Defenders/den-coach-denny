/**
 * lib/slackSearch.ts
 *
 * Searches Den Defenders' Slack for messages about a customer, for
 * "Talk with Coach Denny". Uses Slack's search.messages API, which only works
 * with a USER token (xoxp-...) that has the search:read scope.
 *
 * That token can see whatever its Slack user can see, including private
 * channels and DMs, so results are filtered here to PUBLIC CHANNELS ONLY
 * before anything reaches the voice model.
 *
 * Env: SLACK_SEARCH_USER_TOKEN. Not set = Slack is simply skipped.
 */

export type SlackHit = {
  channel: string;
  author: string | null;
  date: string;
  text: string;
  matchedOn: string;
};

type SlackMatch = {
  ts?: string;
  text?: string;
  username?: string;
  user?: string;
  permalink?: string;
  channel?: {
    id?: string;
    name?: string;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
    is_channel?: boolean;
  };
};

export function slackSearchConfigured(): boolean {
  return Boolean(process.env.SLACK_SEARCH_USER_TOKEN);
}

function isPublicChannel(match: SlackMatch): boolean {
  const channel = match.channel;
  if (!channel || !channel.id) return false;
  if (channel.is_private || channel.is_im || channel.is_mpim) return false;
  // Public channel IDs start with C. Private (G) and DMs (D) never pass.
  return channel.id.startsWith("C");
}

function cleanSlackText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|([^>]+))?>/g, (_, __, name) => (name ? `@${name}` : "@someone"))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchOnce(token: string, term: string, perTerm: number): Promise<SlackMatch[]> {
  const params = new URLSearchParams({
    query: `"${term.replace(/"/g, "")}"`,
    count: String(perTerm),
    sort: "timestamp",
    sort_dir: "desc",
    highlight: "false",
  });
  const response = await fetch(`https://slack.com/api/search.messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string; messages?: { matches?: SlackMatch[] } }
    | null;
  if (!data?.ok) throw new Error(`Slack search failed: ${data?.error || response.status}`);
  return data.messages?.matches || [];
}

/**
 * Search Slack for each term (exact phrase), newest first, public channels only.
 * Terms are things like the street address, customer name, phone and job number.
 */
export async function searchSlackForCustomer(
  terms: string[],
  timeZone: string,
  maxResults = 15
): Promise<{ hits: SlackHit[]; searchedFor: string[] } | { unavailable: string }> {
  const token = process.env.SLACK_SEARCH_USER_TOKEN;
  if (!token) return { unavailable: "Slack isn't connected to Denny yet." };

  const unique = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 4))].slice(0, 5);
  if (!unique.length) return { hits: [], searchedFor: [] };

  const results = await Promise.all(
    unique.map((term) =>
      searchOnce(token, term, 20)
        .then((matches) => matches.map((match) => ({ match, term })))
        .catch((error) => {
          console.error("Slack search term failed:", error instanceof Error ? error.message : error);
          return [] as { match: SlackMatch; term: string }[];
        })
    )
  );

  const seen = new Set<string>();
  const hits: (SlackHit & { ts: number })[] = [];
  for (const { match, term } of results.flat()) {
    if (!isPublicChannel(match) || !match.ts || !match.text) continue;
    const key = `${match.channel?.id}:${match.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = Number(match.ts) * 1000;
    const text = cleanSlackText(match.text);
    hits.push({
      ts,
      channel: `#${match.channel?.name || "unknown"}`,
      author: match.username || null,
      date: new Intl.DateTimeFormat("en-US", {
        timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      }).format(new Date(ts)),
      text: text.length > 500 ? `${text.slice(0, 500)}…` : text,
      matchedOn: term,
    });
  }

  hits.sort((a, b) => b.ts - a.ts);
  return {
    searchedFor: unique,
    hits: hits.slice(0, maxResults).map((hit) => ({
      channel: hit.channel,
      author: hit.author,
      date: hit.date,
      text: hit.text,
      matchedOn: hit.matchedOn,
    })),
  };
}
