export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  trace?: AgentTraceEvent[];
  _streaming?: boolean;
}

export interface AgentTraceEvent {
  type: 'status' | 'trace' | 'tool_start' | 'tool_end' | 'token' | 'done' | 'error';
  step?: 'memory' | 'search';
  found?: number;
  snippets?: Array<{ date: string; text: string }>;
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

