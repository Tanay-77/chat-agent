import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage, AgentTraceEvent, SessionSummary } from './types.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';

export const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState('eval-session-live');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

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
            role: m.role,
            content: m.content,
            created_at: m.created_at
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

  const handleNewChat = async () => {
    try {
      setIsLoading(true);
      setStatusText('Starting new chat session...');
      const res = await fetch('/api/session/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        const newSessionId = data.sessionId || data.session_id;
        setSessionId(newSessionId);
        setMessages([]);
        setInput('');
        await fetchSessions();
      } else {
        console.error('Failed to create new session');
      }
    } catch (err: any) {
      console.error('Error creating new session:', err);
    } finally {
      setIsLoading(false);
      setStatusText('');
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleSendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setInput('');
    const userCreatedAt = new Date().toISOString();
    setMessages((prev) => [...prev, { role: 'user', content: trimmed, created_at: userCreatedAt }]);
    setIsLoading(true);
    setStatusText('Resolving temporal context & memory...');

    const currentTrace: AgentTraceEvent[] = [];
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
            currentTrace.push(event);
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
                  { ...last, content: assistantText, trace: [...currentTrace] }
                ];
              }
              return [
                ...prev,
                {
                  role: 'assistant',
                  content: assistantText,
                  created_at: new Date().toISOString(),
                  trace: [...currentTrace],
                  _streaming: true
                }
              ];
            });
          } else if (event.type === 'error') {
            currentTrace.push(event);
            setStatusText('');
            if (event.error) {
              assistantText += `\n\n**Error:** ${event.error}`;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: assistantText, trace: [...currentTrace] }
                  ];
                }
                return [
                  ...prev,
                  {
                    role: 'assistant',
                    content: assistantText,
                    created_at: new Date().toISOString(),
                    trace: [...currentTrace],
                    _streaming: false
                  }
                ];
              });
            }
          } else if (event.type === 'done') {
            setStatusText('');
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant') {
                const { _streaming, ...clean } = last;
                return [...prev.slice(0, -1), { ...clean, created_at: clean.created_at || new Date().toISOString(), trace: [...currentTrace] }];
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
            return [...prev.slice(0, -1), { ...clean, content, created_at: clean.created_at || new Date().toISOString(), trace: [...currentTrace] }];
          }
          return [
            ...prev,
            {
              role: 'assistant',
              content: '*[Execution stopped]*',
              created_at: new Date().toISOString(),
              trace: currentTrace
            }
          ];
        });
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `**Execution Error:** ${err?.message || 'Connection failure'}`,
            created_at: new Date().toISOString(),
            trace: currentTrace
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
      />
    </div>
  );
};

