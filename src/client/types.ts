export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  trace?: AgentTraceEvent[];
  _streaming?: boolean;
}

export interface AgentTraceEvent {
  type: 'status' | 'tool_start' | 'tool_end' | 'token' | 'done' | 'error';
  message?: string;
  queries?: string[];
  resultCount?: number;
  durationMs?: number;
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

