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
  MessageRole
} from './db/memory.js';
import { seedDatabase } from './db/seed.js';

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
// Health & Diagnostic Endpoints
// ----------------------------------------------------

app.get('/health', (_req: Request, res: Response) => {
  const stats = getDatabaseStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    database: {
      status: 'connected',
      path: 'data/chat.db',
      ...stats
    }
  });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'High-Performance Chat Agent',
    version: '1.0.0',
    health: '/health',
    endpoints: {
      getMessages: 'GET /api/messages?sessionId=&startDate=&endDate=&keyword=&limit=',
      postMessage: 'POST /api/messages',
      reseed: 'POST /api/seed'
    }
  });
});

// ----------------------------------------------------
// Memory Query & Storage APIs
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

app.post('/api/seed', (req: Request, res: Response) => {
  const force = Boolean(req.body && req.body.force);
  try {
    const result = seedDatabase(force);
    const stats = getDatabaseStats();
    return res.json({
      success: true,
      seeded: result.seeded,
      stats
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export const server = app.listen(PORT, () => {
  console.log(`[Server] Chat Agent server running on http://localhost:${PORT}`);
});

export default app;

