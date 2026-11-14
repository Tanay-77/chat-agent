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
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  input,
  setInput,
  onSendMessage,
  isLoading,
  statusText,
  isSidebarOpen,
  onToggleSidebar
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
        <div className="navbar-left">
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={onToggleSidebar}
            title={isSidebarOpen ? 'Hide sidebar' : 'Open sidebar'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
            <span>{isSidebarOpen ? 'Hide sidebar' : 'Open sidebar'}</span>
          </button>
        </div>
      </header>

      <div className="chat-scroll-area">
        {messages.length === 0 && !isLoading && (
          <div className="chat-empty-state">
            <div className="empty-icon">⚡</div>
            <h3>Chat Agent Ready</h3>
            <p>
              Ask questions with cross-session memory recall and live web search verification.
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
            placeholder="Ask anything…"
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

