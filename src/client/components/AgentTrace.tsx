import React from 'react';
import { AgentTraceEvent, PersistedTrace } from '../types.js';

interface AgentTraceProps {
  trace?: PersistedTrace | AgentTraceEvent[] | null;
}

export interface TraceLineState {
  shouldRender: boolean;
  text: string;
  usedMemory: boolean;
  searchResults: number;
  totalMs: number;
  collapsedText: string;
  hasMemory: boolean;
  hasSearch: boolean;
  timingText: string;
}

export function computeTraceLine(rawTrace?: PersistedTrace | AgentTraceEvent[] | null): TraceLineState {
  const empty: TraceLineState = {
    shouldRender: false,
    text: '',
    usedMemory: false,
    searchResults: 0,
    totalMs: 0,
    collapsedText: '',
    hasMemory: false,
    hasSearch: false,
    timingText: ''
  };

  if (!rawTrace) return empty;

  let usedMemory = false;
  let searchResults = 0;
  let totalMs = 0;

  if (Array.isArray(rawTrace)) {
    const memoryEvent = rawTrace.find((e) => e.type === 'trace' && e.step === 'memory');
    const searchEvents = rawTrace.filter((e) => e.type === 'trace' && e.step === 'search');
    const doneEvent = rawTrace.find((e) => e.type === 'done');
    const timingEvent = rawTrace.find((e) => e.type === 'trace' && typeof e.totalMs === 'number');

    // Requirement 5: "Used memory" is shown only if at least one earlier message was actually injected into the prompt.
    usedMemory = Boolean(memoryEvent && typeof memoryEvent.found === 'number' && memoryEvent.found > 0);
    searchResults = searchEvents.reduce((acc, s) => acc + (s.results || s.resultCount || 0), 0);
    totalMs = doneEvent?.totalMs ?? timingEvent?.totalMs ?? 0;
  } else if (typeof rawTrace === 'object') {
    if (typeof (rawTrace as any).usedMemory === 'boolean' || typeof (rawTrace as any).searchResults === 'number') {
      usedMemory = Boolean((rawTrace as any).usedMemory);
      searchResults = Number((rawTrace as any).searchResults) || 0;
      totalMs = Number((rawTrace as any).totalMs) || 0;
    } else {
      // Legacy structure conversion fallback
      const mem = (rawTrace as any).memory;
      usedMemory = Boolean(mem && mem.found > 0);
      searchResults = Number((rawTrace as any).search?.results || 0);
      totalMs = Number((rawTrace as any).totalMs ?? (rawTrace as any).search?.totalMs ?? 0);
    }
  }

  // Show nothing if neither was used
  if (!usedMemory && searchResults === 0) {
    return empty;
  }

  const seconds = (Math.max(0, totalMs) / 1000).toFixed(1);
  let text = '';

  if (usedMemory && searchResults > 0) {
    text = `Used memory · Searched the web · ${seconds}s`;
  } else if (usedMemory) {
    text = `Used memory · ${seconds}s`;
  } else if (searchResults > 0) {
    text = `Searched the web · ${searchResults} results · ${seconds}s`;
  }

  return {
    shouldRender: true,
    text,
    usedMemory,
    searchResults,
    totalMs,
    collapsedText: text,
    hasMemory: usedMemory,
    hasSearch: searchResults > 0,
    timingText: text
  };
}

export const computeTracePillState = computeTraceLine;

export const AgentTrace: React.FC<AgentTraceProps> = ({ trace }) => {
  const state = computeTraceLine(trace);
  if (!state.shouldRender) return null;

  return <div className="trace-line">{state.text}</div>;
};
