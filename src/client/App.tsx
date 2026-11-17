import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage, AgentTraceEvent, SessionSummary, PersistedTrace } from './types.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { simplifyErrorMessage } from '../utils/errorFormatter.js';

export const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? `session-${crypto.randomUUID()}`
      : `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [focusTrigger, setFocusTrigger] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);

  const toggleSidebar = () => setIsSidebarOpen((prev) => !prev);

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to load sessions from API:', err);
    }
  };

  const handleSelectSession = async (selectedId: string) => {
    if (isLoading) return;
    try {
      setIsLoading(true);
      setStatusText('Loading chat history...');
      const res = await fetch(`/api/sessions/${selectedId}/messages`);
      if (res.ok) {
        const data = await res.json();
        const rawMsgs = Array.isArray(data) ? data : data.messages || [];
        setMessages(
          rawMsgs.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
            trace: m.trace ?? null
          }))
        );
        setSessionId(selectedId);
      } else if (res.status === 404) {
        alert('Session not found or does not belong to you.');
      }
    } catch (err) {
      console.error('Failed to load session messages:', err);
    } finally {
      setIsLoading(false);
      setStatusText('');
    }
  };

  const handleNewChat = () => {
    // If the current session is already empty (zero messages), New Chat does nothing except refocus the input.
    if (messages.length === 0) {
      setFocusTrigger((prev) => prev + 1);
      return;
    }

    // New Chat only generates a client-side session_id and switches to the empty state. It makes no server call.
    const newSessionId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? `session-${crypto.randomUUID()}`
        : `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    setSessionId(newSessionId);
    setMessages([]);
    setInput('');
    setFocusTrigger((prev) => prev + 1);
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleSendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const isFirstMessage = messages.length === 0;

    setInput('');
    const userCreatedAt = new Date().toISOString();
    setMessages((prev) => [...prev, { role: 'user', content: trimmed, created_at: userCreatedAt, trace: null }]);
    setIsLoading(true);
    setStatusText('Resolving temporal context & memory...');

    let liveTrace: PersistedTrace = {};
    const getActiveTrace = (): PersistedTrace | null => {
      const hasMem = Boolean(liveTrace.memory && (liveTrace.memory.found > 0 || liveTrace.memory.dateResolved));
      const hasSrc = Boolean(liveTrace.search && (liveTrace.search.queries > 0 || liveTrace.search.results > 0 || liveTrace.search.ms > 0));
      return (hasMem || hasSrc) ? { ...liveTrace } : null;
    };
    let assistantText = '';
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: trimmed,
          sessionId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });

      if (!response.body) {
        throw new Error('No readable response body received from server');
      }

      // After the first message in a session, refresh the sidebar list so the new title appears immediately
      if (isFirstMessage) {
        fetchSessions();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        if (!line.startsWith('data: ')) return;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;

        try {
          const event: AgentTraceEvent = JSON.parse(payload);

          if (event.type === 'status') {
            setStatusText(event.text || event.message || 'Working…');
          } else if (event.type === 'trace') {
            if (event.step === 'memory') {
              const snippets = (event.snippets || []).map((s: any) => ({
                date: s.date,
                role: s.role,
                text: s.text
              }));
              liveTrace = {
                ...liveTrace,
                memory: {
                  found: event.found ?? 0,
                  snippets,
                  dateResolved: event.dateResolved,
                  dateStr: event.dateStr,
                  earliestDate: event.earliestDate,
                  matchType: event.matchType
                }
              };
            } else if (event.step === 'search') {
              const qCount = typeof event.queries === 'number'
                ? event.queries
                : Array.isArray(event.queries)
                ? event.queries.length
                : 1;
              const rCount = event.results || event.resultCount || 0;
              const dMs = event.ms || event.durationMs || 0;
              liveTrace = {
                ...liveTrace,
                search: {
                  queries: (liveTrace.search?.queries || 0) + qCount,
                  results: (liveTrace.search?.results || 0) + rCount,
                  ms: (liveTrace.search?.ms || 0) + dMs
                }
              };
            }
          } else if (event.type === 'tool_start') {
            setStatusText('Working…');
          } else if (event.type === 'tool_end') {
            setStatusText('Working…');
          } else if (event.type === 'token') {
            assistantText += event.content || '';
            setStatusText('');
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last._streaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: assistantText, trace: getActiveTrace() }
                ];
              }
              return [
                ...prev,
                {
                  role: 'assistant',
                  content: assistantText,
                  created_at: new Date().toISOString(),
                  trace: getActiveTrace(),
                  _streaming: true
                }
              ];
            });
          } else if (event.type === 'error') {
            setStatusText('');
            if (event.error) {
              const friendlyError = simplifyErrorMessage(event.error);
              assistantText = assistantText ? `${assistantText}\n\n${friendlyError}` : friendlyError;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: assistantText, trace: getActiveTrace(), _streaming: false }
                  ];
                }
                return [
                  ...prev,
                  {
                    role: 'assistant',
                    content: assistantText,
                    created_at: new Date().toISOString(),
                    trace: getActiveTrace(),
                    _streaming: false
                  }
                ];
              });
            }
          } else if (event.type === 'done') {
            if (typeof event.totalMs === 'number') {
              liveTrace = {
                ...liveTrace,
                totalMs: event.totalMs,
                search: liveTrace.search ? { ...liveTrace.search, totalMs: event.totalMs } : null
              };
            }
            setStatusText('');
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant') {
                const { _streaming, ...clean } = last;
                return [...prev.slice(0, -1), { ...clean, created_at: clean.created_at || new Date().toISOString(), trace: getActiveTrace() }];
              }
              return prev;
            });
          }
        } catch {
          // Non-JSON SSE line ignored
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            processLine(buffer.trim());
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            const { _streaming, ...clean } = last;
            const content = clean.content
              ? `${clean.content}\n\n*[Execution stopped]*`
              : '*[Execution stopped]*';
            return [...prev.slice(0, -1), { ...clean, content, created_at: clean.created_at || new Date().toISOString(), trace: getActiveTrace() }];
          }
          return [
            ...prev,
            {
              role: 'assistant',
              content: '*[Execution stopped]*',
              created_at: new Date().toISOString(),
              trace: getActiveTrace()
            }
          ];
        });
      } else {
        const friendlyError = simplifyErrorMessage(err);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: friendlyError,
            created_at: new Date().toISOString(),
            trace: getActiveTrace()
          }
        ]);
      }
    } finally {
      setIsLoading(false);
      setStatusText('');
      abortControllerRef.current = null;
      await fetchSessions();
    }
  };

  const handleStopExecution = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    }).catch(() => {});
    setIsLoading(false);
    setStatusText('');
  };

  const handleResetDatabase = async () => {
    if (!window.confirm('This deletes all your chat history and memory. Continue?')) {
      return;
    }
    try {
      setIsLoading(true);
      await fetch('/api/reset', { method: 'POST' });
      setMessages([]);
      await fetchSessions();
    } catch (err: any) {
      alert(`Database reset error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        isOpen={isSidebarOpen}
        sessions={sessions}
        currentSessionId={sessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onResetDatabase={handleResetDatabase}
        isLoading={isLoading}
      />

      <ChatArea
        messages={messages}
        input={input}
        setInput={setInput}
        onSendMessage={handleSendMessage}
        onStopExecution={handleStopExecution}
        isLoading={isLoading}
        statusText={statusText}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={toggleSidebar}
        sessionId={sessionId}
        focusTrigger={focusTrigger}
      />
    </div>
  );
};

