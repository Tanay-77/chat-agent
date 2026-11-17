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
  memoryHeaderText: string;
  searchQueries: number;
  searchResults: number;
  searchDurationSec: string;
}

export function computeTracePillState(trace?: AgentTraceEvent[]): TracePillState {
  const memoryTrace = trace?.find((e) => e.type === 'trace' && e.step === 'memory');
  const searchTraces = (trace || []).filter((e) => e.type === 'trace' && e.step === 'search');

  const foundCount = typeof memoryTrace?.found === 'number' ? memoryTrace.found : 0;
  const isDateResolvedZero = Boolean(
    memoryTrace &&
    memoryTrace.dateResolved &&
    foundCount === 0 &&
    memoryTrace.dateStr
  );
  const hasMemoryFound = Boolean(memoryTrace && foundCount > 0);
  const hasMemory = hasMemoryFound || isDateResolvedZero;
  const hasSearch = searchTraces.length > 0;

  if (!hasMemory && !hasSearch) {
    return {
      shouldRender: false,
      collapsedText: '',
      hasMemory: false,
      hasSearch: false,
      memoryFound: 0,
      memorySnippets: [],
      memoryHeaderText: '',
      searchQueries: 0,
      searchResults: 0,
      searchDurationSec: '0.0'
    };
  }

  let memoryCollapsed = '';
  let memoryHeaderText = '';
  let memorySnippets: Array<{ date: string; text: string }> = [];

  if (isDateResolvedZero) {
    memoryCollapsed = `Checked earlier conversation · nothing on ${memoryTrace?.dateStr}`;
    memoryHeaderText = `No messages stored for ${memoryTrace?.dateStr}. Earliest stored message: ${memoryTrace?.earliestDate || 'no stored history'}.`;
    memorySnippets = [];
  } else if (hasMemoryFound) {
    memoryCollapsed = 'Used earlier conversation';
    memorySnippets = (memoryTrace?.snippets || []).slice(0, 3);
    if (memoryTrace?.dateResolved || memoryTrace?.matchType === 'date') {
      const dateLabel = memoryTrace?.dateStr || (memorySnippets[0]?.date ?? '');
      memoryHeaderText = `Found ${foundCount} message(s) from ${dateLabel}`;
    } else {
      memoryHeaderText = `Found ${foundCount} related message(s)`;
    }
  }

  let collapsedText = '';
  if (memoryCollapsed && hasSearch) {
    collapsedText = `${memoryCollapsed} · Searched the web`;
  } else if (memoryCollapsed) {
    collapsedText = memoryCollapsed;
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
    memoryFound: foundCount,
    memorySnippets,
    memoryHeaderText,
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
                {state.memoryHeaderText}
              </div>
              {state.memorySnippets.length > 0 && (
                <div className="trace-snippet-list">
                  {state.memorySnippets.map((snippet, idx) => (
                    <div key={idx} className="trace-snippet-item">
                      <span className="trace-snippet-date">{snippet.date}</span>
                      <span className="trace-snippet-text">{snippet.text}</span>
                    </div>
                  ))}
                </div>
              )}
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
