import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import {
  isDatabaseEmpty,
  getDatabaseStats,
  getAllMessages,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  insertMessage,
  MessageRole,
  Message,
  db
} from './db/memory.js';
import { seedDatabase } from './db/seed.js';
import { runAgent, AgentEvent } from './agent/runner.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Auto-seed database on server boot if empty
console.log('[Server] Checking persistent SQLite memory status...');
if (isDatabaseEmpty()) {
  console.log('[Server] Database is empty on boot. Executing dynamic auto-seed...');
  seedDatabase(false);
} else {
  const stats = getDatabaseStats();
  console.log(`[Server] Persistent memory active: ${stats.totalMessages} messages (${stats.sessionsCount} sessions, ${stats.datesCount} dates).`);
}

// ----------------------------------------------------
// Health & Diagnostics
// ----------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  const stats = getDatabaseStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    model: process.env.MODEL_NAME || 'gemini-2.5-flash',
    configuredKeys: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      tavily: Boolean(process.env.TAVILY_API_KEY)
    },
    database: {
      status: 'connected',
      path: 'data/chat.db',
      ...stats
    }
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'High-Performance Temporal Chat Agent',
    version: '1.0.0',
    health: '/health',
    endpoints: {
      chatSSE: 'POST /api/chat',
      history: 'GET /api/history?sessionId=',
      reset: 'POST /api/reset',
      messages: 'GET /api/messages?sessionId=&startDate=&endDate=&keyword=&limit='
    }
  });
});

// ----------------------------------------------------
// POST /api/chat (Server-Sent Events Streaming)
// ----------------------------------------------------

app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, sessionId = 'default-session' } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Field "message" is required and cannot be empty.' });
  }

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClientConnected = true;
  req.on('close', () => {
    isClientConnected = false;
  });

  const sendEvent = (event: AgentEvent) => {
    if (!isClientConnected) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Ensure immediate flush if flush method is available
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    await runAgent(message.trim(), sessionId, sendEvent);
  } catch (error: any) {
    sendEvent({ type: 'error', error: error?.message || 'Unexpected server error' });
    sendEvent({ type: 'done' });
  } finally {
    if (isClientConnected) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
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
      messages = getRecentMessages(sessionId, 200);
    } else {
      messages = getAllMessages(500);
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
// POST /api/reset (Re-seed Memory to Canonical State)
// ----------------------------------------------------

app.post('/api/reset', (_req: Request, res: Response) => {
  try {
    const result = seedDatabase(true);
    const stats = getDatabaseStats();
    return res.json({
      success: true,
      message: 'Database memory successfully reset and auto-seeded.',
      seededCount: result.messages.length,
      stats
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
      const messages = searchMessagesByDateRange(sessionId, startDate, endDate);
      return res.json({ queryType: 'date_range', count: messages.length, messages });
    }

    if (keyword) {
      const messages = searchMessagesByKeyword(sessionId, keyword);
      return res.json({ queryType: 'keyword', count: messages.length, messages });
    }

    if (sessionId) {
      const messages = getRecentMessages(sessionId, limit);
      return res.json({ queryType: 'recent_session', count: messages.length, messages });
    }

    const messages = getAllMessages(limit);
    return res.json({ queryType: 'all', count: messages.length, messages });
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
      keywords
    );
    return res.status(201).json({ success: true, message: msg });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export const server = app.listen(PORT, () => {
  console.log(`[Server] Chat Agent server running on http://localhost:${PORT}`);
});

export default app;

