import React from 'react';
import { SessionSummary } from '../types.js';

interface SidebarProps {
  isOpen: boolean;
  sessions: SessionSummary[];
  currentSessionId: string;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onResetDatabase: () => void;
  isLoading: boolean;
}

function formatRelativeTime(isoString?: string): string {
  if (!isoString) return 'Recent';
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    if (diffMs < 0) return 'Just now';
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return 'Recent';
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  sessions,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onResetDatabase,
  isLoading
}) => {
  if (!isOpen) return null;

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="brand-info">
          <img src="/image.png" alt="Logo" className="sidebar-brand-orb" />
          <h2>Chat Agent</h2>
        </div>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="new-chat-btn"
          onClick={onNewChat}
          disabled={isLoading}
          title="Start a new chat session"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>New Chat</span>
        </button>
      </div>

      <div className="sidebar-content">
        <section className="sidebar-section">
          <div className="section-title">CHAT HISTORY</div>
          <div className="sessions-list">
            {sessions.length === 0 ? (
              <div className="sessions-empty">No previous chats.</div>
            ) : (
              sessions.map((sess) => {
                const isActive = sess.id === currentSessionId;
                return (
                  <button
                    key={sess.id}
                    type="button"
                    className={`session-item ${isActive ? 'active' : ''}`}
                    onClick={() => onSelectSession(sess.id)}
                    disabled={isLoading}
                    title={sess.title}
                  >
                    <div className="session-item-title">{sess.title}</div>
                    <div className="session-item-meta">
                      <span>{formatRelativeTime(sess.last_message_at)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="clear-memory-text-btn"
          onClick={onResetDatabase}
          disabled={isLoading}
          title="Delete all chat history and memory"
        >
          Clear All Memory
        </button>
      </div>
    </aside>
  );
};

