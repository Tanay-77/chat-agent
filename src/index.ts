import dotenv from 'dotenv';
dotenv.config();

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express, { Request, Response } from 'express';
import {
  isDatabaseEmpty,
  getDatabaseStats,
  getAllMessages,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesFTS,
  insertMessage,
  createSession,
  ensureSession,
  cleanupEmptySessions,
  getUserSessions,
  getUserSessionsWithSummary,
  getSessionMessages,
  clearDatabase,
  MessageRole,
  Message,
  Session,
  SessionSummary,
  db
} from './db/memory.js';
import { runAgent, AgentEvent } from './agent/runner.js';
import { clearSearchCache } from './tools/webSearch.js';
import { setUserTimezone } from './context/temporalResolver.js';
import { buildClient } from './client/build.js';
import { simplifyErrorMessage } from './utils/errorFormatter.js';

// ----------------------------------------------------
// Signed Cookie Management & User Isolation
// ----------------------------------------------------

export const COOKIE_SECRET = process.env.COOKIE_SECRET || 'chat-agent-secret-key-32-chars-long!!';
export const USER_COOKIE_NAME = 'user_id';

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

/**
 * Signs a cookie value using HMAC-SHA256 (format: `s:<val>.<sig>`).
 */
export function signCookieValue(val: string, secret: string = COOKIE_SECRET): string {
  const hmac = crypto.createHmac('sha256', secret).update(val).digest('base64url');
  return `s:${val}.${hmac}`;
}

/**
 * Validates and unsigns a cookie value. Returns the original string or false if invalid/tampered.
 */
export function unsignCookieValue(input: string, secret: string = COOKIE_SECRET): string | false {
  if (!input || !input.startsWith('s:')) return false;
  const raw = input.slice(2);
  const lastDot = raw.lastIndexOf('.');
  if (lastDot === -1) return false;
  const val = raw.slice(0, lastDot);
  const signature = raw.slice(lastDot + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(val).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  return val;
}

/**
 * Parses raw Cookie header string into a key-value dictionary.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Signed httpOnly user identification middleware
app.use((req: Request, res: Response, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const cookieVal = cookies[USER_COOKIE_NAME];
  let userId: string | false = false;

  if (cookieVal) {
    userId = unsignCookieValue(cookieVal);
  }

  // Generate new UUID on first visit or if cookie was tampered
  if (!userId) {
    userId = crypto.randomUUID();
    const signed = signCookieValue(userId);
    res.setHeader(
      'Set-Cookie',
      `${USER_COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
    );
  }

  req.userId = userId;
  next();
});

// Ensure React client bundle is compiled
const bundlePath = path.resolve(process.cwd(), 'public/bundle.js');
if (!fs.existsSync(bundlePath)) {
  await buildClient(false);
}

// Serve React SPA from public/
app.use(express.static(path.resolve(process.cwd(), 'public')));

// Check persistent SQLite memory status (fresh DB starts empty)
console.log('[Server] Checking persistent SQLite memory status...');
cleanupEmptySessions();
if (isDatabaseEmpty()) {
  console.log('[Server] Database is empty on boot. Ready for user sessions (or run `npm run seed:demo` to load demo history).');
} else {
  const stats = getDatabaseStats();
  console.log(`[Server] Persistent memory active: ${stats.totalMessages} messages (${stats.sessionsCount} sessions, ${stats.datesCount} dates, ${stats.demoCount} demo).`);
}

// ----------------------------------------------------
// Health & Diagnostics
// ----------------------------------------------------

app.get('/health', (req: Request, res: Response) => {
  const stats = getDatabaseStats(req.userId);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    model: process.env.MODEL_NAME || 'gemini-3.1-flash-lite',
    configuredKeys: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      tavily: Boolean(process.env.TAVILY_API_KEY)
    },
    user: {
      userId: req.userId
    },
    database: {
      status: 'connected',
      path: 'data/chat.db',
      ...stats
    }
  });
});

app.get('/', (_req: Request, res: Response) => {
  // Serve React SPA - falls through to express.static
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

// ----------------------------------------------------
// POST /api/chat (Server-Sent Events Streaming)
// ----------------------------------------------------

const activeChatAbortControllers = new Map<string, AbortController>();

app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, sessionId = 'default-session' } = req.body;
  const forceSequentialSearch = Boolean(
    req.body?.forceSequentialSearch || req.query?.forceSequentialSearch === 'true'
  );

  // Accept and store IANA timezone from client
  const clientTimezone = typeof req.body?.timezone === 'string' ? req.body.timezone : undefined;
  if (clientTimezone) {
    setUserTimezone(req.userId, clientTimezone);
    setUserTimezone(sessionId, clientTimezone);
  }

  const rawThinkingBudget = req.body?.thinkingBudget ?? req.query?.thinkingBudget;
  const thinkingBudget = typeof rawThinkingBudget === 'number'
    ? rawThinkingBudget
    : (typeof rawThinkingBudget === 'string' && !isNaN(parseInt(rawThinkingBudget, 10)) ? parseInt(rawThinkingBudget, 10) : undefined);

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Field "message" is required and cannot be empty.' });
  }

  // Ensure a session row is created (or existing row reused) scoped to user_id from cookie
  ensureSession(sessionId, req.userId);

  // Configure socket & SSE headers for real-time unbuffered delivery
  req.socket.setNoDelay(true);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abortController = new AbortController();
  const chatKey = `${req.userId}:${sessionId}`;
  activeChatAbortControllers.set(chatKey, abortController);

  let isClosed = false;
  res.on('close', () => {
    isClosed = true;
    abortController.abort();
    activeChatAbortControllers.delete(chatKey);
  });

  const sendEvent = (event: AgentEvent) => {
    if (isClosed || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const requestStartTime = performance.now();

  try {
    await runAgent(message.trim(), sessionId, sendEvent, new Date(), {
      forceSequentialSearch,
      thinkingBudget,
      timezone: clientTimezone,
      userId: req.userId,
      signal: abortController.signal,
      requestStartTime
    });
  } catch (error: any) {
    console.error('[SSE Server Error]:', error);
    sendEvent({ type: 'error', error: simplifyErrorMessage(error) });
    sendEvent({ type: 'done' });
  } finally {
    activeChatAbortControllers.delete(chatKey);
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

// ----------------------------------------------------
// POST /api/chat/stop (Stop/Abort Active Execution)
// ----------------------------------------------------

app.post('/api/chat/stop', (req: Request, res: Response) => {
  const { sessionId = 'default-session' } = req.body;
  const chatKey = `${req.userId}:${sessionId}`;
  const controller = activeChatAbortControllers.get(chatKey);
  if (controller) {
    controller.abort();
    activeChatAbortControllers.delete(chatKey);
    return res.json({ success: true, stopped: true });
  }
  return res.json({ success: true, stopped: false });
});

// ----------------------------------------------------
// POST /api/session/new (Create New Chat Session)
// ----------------------------------------------------

app.post('/api/session/new', (req: Request, res: Response) => {
  try {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    // Note: No session row is created in DB yet; row is created only when first message arrives
    return res.status(201).json({
      success: true,
      sessionId,
      session_id: sessionId,
      userId: req.userId
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions', (req: Request, res: Response) => {
  try {
    const sessions = getUserSessionsWithSummary(req.userId);
    return res.json(sessions);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/messages', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const messages = getSessionMessages(id, req.userId);
    if (messages === null) {
      return res.status(404).json({ error: 'Session not found or does not belong to this user' });
    }
    return res.json(messages);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// GET /api/history (Timeline & Grouped Memory Inspection)
// ----------------------------------------------------

app.get('/api/history', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;

  try {
    let messages: Message[];
    if (sessionId) {
      messages = getRecentMessages(sessionId, 200, req.userId);
    } else {
      messages = getAllMessages(500, req.userId);
    }

    // Group messages by date_str (YYYY-MM-DD)
    const groupedByDate: Record<string, Message[]> = {};
    const sessionsSet = new Set<string>();

    for (const msg of messages) {
      sessionsSet.add(msg.session_id);
      if (!groupedByDate[msg.date_str]) {
        groupedByDate[msg.date_str] = [];
      }
      groupedByDate[msg.date_str].push(msg);
    }

    return res.json({
      userId: req.userId,
      totalMessages: messages.length,
      sessions: Array.from(sessionsSet),
      groupedByDate,
      messages
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// POST /api/reset (Clear Database Memory to Empty State)
// ----------------------------------------------------

app.post('/api/reset', (req: Request, res: Response) => {
  try {
    clearDatabase(req.userId);
    const stats = getDatabaseStats(req.userId);
    return res.json({
      success: true,
      userId: req.userId,
      message: 'User database memory successfully cleared to empty state.',
      stats
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// POST /api/cache/clear (Clear In-Memory Search Cache)
// ----------------------------------------------------

app.post('/api/cache/clear', (_req: Request, res: Response) => {
  try {
    clearSearchCache();
    return res.json({
      success: true,
      message: 'Search cache cleared successfully.'
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// Memory Query & Insert APIs
// ----------------------------------------------------

app.get('/api/messages', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  const keyword = req.query.keyword as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

  try {
    if (startDate && endDate) {
      const messages = searchMessagesByDateRange(sessionId, startDate, endDate, req.userId);
      return res.json({ userId: req.userId, queryType: 'date_range', count: messages.length, messages });
    }

    if (keyword) {
      const messages = searchMessagesFTS(keyword, { sessionId, limit, userId: req.userId });
      return res.json({ userId: req.userId, queryType: 'fts_bm25', count: messages.length, messages });
    }

    if (sessionId) {
      const messages = getRecentMessages(sessionId, limit, req.userId);
      return res.json({ userId: req.userId, queryType: 'recent_session', count: messages.length, messages });
    }

    const messages = getAllMessages(limit, req.userId);
    return res.json({ userId: req.userId, queryType: 'all', count: messages.length, messages });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages', (req: Request, res: Response) => {
  const { sessionId, role, content, createdAt, keywords } = req.body;

  if (!sessionId || !role || !content) {
    return res.status(400).json({
      error: 'Missing required fields: sessionId, role, content are required.'
    });
  }

  if (role !== 'user' && role !== 'assistant') {
    return res.status(400).json({
      error: 'Invalid role. Must be either "user" or "assistant".'
    });
  }

  try {
    const msg = insertMessage(
      sessionId,
      role as MessageRole,
      content,
      createdAt,
      keywords,
      false,
      undefined,
      req.userId
    );
    return res.status(201).json({ success: true, message: msg });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export const server = (process.argv[1] && (
  process.argv[1].replace(/\\/g, '/').endsWith('index.ts') ||
  process.argv[1].replace(/\\/g, '/').endsWith('index.js')
))
  ? app.listen(PORT, () => {
    console.log(`[Server] Chat Agent server running on http://localhost:${PORT}`);
  })
  : null;

export default app;

