import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  date_str: string;
  keywords?: string | null; // Note: Deprecated. Column retained for schema compatibility, replaced by messages_fts FTS5 table.
  is_demo: number;
  rank?: number; // SQLite FTS5 BM25 score (when retrieved via full-text search)
}

// Ensure database directory exists
const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const DB_PATH = path.join(DB_DIR, 'chat.db');

export const db: InstanceType<typeof Database> = new Database(DB_PATH);

// Configure SQLite for high performance and integrity
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    date_str TEXT NOT NULL,
    keywords TEXT, -- Note: Deprecated; replaced by messages_fts FTS5 index
    is_demo INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_date_str ON messages(date_str);
  CREATE INDEX IF NOT EXISTS idx_messages_session_date ON messages(session_id, date_str);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

  -- SQLite FTS5 Full-Text Search Virtual Table & Triggers
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);

// Migration safeguard for existing databases
try {
  db.exec('ALTER TABLE messages ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;');
} catch {
  // Column already exists
}

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_is_demo ON messages(is_demo);');
} catch {
  // Index already exists
}

// Migration: Backfill existing rows into FTS5 index
try {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
} catch (err) {
  console.warn('[DB] messages_fts rebuild warning:', err);
}

/**
 * Inserts a new message into the persistent SQLite store.
 */
export function insertMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  createdAt?: string,
  keywords?: string | null,
  isDemo: boolean = false
): Message {
  const finalCreatedAt = createdAt || new Date().toISOString();
  // Extract YYYY-MM-DD from ISO string or date
  const finalDateStr = finalCreatedAt.slice(0, 10);
  const finalKeywords = keywords ? keywords.trim() : null;
  const isDemoVal = isDemo ? 1 : 0;

  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content, created_at, date_str, keywords, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionId,
    role,
    content,
    finalCreatedAt,
    finalDateStr,
    finalKeywords,
    isDemoVal
  );

  return {
    id: Number(result.lastInsertRowid),
    session_id: sessionId,
    role,
    content,
    created_at: finalCreatedAt,
    date_str: finalDateStr,
    keywords: finalKeywords,
    is_demo: isDemoVal
  };
}

/**
 * Retrieves the most recent messages for a given session (or across all sessions if wildcard/null),
 * returned in chronological order for conversation context.
 */
export function getRecentMessages(
  sessionId?: string | null,
  limit: number = 15
): Message[] {
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  if (isWildcard) {
    const stmt = db.prepare(`
      SELECT * FROM (
        SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo
        FROM messages
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `);
    return stmt.all(limit) as Message[];
  }

  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    ) ORDER BY created_at ASC, id ASC
  `);

  return stmt.all(sessionId, limit) as Message[];
}

/**
 * Searches messages within a date range (inclusive, YYYY-MM-DD).
 * If sessionId is null/wildcard, searches across all sessions for cross-session queries.
 */
export function searchMessagesByDateRange(
  sessionId: string | null | undefined,
  startDateStr: string,
  endDateStr: string
): Message[] {
  // Normalize date range bounds in case they are reversed
  const [start, end] = startDateStr <= endDateStr ? [startDateStr, endDateStr] : [endDateStr, startDateStr];
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  if (isWildcard) {
    const stmt = db.prepare(`
      SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo
      FROM messages
      WHERE date_str >= ? AND date_str <= ?
      ORDER BY created_at ASC, id ASC
    `);
    return stmt.all(start, end) as Message[];
  }

  const stmt = db.prepare(`
    SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo
    FROM messages
    WHERE session_id = ? AND date_str >= ? AND date_str <= ?
    ORDER BY created_at ASC, id ASC
  `);

  return stmt.all(sessionId, start, end) as Message[];
}

/**
 * Sanitizes a raw user query string for safe SQLite FTS5 MATCH execution.
 * - Strips syntax operators, quotes, colons, brackets, and arithmetic symbols.
 * - Normalizes whitespace and drops FTS5 boolean operators (AND, OR, NOT, NEAR).
 * - Returns empty string if query contains no indexable search terms.
 */
export function sanitizeFTSQuery(query: string): string {
  if (!query) return '';
  const cleaned = query
    .replace(/['"“”‘’`*?:;!@#$%^&()_+={}\[\]|\\<>\/,.~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const tokens = cleaned.split(' ').filter(Boolean);
  const reserved = new Set([
    'and', 'or', 'not', 'near',
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'are', 'was', 'were',
    'it', 'you', 'i', 'me', 'my', 'we', 'our', 'what', 'can', 'do', 'does', 'did',
    'that', 'this', 'with', 'be', 'as', 'by', 'from'
  ]);
  const safeTokens = tokens.filter(t => !reserved.has(t.toLowerCase()) && t.length > 1);

  if (safeTokens.length === 0) return '';

  return safeTokens.map(t => `"${t}"`).join(' OR ');
}

export interface SearchFTSOptions {
  sessionId?: string | null;
  startDateStr?: string | null;
  endDateStr?: string | null;
  limit?: number;
}

/**
 * Searches messages using SQLite FTS5 BM25 ranking, optionally combined with date range and session filtering.
 */
export function searchMessagesFTS(
  rawQuery: string,
  options: SearchFTSOptions = {}
): Message[] {
  const sanitized = sanitizeFTSQuery(rawQuery);
  const { sessionId, startDateStr, endDateStr, limit = 20 } = options;
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  const conditions: string[] = [];
  const params: any[] = [];

  if (!isWildcard) {
    conditions.push('m.session_id = ?');
    params.push(sessionId);
  }

  if (startDateStr && endDateStr) {
    const [start, end] = startDateStr <= endDateStr ? [startDateStr, endDateStr] : [endDateStr, startDateStr];
    conditions.push('m.date_str >= ? AND m.date_str <= ?');
    params.push(start, end);
  } else if (startDateStr) {
    conditions.push('m.date_str = ?');
    params.push(startDateStr);
  }

  if (sanitized) {
    conditions.push('messages_fts MATCH ?');
    params.push(sanitized);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.date_str, m.keywords, m.is_demo,
             bm25(messages_fts) as rank
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      ${whereClause}
      ORDER BY rank ASC, m.created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    return db.prepare(sql).all(...params) as Message[];
  }

  // If no FTS search terms, return date/session filtered messages
  if (conditions.length > 0) {
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo, 0 as rank
      FROM messages m
      ${whereClause}
      ORDER BY created_at ASC
      LIMIT ?
    `;
    params.push(limit);
    return db.prepare(sql).all(...params) as Message[];
  }

  return [];
}

/**
 * Checks if the messages table is empty.
 */
export function isDatabaseEmpty(): boolean {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM messages');
  const result = stmt.get() as { count: number };
  return result.count === 0;
}

/**
 * Returns all messages currently stored in the database.
 */
export function getAllMessages(limit: number = 500): Message[] {
  const stmt = db.prepare(`
    SELECT id, session_id, role, content, created_at, date_str, keywords, is_demo
    FROM messages
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  return stmt.all(limit) as Message[];
}

/**
 * Clears all messages from the database and rebuilds FTS5 index.
 */
export function clearDatabase(): void {
  db.exec('DELETE FROM messages;');
  try {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  } catch {
    // Ignore if table is already cleared
  }
}

/**
 * Returns database statistics.
 */
export function getDatabaseStats() {
  const totalStmt = db.prepare('SELECT COUNT(*) as total FROM messages');
  const sessionStmt = db.prepare('SELECT COUNT(DISTINCT session_id) as session_count FROM messages');
  const datesStmt = db.prepare('SELECT COUNT(DISTINCT date_str) as date_count FROM messages');
  const demoStmt = db.prepare('SELECT COUNT(*) as demo_count FROM messages WHERE is_demo = 1');

  return {
    totalMessages: (totalStmt.get() as { total: number }).total,
    sessionsCount: (sessionStmt.get() as { session_count: number }).session_count,
    datesCount: (datesStmt.get() as { date_count: number }).date_count,
    demoCount: (demoStmt.get() as { demo_count: number }).demo_count
  };
}

