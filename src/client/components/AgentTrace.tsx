import React, { useState } from 'react';
import { AgentTraceEvent } from '../types.js';

interface AgentTraceProps {
  trace: AgentTraceEvent[];
}

export const AgentTrace: React.FC<AgentTraceProps> = ({ trace }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!trace || trace.length === 0) return null;

  const statusEvents = trace.filter((e) => e.type === 'status');
  const toolStarts = trace.filter((e) => e.type === 'tool_start');
  const toolEnds = trace.filter((e) => e.type === 'tool_end');
  const errors = trace.filter((e) => e.type === 'error');

  const totalQueries = toolStarts.reduce((acc, curr) => acc + (curr.queries?.length || 0), 0);
  const totalResults = toolEnds.reduce((acc, curr) => acc + (curr.resultCount || 0), 0);
  const totalDurationMs = toolEnds.reduce((acc, curr) => acc + (curr.durationMs || 0), 0);

  let pillTitle = 'Agent Trace';
  if (totalQueries > 0) {
    pillTitle = `Trace: ${totalQueries} parallel queries · ${totalResults} results · ${totalDurationMs}ms`;
  } else if (statusEvents.length > 0) {
    pillTitle = 'Trace: Historical memory pre-retrieved';
  }

  return (
    <div className="trace-container">
      <button
        type="button"
        className="trace-pill"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className={`trace-arrow ${isOpen ? 'open' : ''}`}>▶</span>
        <span className="trace-title">{pillTitle}</span>
      </button>

      {isOpen && (
        <div className="trace-details">
          {statusEvents.map((ev, idx) => (
            <div key={`status-${idx}`} className="trace-block">
              <div className="trace-header">MEMORY PRE-RETRIEVAL</div>
              <div className="trace-message">{ev.message}</div>
            </div>
          ))}

          {toolStarts.map((ev, idx) => (
            <div key={`tool-start-${idx}`} className="trace-block">
              <div className="trace-header">CONCURRENT WEB SEARCH QUERIES</div>
              <ul className="trace-query-list">
                {(ev.queries || []).map((q, qIdx) => (
                  <li key={qIdx} className="trace-query-item">
                    <span className="query-arrow">→</span> {q}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {toolEnds.map((ev, idx) => (
            <div key={`tool-end-${idx}`} className="trace-block">
              <div className="trace-header">SEARCH EXECUTION STATS</div>
              <div className="trace-stats-row">
                <span className="stat-badge green">{ev.resultCount} pages found</span>
                <span className="stat-badge orange">{ev.durationMs}ms latency</span>
              </div>
            </div>
          ))}

          {errors.map((ev, idx) => (
            <div key={`err-${idx}`} className="trace-block">
              <div className="trace-header error">ERROR</div>
              <div className="trace-error">{ev.error}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

