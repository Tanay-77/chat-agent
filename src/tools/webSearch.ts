import { Type, FunctionDeclaration } from '@google/genai';

export const TAVILY_PUBLISH_DATE_NOTE =
  'Tavily filters by publish date. Pages edited after publishing may not appear.';

export interface WebSearchArgs {
  queries: string[];
  topic?: 'general' | 'news';
  start_date?: string;
  end_date?: string;
  search_depth?: 'basic' | 'advanced';
}

export interface WebSearchResultItem {
  query: string;
  title: string;
  url: string;
  published_date?: string;
  snippet: string;
  note?: string;
  site_name?: string;
}

export function extractSiteName(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export interface WebSearchResponse {
  results: WebSearchResultItem[];
  note?: string;
  error?: string;
}

/**
 * Computes the effective start date:
 * - If resolver provides a default startDate, apply it by default.
 * - If the model specifies a start_date, the model may not widen or move it to an earlier date.
 *   (i.e. model start_date earlier than resolver startDate is clamped to resolver startDate).
 * - If model narrows to a later date, the later date is accepted.
 */
export function computeEffectiveStartDate(
  modelStartDate?: string,
  resolverStartDate?: string
): string | undefined {
  if (resolverStartDate) {
    if (modelStartDate) {
      // Model cannot widen or move earlier than resolverStartDate
      if (modelStartDate < resolverStartDate) {
        return resolverStartDate;
      }
      return modelStartDate;
    }
    return resolverStartDate;
  }
  return modelStartDate;
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENT_QUERIES = 6;
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1-hour cache TTL

interface CacheEntry {
  timestamp: number;
  results: WebSearchResultItem[];
}

const searchCache = new Map<string, CacheEntry>();

function getCachedSearch(key: string): WebSearchResultItem[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCachedSearch(key: string, results: WebSearchResultItem[]): void {
  if (searchCache.size > 500) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { timestamp: Date.now(), results });
}

export function clearSearchCache(): void {
  searchCache.clear();
}

let mockSearchResultsStore: WebSearchResultItem[] | null = null;

export function setMockSearchResults(results: WebSearchResultItem[] | null): void {
  mockSearchResultsStore = results;
}

export function getMockSearchResults(): WebSearchResultItem[] | null {
  return mockSearchResultsStore;
}

/**
 * Executes a single search query against the Tavily API with timeout and retry.
 */
async function fetchTavilySearch(
  query: string,
  apiKey: string,
  topic: 'general' | 'news' = 'general',
  startDate?: string,
  endDate?: string,
  retries: number = 1,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Promise<WebSearchResultItem[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `${topic}:${searchDepth}:${startDate || ''}:${endDate || ''}:${normalizedQuery}`;

  // Return cached result if available
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const payload: Record<string, any> = {
    api_key: apiKey,
    query: query.trim(),
    search_depth: searchDepth, // 'basic' depth cuts network latency from ~5s down to ~1.2-1.8s
    include_answer: false,
    max_results: 5,
    topic
  };

  if (startDate) {
    payload.start_date = startDate;
  }
  if (endDate) {
    payload.end_date = endDate;
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

      const formatted = rawResults.map((item: any) => {
        const url = (item.url || '').trim();
        return {
          query,
          title: (item.title || '').trim(),
          url,
          site_name: extractSiteName(url),
          published_date: item.published_date || undefined,
          snippet: (item.content || '').replace(/\s+/g, ' ').trim(),
          note: TAVILY_PUBLISH_DATE_NOTE
        };
      });

      if (formatted.length > 0) {
        setCachedSearch(cacheKey, formatted);
      }

      return formatted;
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
 * Executes up to 6 queries in parallel (or sequentially if forceSequential is true),
 * applies default startDate from temporal resolver (model cannot widen/move it earlier),
 * deduplicates results by URL, and formats cleanly with the Tavily publish date disclaimer note.
 */
export async function executeWebSearch(
  args: WebSearchArgs,
  forceSequential: boolean = false,
  resolverStartDate?: string,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Promise<WebSearchResultItem[]> {
  if (mockSearchResultsStore && mockSearchResultsStore.length > 0) {
    const mocked = mockSearchResultsStore.map(item => ({
      ...item,
      note: TAVILY_PUBLISH_DATE_NOTE
    }));
    (mocked as any).note = TAVILY_PUBLISH_DATE_NOTE;
    return mocked;
  }

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

  const depth = args.search_depth || searchDepth;
  const topic = args.topic === 'news' ? 'news' : 'general';
  const effectiveStartDate = computeEffectiveStartDate(args.start_date, resolverStartDate);
  const effectiveEndDate = args.end_date;

  let nestedResults: WebSearchResultItem[][] = [];

  if (forceSequential) {
    // Force sequential execution for benchmarking comparison
    for (const q of queries) {
      const res = await fetchTavilySearch(q, apiKey, topic, effectiveStartDate, effectiveEndDate, 1, depth);
      nestedResults.push(res);
    }
  } else {
    // Execute all queries in parallel via Promise.all
    const searchPromises = queries.map((q) =>
      fetchTavilySearch(q, apiKey, topic, effectiveStartDate, effectiveEndDate, 1, depth)
    );
    nestedResults = await Promise.all(searchPromises);
  }

  // Flatten and deduplicate by URL
  const seenUrls = new Set<string>();
  const deduplicated: WebSearchResultItem[] = [];

  for (const list of nestedResults) {
    for (const item of list) {
      if (!item.url || seenUrls.has(item.url)) {
        continue;
      }
      seenUrls.add(item.url);
      item.note = TAVILY_PUBLISH_DATE_NOTE;
      if (!item.site_name) {
        item.site_name = extractSiteName(item.url);
      }
      deduplicated.push(item);
    }
  }

  // Sort deduplicated results to prefer most recently published dates
  deduplicated.sort((a, b) => {
    if (a.published_date && b.published_date) {
      return b.published_date.localeCompare(a.published_date);
    }
    if (a.published_date && !b.published_date) return -1;
    if (!a.published_date && b.published_date) return 1;
    return 0;
  });

  (deduplicated as any).note = TAVILY_PUBLISH_DATE_NOTE;
  return deduplicated;
}

/**
 * Gemini Function Declaration Schema for the web_search tool
 */
export const webSearchToolDeclaration: FunctionDeclaration = {
  name: 'web_search',
  description: 'Search the live web in parallel for up-to-date pricing, version releases, news, and factual verification. Supports multiple queries concurrently.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      queries: {
        type: Type.ARRAY,
        items: {
          type: Type.STRING
        },
        description: 'Array of 1 to 6 specific, distinct search queries executed concurrently to cross-verify facts.'
      },
      topic: {
        type: Type.STRING,
        enum: ['general', 'news'],
        description: 'Optional category of search. Use "news" for recent product announcements or "general" for documentation and pricing.'
      },
      start_date: {
        type: Type.STRING,
        description: 'Optional start date in YYYY-MM-DD format to filter results published on or after this date.'
      },
      end_date: {
        type: Type.STRING,
        description: 'Optional end date in YYYY-MM-DD format to filter results published on or before this date.'
      }
    },
    required: ['queries']
  }
};
