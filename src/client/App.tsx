import React, { useState, useEffect } from 'react';
import { ChatMessage, HistoricalMessage, AgentTraceEvent } from './types.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { InspectorModal } from './components/InspectorModal.js';

export const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [timeline, setTimeline] = useState<Record<string, HistoricalMessage[]>>({});
  const [inspectDate, setInspectDate] = useState<string | null>(null);
  const [inspectMessages, setInspectMessages] = useState<HistoricalMessage[]>([]);
  const [sessionId] = useState('eval-session-live');

  const fetchTimeline = async () => {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        setTimeline(data.groupedByDate || {});
      }
    } catch (err) {
      console.error('Failed to load timeline from API:', err);
    }
  };

  useEffect(() => {
    fetchTimeline();
  }, []);

  const handleSendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setIsLoading(true);
    setStatusText('Resolving temporal context & memory...');

    const currentTrace: AgentTraceEvent[] = [];
    let assistantText = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, sessionId })
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
            currentTrace.push(event);
            setStatusText(event.message || 'Processing memory...');
          } else if (event.type === 'tool_start') {
            currentTrace.push(event);
            const count = event.queries?.length || 0;
            setStatusText(`Dispatching ${count} batched web searches...`);
          } else if (event.type === 'tool_end') {
            currentTrace.push(event);
            setStatusText(`Synthesizing ${event.resultCount} search results...`);
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
                return [...prev.slice(0, -1), { ...clean, trace: [...currentTrace] }];
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
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `**Execution Error:** ${err?.message || 'Connection failure'}`,
          trace: currentTrace
        }
      ]);
    } finally {
      setIsLoading(false);
      setStatusText('');
      fetchTimeline();
    }
  };

  const handleResetDatabase = async () => {
    if (!window.confirm('Reset SQLite database and re-seed canonical history?')) return;
    try {
      setIsLoading(true);
      await fetch('/api/reset', { method: 'POST' });
      setMessages([]);
      await fetchTimeline();
    } catch (err: any) {
      alert(`Database reset error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        timeline={timeline}
        onSelectDate={(date, msgs) => {
          setInspectDate(date);
          setInspectMessages(msgs);
        }}
        onRunQuickTest={handleSendMessage}
        onResetDatabase={handleResetDatabase}
        isLoading={isLoading}
      />

      <ChatArea
        messages={messages}
        input={input}
        setInput={setInput}
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
        statusText={statusText}
        sessionId={sessionId}
      />

      <InspectorModal
        date={inspectDate}
        messages={inspectMessages}
        onClose={() => setInspectDate(null)}
      />
    </div>
  );
};

