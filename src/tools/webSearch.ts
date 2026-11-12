export interface WebSearchArgs {
  queries: string[];
  topic?: 'general' | 'news';
  days_back?: number;
}

export interface WebSearchResultItem {
  query: string;
  title: string;
  url: string;
  published_date?: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResultItem[];
  error?: string;
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_QUERIES = 6;

/**
 * Executes a single search query against the Tavily API with timeout and retry.
 */
async function fetchTavilySearch(
  query: string,
  apiKey: string,
  topic: 'general' | 'news' = 'general',
  daysBack?: number,
  retries: number = 1
): Promise<WebSearchResultItem[]> {
  const payload: Record<string, any> = {
    api_key: apiKey,
    query: query.trim(),
    search_depth: 'advanced',
    include_answer: false,
    max_results: 5,
    topic
  };

  if (typeof daysBack === 'number' && daysBack > 0) {
    payload.days = Math.min(Math.max(1, Math.round(daysBack)), 365);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.warn(`[Tavily Search] Query "${query}" failed (${response.status}): ${errorText}`);
        if (response.status >= 500 && attempt < retries) {
          continue; // Retry on 5xx
        }
        return [];
      }

      const data = await response.json();
      const rawResults = Array.isArray(data.results) ? data.results : [];

      return rawResults.map((item: any) => ({
        query,
        title: (item.title || '').trim(),
        url: (item.url || '').trim(),
        published_date: item.published_date || undefined,
        snippet: (item.content || '').replace(/\s+/g, ' ').trim()
      }));
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err.name === 'AbortError';
      console.warn(`[Tavily Search] Query "${query}" error (attempt ${attempt + 1}): ${isAbort ? 'Timeout after 8s' : err.message}`);

      if (attempt < retries && !isAbort) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      return [];
    }
  }

  return [];
}

/**
 * Batched Parallel Web Search Tool
 * Executes up to 6 queries in parallel, deduplicates results by URL, and formats cleanly.
 */
export async function executeWebSearch(args: WebSearchArgs): Promise<WebSearchResultItem[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[WebSearch Tool] TAVILY_API_KEY is not configured in environment.');
    return [];
  }

  const rawQueries = Array.isArray(args.queries) ? args.queries : [String(args.queries)];
  const queries = rawQueries
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => q.length > 0)
    .slice(0, MAX_CONCURRENT_QUERIES);

  if (queries.length === 0) {
    return [];
  }

  const topic = args.topic === 'news' ? 'news' : 'general';
  const daysBack = typeof args.days_back === 'number' ? args.days_back : undefined;

  // Execute all queries in parallel
  const searchPromises = queries.map((q) =>
    fetchTavilySearch(q, apiKey, topic, daysBack, 1)
  );

  const nestedResults = await Promise.all(searchPromises);

  // Flatten and deduplicate by URL
  const seenUrls = new Set<string>();
  const deduplicated: WebSearchResultItem[] = [];

  for (const list of nestedResults) {
    for (const item of list) {
      if (!item.url || seenUrls.has(item.url)) {
        continue;
      }
      seenUrls.add(item.url);
      deduplicated.push(item);
    }
  }

  return deduplicated;
}

/**
 * Gemini Function Declaration Schema for the web_search tool
 */
export const webSearchToolDeclaration = {
  name: 'web_search',
  description: 'Search the live web in parallel for up-to-date pricing, version releases, news, and factual verification. Supports multiple queries concurrently.',
  parameters: {
    type: 'OBJECT',
    properties: {
      queries: {
        type: 'ARRAY',
        items: {
          type: 'STRING'
        },
        description: 'Array of 1 to 6 specific, distinct search queries executed concurrently to cross-verify facts.'
      },
      topic: {
        type: 'STRING',
        enum: ['general', 'news'],
        description: 'Optional category of search. Use "news" for recent product announcements or "general" for documentation and pricing.'
      },
      days_back: {
        type: 'INTEGER',
        description: 'Optional time filter in days (e.g., 3, 7, 30) to restrict results to recent updates.'
      }
    },
    required: ['queries']
  }
};

