import React from 'react';
import { HistoricalMessage, QuickTestPrompt } from '../types.js';

interface SidebarProps {
  timeline: Record<string, HistoricalMessage[]>;
  onSelectDate: (date: string, messages: HistoricalMessage[]) => void;
  onRunQuickTest: (prompt: string) => void;
  onResetDatabase: () => void;
  isLoading: boolean;
}

const QUICK_TESTS: QuickTestPrompt[] = [
  {
    id: 'crm-monday',
    label: 'Evaluation Prompt 1 · CRM Shortlist',
    prompt:
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?'
  },
  {
    id: 'nov3-recheck',
    label: 'Evaluation Prompt 2 · 3 November Versions',
    prompt:
      'What did I ask you on 3 November? Is your answer still correct today?'
  },
  {
    id: 'postgres-tuesday',
    label: 'Evaluation Prompt 3 · Postgres Hosting',
    prompt:
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'
  }
];

export const Sidebar: React.FC<SidebarProps> = ({
  timeline,
  onSelectDate,
  onRunQuickTest,
  onResetDatabase,
  isLoading
}) => {
  const sortedDates = Object.keys(timeline).sort().reverse();

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <div className="brand-status-dot" />
        <div>
          <h2>Temporal Chat Agent</h2>
          <span className="brand-subtitle">Gemini · SQLite · Tavily</span>
        </div>
      </div>

      <div className="sidebar-content">
        {/* Quick-Test Prompts Section */}
        <section className="sidebar-section">
          <div className="section-title">EVALUATION BENCHMARKS</div>
          <div className="quick-tests-list">
            {QUICK_TESTS.map((qt) => (
              <button
                key={qt.id}
                type="button"
                className="quick-test-btn"
                onClick={() => onRunQuickTest(qt.prompt)}
                disabled={isLoading}
              >
                <div className="quick-test-badge">{qt.label}</div>
                <div className="quick-test-text">{qt.prompt}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Timeline / Past History Section */}
        <section className="sidebar-section">
          <div className="section-title">TIMELINE / PAST HISTORY</div>
          <div className="timeline-list">
            {sortedDates.length === 0 ? (
              <div className="timeline-empty">No stored history in SQLite.</div>
            ) : (
              sortedDates.map((dateStr) => {
                const msgs = timeline[dateStr] || [];
                const sessions = Array.from(new Set(msgs.map((m) => m.session_id)));
                const dateObj = new Date(dateStr + 'T12:00:00Z');
                const formattedDate = dateObj.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  timeZone: 'UTC'
                });

                return (
                  <div
                    key={dateStr}
                    className="timeline-item"
                    onClick={() => onSelectDate(dateStr, msgs)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="timeline-date-title">{formattedDate}</div>
                    <div className="timeline-date-meta">
                      <span>{msgs.length} messages</span>
                      <span className="dot-sep">·</span>
                      <span className="timeline-sessions">{sessions.join(', ')}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Database Management */}
        <section className="sidebar-section reset-section">
          <button
            type="button"
            className="reset-db-btn"
            onClick={onResetDatabase}
            disabled={isLoading}
            title="Clear all stored messages to empty state"
          >
            ↻ Clear Database (Reset)
          </button>
        </section>
      </div>
    </aside>
  );
};

