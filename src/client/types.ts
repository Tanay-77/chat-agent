export interface PersistedTraceSnippet {
  date: string;
  role?: string;
  text: string;
}

export interface PersistedTraceMemory {
  found: number;
  snippets: PersistedTraceSnippet[];
  dateResolved?: boolean;
  dateStr?: string;
  earliestDate?: string;
  matchType?: 'date' | 'fts' | 'none';
}

export interface PersistedTraceSearch {
  queries: number;
  results: number;
  ms: number;
}

export interface PersistedTrace {
  memory?: PersistedTraceMemory | null;
  search?: PersistedTraceSearch | null;
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  trace?: PersistedTrace | null;
  _streaming?: boolean;
}

export interface AgentTraceEvent {
  type: 'status' | 'trace' | 'tool_start' | 'tool_end' | 'token' | 'done' | 'error';
  step?: 'memory' | 'search';
  found?: number;
  dateResolved?: boolean;
  dateStr?: string;
  earliestDate?: string;
  matchType?: 'date' | 'fts' | 'none';
  snippets?: Array<{ date: string; role?: string; text: string }>;
  queries?: number | string[];
  results?: number;
  ms?: number;
  resultCount?: number;
  durationMs?: number;
  text?: string;
  message?: string;
  content?: string;
  error?: string;
}

export interface HistoricalMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  date_str: string;
  keywords: string | null;
}

export interface QuickTestPrompt {
  id: string;
  label: string;
  prompt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  last_message_at: string;
}

