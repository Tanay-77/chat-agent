import React, { useRef, useEffect } from 'react';
import { marked } from 'marked';
import { ChatMessage } from '../types.js';
import { AgentTrace } from './AgentTrace.js';

interface ChatAreaProps {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  statusText: string;
  sessionId: string;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  input,
  setInput,
  onSendMessage,
  isLoading,
  statusText,
  sessionId
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, statusText]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendMessage(input);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  };

  return (
    <main className="chat-container">
      <header className="chat-navbar">
        <div className="navbar-session">
          <span className="session-tag">SESSION ID</span>
          <span className="session-id">{sessionId}</span>
        </div>
        <div className="navbar-stats">
          <span>{messages.filter((m) => m.role === 'user').length} queries</span>
        </div>
      </header>

      <div className="chat-scroll-area">
        {messages.length === 0 && !isLoading && (
          <div className="chat-empty-state">
            <div className="empty-icon">⚡</div>
            <h3>Temporal Chat Agent Ready</h3>
            <p>
              Select any benchmark prompt in the sidebar to test cross-session historical recall and
              batched live web search verification.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`message-row ${msg.role}`}>
            <div className="message-header">
              <span className={`role-tag ${msg.role}`}>
                {msg.role === 'user' ? 'USER' : 'AGENT (GEMINI)'}
              </span>
            </div>

            {msg.role === 'assistant' && msg.trace && (
              <AgentTrace trace={msg.trace} />
            )}

            <div className="message-content">
              {msg.role === 'user' ? (
                <div className="user-text-bubble">{msg.content}</div>
              ) : (
                <div
                  className="assistant-markdown-bubble markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: marked.parse(msg.content, { breaks: true, gfm: true }) as string
                  }}
                />
              )}
            </div>
          </div>
        ))}

        {isLoading && statusText && (
          <div className="agent-status-indicator">
            <div className="spinner-orbit" />
            <span className="status-label">{statusText}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <footer className="chat-footer">
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSendMessage(input);
          }}
        >
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="Ask a temporal cross-session query or pricing verification..."
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isLoading}
          />
          <button
            type="submit"
            className="send-button"
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? 'Running...' : 'Send'}
          </button>
        </form>
      </footer>
    </main>
  );
};

