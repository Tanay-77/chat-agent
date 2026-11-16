import React, { useState } from 'react';
import { AgentTraceEvent } from '../types.js';

interface AgentTraceProps {
  trace?: AgentTraceEvent[];
}

export interface TracePillState {
  shouldRender: boolean;
  collapsedText: string;
  hasMemory: boolean;
  hasSearch: boolean;
  memoryFound: number;
  memorySnippets: Array<{ date: string; text: string }>;
  searchQueries: number;
  searchResults: number;
  searchDurationSec: string;
}

export function computeTracePillState(trace?: AgentTraceEvent[]): TracePillState {
  const memoryTrace = trace?.find((e) => e.type === 'trace' && e.step === 'memory');
  const searchTraces = (trace || []).filter((e) => e.type === 'trace' && e.step === 'search');

  const hasMemory = Boolean(memoryTrace && typeof memoryTrace.found === 'number' && memoryTrace.found > 0);
  const hasSearch = searchTraces.length > 0;

  if (!hasMemory && !hasSearch) {
    return {
      shouldRender: false,
      collapsedText: '',
      hasMemory: false,
      hasSearch: false,
      memoryFound: 0,
      memorySnippets: [],
      searchQueries: 0,
      searchResults: 0,
      searchDurationSec: '0.0'
    };
  }

  let collapsedText = '';
  if (hasMemory && hasSearch) {
    collapsedText = 'Used earlier conversation · Searched the web';
  } else if (hasMemory) {
    collapsedText = 'Used earlier conversation';
  } else if (hasSearch) {
    collapsedText = 'Searched the web';
  }

  const totalQueries = searchTraces.reduce((acc, s) => {
    if (typeof s.queries === 'number') return acc + s.queries;
    if (Array.isArray(s.queries)) return acc + s.queries.length;
    return acc;
  }, 0);
  const totalResults = searchTraces.reduce((acc, s) => acc + (s.results || s.resultCount || 0), 0);
  const totalMs = searchTraces.reduce((acc, s) => acc + (s.ms || s.durationMs || 0), 0);
  const durationSec = (totalMs / 1000).toFixed(1);

  return {
    shouldRender: true,
    collapsedText,
    hasMemory,
    hasSearch,
    memoryFound: memoryTrace?.found || 0,
    memorySnippets: (memoryTrace?.snippets || []).slice(0, 3),
    searchQueries: totalQueries,
    searchResults: totalResults,
    searchDurationSec: durationSec
  };
}

export const AgentTrace: React.FC<AgentTraceProps> = ({ trace }) => {
  const [isOpen, setIsOpen] = useState(false);
  const state = computeTracePillState(trace);

  if (!state.shouldRender) return null;

  return (
    <div className="trace-container">
      <button
        type="button"
        className="trace-pill"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className={`trace-arrow ${isOpen ? 'open' : ''}`}>▶</span>
        <span className="trace-title">{state.collapsedText}</span>
      </button>

      {isOpen && (
        <div className="trace-details">
          {state.hasMemory && (
            <div className="trace-memory-block">
              <div className="trace-memory-header">
                Found {state.memoryFound} earlier message(s)
              </div>
              <div className="trace-snippet-list">
                {state.memorySnippets.map((snippet, idx) => (
                  <div key={idx} className="trace-snippet-item">
                    <span className="trace-snippet-date">{snippet.date}</span>
                    <span className="trace-snippet-text">{snippet.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.hasSearch && (
            <div className="trace-search-block">
              <div className="trace-search-info">
                {state.searchQueries} queries · {state.searchResults} results · {state.searchDurationSec}s
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
