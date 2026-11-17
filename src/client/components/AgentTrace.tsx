import React, { useState } from 'react';
import { AgentTraceEvent, PersistedTrace, PersistedTraceSnippet } from '../types.js';

interface AgentTraceProps {
  trace?: PersistedTrace | AgentTraceEvent[] | null;
}

export interface TracePillState {
  shouldRender: boolean;
  collapsedText: string;
  hasMemory: boolean;
  hasSearch: boolean;
  memoryFound: number;
  memorySnippets: PersistedTraceSnippet[];
  memoryHeaderText: string;
  searchQueries: number;
  searchResults: number;
  searchDurationSec: string;
}

export function normalizeTrace(trace?: PersistedTrace | AgentTraceEvent[] | null): PersistedTrace | null {
  if (!trace) return null;
  if (!Array.isArray(trace)) {
    if (!trace.memory && !trace.search) return null;
    return trace;
  }

  // Backward compatibility: If an array of AgentTraceEvent is passed
  const memoryEvent = trace.find((e) => e.type === 'trace' && e.step === 'memory');
  const searchEvents = trace.filter((e) => e.type === 'trace' && e.step === 'search');

  let memory = null;
  if (memoryEvent) {
    const foundCount = typeof memoryEvent.found === 'number' ? memoryEvent.found : 0;
    if (foundCount > 0 || memoryEvent.dateResolved) {
      memory = {
        found: foundCount,
        snippets: (memoryEvent.snippets || []).map((s) => ({
          date: s.date,
          role: s.role,
          text: s.text
        })),
        dateResolved: memoryEvent.dateResolved,
        dateStr: memoryEvent.dateStr,
        earliestDate: memoryEvent.earliestDate,
        matchType: memoryEvent.matchType
      };
    }
  }

  let search = null;
  if (searchEvents.length > 0) {
    const totalQueries = searchEvents.reduce((acc, s) => {
      if (typeof s.queries === 'number') return acc + s.queries;
      if (Array.isArray(s.queries)) return acc + s.queries.length;
      return acc;
    }, 0);
    const totalResults = searchEvents.reduce((acc, s) => acc + (s.results || s.resultCount || 0), 0);
    const totalMs = searchEvents.reduce((acc, s) => acc + (s.ms || s.durationMs || 0), 0);
    search = {
      queries: totalQueries,
      results: totalResults,
      ms: totalMs
    };
  }

  if (!memory && !search) return null;
  return { memory, search };
}

export function computeTracePillState(rawTrace?: PersistedTrace | AgentTraceEvent[] | null): TracePillState {
  const trace = normalizeTrace(rawTrace);

  if (!trace) {
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

  const memory = trace.memory;
  const foundCount = typeof memory?.found === 'number' ? memory.found : 0;
  const isDateResolvedZero = Boolean(
    memory &&
    memory.dateResolved &&
    foundCount === 0 &&
    memory.dateStr
  );
  const hasMemoryFound = Boolean(memory && foundCount > 0);
  const hasMemory = hasMemoryFound || isDateResolvedZero;

  const search = trace.search;
  const hasSearch = Boolean(
    search && (search.queries > 0 || search.results > 0 || search.ms > 0)
  );

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
  let memorySnippets: PersistedTraceSnippet[] = [];

  if (isDateResolvedZero) {
    memoryCollapsed = `Checked earlier conversation · nothing on ${memory?.dateStr}`;
    memoryHeaderText = `No messages stored for ${memory?.dateStr}. Earliest stored message: ${memory?.earliestDate || 'no stored history'}.`;
    memorySnippets = [];
  } else if (hasMemoryFound) {
    memoryCollapsed = 'Used earlier conversation';
    memorySnippets = (memory?.snippets || []).slice(0, 3);
    if (memory?.dateResolved || memory?.matchType === 'date') {
      const dateLabel = memory?.dateStr || (memorySnippets[0]?.date ?? '');
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

  const searchQueries = search?.queries || 0;
  const searchResults = search?.results || 0;
  const searchMs = search?.ms || 0;
  const durationSec = (searchMs / 1000).toFixed(1);

  return {
    shouldRender: true,
    collapsedText,
    hasMemory,
    hasSearch,
    memoryFound: foundCount,
    memorySnippets,
    memoryHeaderText,
    searchQueries,
    searchResults,
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
                      {snippet.role && (
                        <span className="trace-snippet-role" style={{ opacity: 0.7, margin: '0 4px', fontSize: '0.85em' }}>
                          [{snippet.role}]
                        </span>
                      )}
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
