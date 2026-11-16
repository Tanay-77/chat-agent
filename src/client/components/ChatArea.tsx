import React, { useRef, useEffect, useState } from 'react';
import { marked } from 'marked';
import { ChatMessage } from '../types.js';
import { AgentTrace } from './AgentTrace.js';

interface ChatAreaProps {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  onSendMessage: (text: string) => void;
  onStopExecution?: () => void;
  isLoading: boolean;
  statusText: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

/**
 * Computes relative time according to the prompt spec:
 * "just now", "3 min ago", "2 h ago", then clock time for earlier today, then date.
 */
function formatRelativeTime(timestamp?: string): { text: string; full: string } {
  if (!timestamp) return { text: 'just now', full: '' };
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return { text: 'just now', full: '' };

  const full = d.toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'medium'
  });

  const now = new Date();
  const diffSec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);

  if (diffSec < 60) {
    return { text: 'just now', full };
  }
  if (diffMin < 60) {
    return { text: `${diffMin} min ago`, full };
  }
  if (diffHours < 4) {
    return { text: `${diffHours} h ago`, full };
  }

  const isToday = d.toLocaleDateString() === now.toLocaleDateString();
  if (isToday) {
    return {
      text: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      full
    };
  }

  return {
    text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    full
  };
}

/**
 * Returns formatted date divider string using the user's browser timezone:
 * "TODAY", "YESTERDAY", or "Mon, Nov 9"
 */
function getDateDividerLabel(timestamp?: string): string {
  if (!timestamp) return 'TODAY';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return 'TODAY';

  const today = new Date();
  if (d.toLocaleDateString() === today.toLocaleDateString()) {
    return 'TODAY';
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toLocaleDateString() === yesterday.toLocaleDateString()) {
    return 'YESTERDAY';
  }

  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

function shouldShowDateDivider(messages: ChatMessage[], index: number): boolean {
  if (index === 0) return true;
  const prev = messages[index - 1];
  const curr = messages[index];
  if (!prev.created_at || !curr.created_at) return false;

  const prevDate = new Date(prev.created_at).toLocaleDateString();
  const currDate = new Date(curr.created_at).toLocaleDateString();
  return prevDate !== currDate;
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text', err);
    }
  };

  return (
    <button
      type="button"
      className="message-copy-btn"
      onClick={handleCopy}
      title="Copy message"
    >
      {copied ? (
        <span className="copy-copied-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>Copied</span>
        </span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
};

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  input,
  setInput,
  onSendMessage,
  onStopExecution,
  isLoading,
  statusText,
  isSidebarOpen,
  onToggleSidebar
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, setMinuteTick] = useState(0);

  // Updates relative time every minute
  useEffect(() => {
    const interval = setInterval(() => setMinuteTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, statusText]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading && input.trim()) {
        onSendMessage(input);
      }
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  };

  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input]);

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
        <div className="chat-content-column">
          {messages.length === 0 && !isLoading && (
            <div className="chat-empty-state">
              <div className="empty-icon">⚡</div>
              <h3>Chat Agent Ready</h3>
              <p>
                Ask questions with cross-session memory recall and live web search verification.
              </p>
            </div>
          )}

          {messages.map((msg, idx) => {
            const showDivider = shouldShowDateDivider(messages, idx);
            const timeInfo = formatRelativeTime(msg.created_at);

            return (
              <React.Fragment key={idx}>
                {showDivider && (
                  <div className="date-divider">
                    <span>{getDateDividerLabel(msg.created_at)}</span>
                  </div>
                )}

                <div className={`message-row ${msg.role}`}>
                  {msg.role === 'user' ? (
                    <div className="user-message-card">
                      <div className="message-header user-header">
                        <span className="header-label">Me</span>
                        <span className="header-dot">·</span>
                        <span className="header-time" title={timeInfo.full}>
                          {timeInfo.text}
                        </span>
                      </div>
                      <div className="user-text-content">{msg.content}</div>
                    </div>
                  ) : (
                    <div className="assistant-message-block">
                      <div className="message-header assistant-header">
                        <span className="header-label">Agent</span>
                        <span className="header-dot">·</span>
                        <span className="header-time" title={timeInfo.full}>
                          {timeInfo.text}
                        </span>
                      </div>

                      {msg.trace && <AgentTrace trace={msg.trace} />}

                      <div className="assistant-content">
                        <div
                          className="assistant-markdown-bubble markdown-body"
                          dangerouslySetInnerHTML={{
                            __html: marked.parse(msg.content, { breaks: true, gfm: true }) as string
                          }}
                        />
                      </div>

                      {!msg._streaming && msg.content && (
                        <div className="message-actions">
                          <CopyButton text={msg.content} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}

          {isLoading && statusText && (
            <div className="agent-status-indicator">
              <div className="spinner-orbit" />
              <span className="status-label">{statusText}</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <footer className="chat-footer">
        <div className="chat-footer-inner">
          <form
            className="input-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (isLoading) {
                onStopExecution?.();
              } else if (input.trim()) {
                onSendMessage(input);
              }
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
            />
            <div className="input-card-actions">
              {isLoading ? (
                <button
                  type="button"
                  className="stop-circle-button"
                  onClick={onStopExecution}
                  title="Stop execution"
                  aria-label="Stop execution"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-circle-button"
                  disabled={!input.trim()}
                  title="Send message"
                  aria-label="Send message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </form>
          <div className="chat-footer-disclaimer">
            Answers use web search and your earlier chats. Check important facts.
          </div>
        </div>
      </footer>
    </main>
  );
};
