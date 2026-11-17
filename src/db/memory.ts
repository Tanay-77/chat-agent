import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: number;
  user_id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  date_str: string;
  keywords?: string | null; // Note: Deprecated. Column retained for schema compatibility, replaced by messages_fts FTS5 table.
  is_demo: number;
  rank?: number; // SQLite FTS5 BM25 score (or negative relevance score when retrieved via fallback search)
  trace?: PersistedTrace | null;
}

export interface PersistedTrace {
  usedMemory: boolean;
  searchResults: number;
  totalMs: number;
}

export interface Session {
  id: string;
  user_id: string;
  title?: string | null;
  created_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  last_message_at: string;
}

// ─── FTS5 Capability Probing & Fallback ──────────────────────────────

let fts5ProbeOverride: boolean | null = null;
let hasLoggedFts5Warning = false;

/**
 * Probes whether the SQLite build supports the FTS5 extension by attempting
 * to create a temporary virtual table in a disposable in-memory DB.
 */
export function probeFTS5(): boolean {
  if (fts5ProbeOverride !== null) {
    return fts5ProbeOverride;
  }
  try {
    const probeDb = new DatabaseSync(':memory:');
    probeDb.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(content);');
    probeDb.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether FTS5 is supported. If not, logs one clear warning once.
 */
export function isFTS5Available(): boolean {
  const available = probeFTS5();
  if (!available && !hasLoggedFts5Warning) {
    console.warn('[DB Warning] SQLite FTS5 extension is not available; falling back to LIKE search for memory retrieval.');
    hasLoggedFts5Warning = true;
  }
  return available;
}

/**
 * For testing: mocks/overrides the FTS5 probe result. Pass null to reset to auto-detection.
 */
export function setFTS5AvailableForTesting(available: boolean | null): void {
  fts5ProbeOverride = available;
  if (available === false) {
    hasLoggedFts5Warning = false; // allow warning to log once when explicitly mocked to false
  }
}

// ─── Database Path & Initialization ──────────────────────────────────

const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const DB_PATH = process.env.TEST_DB_PATH || path.join(DB_DIR, 'chat.db');

/**
 * Formats a raw database row into a structured Message object, ensuring
 * bigints from node:sqlite are safely converted to numbers.
 */
function formatMessageRow(row: any): Message {
  let parsedTrace: PersistedTrace | null = null;
  if (row.trace) {
    let obj: any = null;
    if (typeof row.trace === 'string') {
      try {
        obj = JSON.parse(row.trace);
      } catch {
        obj = null;
      }
    } else if (typeof row.trace === 'object') {
      obj = row.trace;
    }

    if (obj && typeof obj === 'object') {
      if (typeof obj.usedMemory === 'boolean' || typeof obj.searchResults === 'number') {
        const usedMemory = Boolean(obj.usedMemory);
        const searchResults = Number(obj.searchResults) || 0;
        const totalMs = Number(obj.totalMs) || 0;
        if (usedMemory || searchResults > 0) {
          parsedTrace = { usedMemory, searchResults, totalMs };
        }
      } else if (obj.memory || obj.search) {
        // Drop old stored trace nested structure and convert to simplified shape
        const usedMemory = Boolean(obj.memory && obj.memory.found > 0);
        const searchResults = Number(obj.search?.results || 0);
        const totalMs = Number(obj.totalMs ?? obj.search?.totalMs ?? 0);
        if (usedMemory || searchResults > 0) {
          parsedTrace = { usedMemory, searchResults, totalMs };
        }
      }
    }
  }

  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    session_id: String(row.session_id),
    role: row.role as MessageRole,
    content: String(row.content),
    created_at: String(row.created_at),
    date_str: String(row.date_str),
    keywords: row.keywords ? String(row.keywords) : null,
    is_demo: Number(row.is_demo),
    rank: typeof row.rank === 'number' ? row.rank : (row.rank !== undefined && row.rank !== null ? Number(row.rank) : undefined),
    trace: parsedTrace
  };
}

/**
 * Initializes schema, pragmas, triggers, and migrations on a given DatabaseSync instance.
 */
export function initializeDatabase(targetDb: DatabaseSync): DatabaseSync {
  // Configure SQLite for high performance and integrity via PRAGMA statements
  targetDb.exec('PRAGMA journal_mode = WAL;');
  targetDb.exec('PRAGMA synchronous = NORMAL;');
  targetDb.exec('PRAGMA foreign_keys = ON;');

  // Initialize tables and standard indexes
  targetDb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default-user',
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      date_str TEXT NOT NULL,
      keywords TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      trace TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_date_str ON messages(date_str);
    CREATE INDEX IF NOT EXISTS idx_messages_session_date ON messages(session_id, date_str);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
  `);

  // Initialize FTS5 virtual table & triggers if FTS5 is supported
  if (probeFTS5()) {
    try {
      targetDb.exec(`
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
    } catch (err) {
      console.warn('[DB] messages_fts setup warning:', err);
    }
  }

  // Migration safeguard for existing databases: user_id column
  try {
    targetDb.exec("ALTER TABLE messages ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default-user';");
  } catch {
    // Column already exists
  }

  try {
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);');
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(user_id, session_id);');
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_messages_user_date ON messages(user_id, date_str);');
  } catch {
    // Indexes already exist
  }

  // Migration safeguard for existing databases: is_demo column
  try {
    targetDb.exec('ALTER TABLE messages ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;');
  } catch {
    // Column already exists
  }

  try {
    targetDb.exec('CREATE INDEX IF NOT EXISTS idx_messages_is_demo ON messages(is_demo);');
  } catch {
    // Index already exists
  }

  // Migration safeguard for existing databases: trace column (nullable JSON string)
  try {
    targetDb.exec('ALTER TABLE messages ADD COLUMN trace TEXT;');
  } catch {
    // Column already exists
  }

  // Migration: Backfill existing rows into FTS5 index if available
  if (probeFTS5()) {
    try {
      targetDb.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
    } catch {
      // Ignore if messages_fts does not exist or rebuild fails
    }
  }

  return targetDb;
}

/**
 * Creates and initializes a new DatabaseSync instance (e.g. ':memory:' or a file path).
 */
export function createDatabase(location: string = DB_PATH): DatabaseSync {
  const defaultChatDb = path.resolve(process.cwd(), 'data', 'chat.db');
  if (path.resolve(location) === defaultChatDb && (process.env.NODE_ENV === 'test' || process.env.TEST_DB_PATH === ':memory:')) {
    throw new Error(`[Test Guard] Attempted to open default production database (${location}) in test environment!`);
  }
  const instance = new DatabaseSync(location);
  return initializeDatabase(instance);
}

// Primary database instance
export let db: DatabaseSync = createDatabase(DB_PATH);

/**
 * Replaces the active database instance (useful for temporary/in-memory DBs in tests).
 */
export function setDatabase(newDb: DatabaseSync): void {
  db = newDb;
}

// Probe FTS5 at startup and log warning if unavailable
isFTS5Available();

// ─── Transaction Helper ──────────────────────────────────────────────

/**
 * Executes a function within an explicit SQLite transaction (BEGIN / COMMIT / ROLLBACK).
 */
export function transaction<T>(fn: () => T, targetDb: DatabaseSync = db): T {
  targetDb.exec('BEGIN');
  try {
    const result = fn();
    targetDb.exec('COMMIT');
    return result;
  } catch (err) {
    targetDb.exec('ROLLBACK');
    throw err;
  }
}

// ─── Cleanup & Utility Functions ─────────────────────────────────────

/**
 * One-time startup cleanup: deletes any sessions that have zero messages.
 */
export function cleanupEmptySessions(): number {
  const info = db.prepare(`
    DELETE FROM sessions
    WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)
  `).run();
  const changes = Number(info.changes);
  if (changes > 0) {
    console.log(`[DB Cleanup] Deleted ${changes} empty session(s) with zero messages.`);
  }
  return changes;
}

// Run cleanup at startup
try {
  cleanupEmptySessions();
} catch (err) {
  console.warn('[DB] cleanupEmptySessions warning:', err);
}

/**
 * Formats a session title from message content:
 * Truncated to 50 chars, with trailing punctuation and whitespace trimmed.
 */
export function formatSessionTitle(content: string): string {
  if (!content) return 'Chat';
  const sliced = content.slice(0, 50);
  const trimmed = sliced.replace(/[.,!?:;\-_—…~`'"“”‘’\s]+$/g, '').trim();
  return trimmed || sliced.trim() || 'Chat';
}

/**
 * Inserts a new message into the persistent SQLite store scoped to a user.
 */
export function insertMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  createdAt?: string,
  keywords?: string | null,
  isDemo: boolean = false,
  timezone?: string,
  userId: string = 'default-user',
  trace?: PersistedTrace | string | null
): Message {
  // Ensure a session row is created (or existing row reused) scoped to userId
  createSession(userId, null, sessionId);
  const finalCreatedAt = createdAt || new Date().toISOString();
  // Compute YYYY-MM-DD in the user's timezone (not UTC)
  let finalDateStr: string;
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date(finalCreatedAt));
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      finalDateStr = `${y}-${m}-${d}`;
    } catch {
      finalDateStr = finalCreatedAt.slice(0, 10);
    }
  } else {
    finalDateStr = finalCreatedAt.slice(0, 10);
  }
  const finalKeywords = keywords ? keywords.trim() : null;
  const isDemoVal = isDemo ? 1 : 0;

  let traceVal: string | null = null;
  let parsedTrace: PersistedTrace | null = null;
  if (trace) {
    let p: any = trace;
    if (typeof trace === 'string') {
      try {
        p = JSON.parse(trace);
      } catch {
        p = null;
      }
    }
    if (p && typeof p === 'object') {
      const usedMemory = typeof p.usedMemory === 'boolean' ? p.usedMemory : Boolean(p.memory && p.memory.found > 0);
      const searchResults = typeof p.searchResults === 'number' ? p.searchResults : Number(p.search?.results || 0);
      const totalMs = typeof p.totalMs === 'number' ? p.totalMs : Number(p.search?.totalMs || 0);
      if (usedMemory || searchResults > 0) {
        parsedTrace = { usedMemory, searchResults, totalMs };
        traceVal = JSON.stringify(parsedTrace);
      }
    }
  }

  const stmt = db.prepare(`
    INSERT INTO messages (user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    userId,
    sessionId,
    role,
    content,
    finalCreatedAt,
    finalDateStr,
    finalKeywords,
    isDemoVal,
    traceVal
  );

  return {
    id: Number(result.lastInsertRowid),
    user_id: userId,
    session_id: sessionId,
    role,
    content,
    created_at: finalCreatedAt,
    date_str: finalDateStr,
    keywords: finalKeywords,
    is_demo: isDemoVal,
    trace: parsedTrace
  };
}

/**
 * Retrieves the most recent messages for a given session (or across all sessions if wildcard/null),
 * scoped to the specified user and returned in chronological order.
 */
export function getRecentMessages(
  sessionId?: string | null,
  limit: number = 15,
  userId: string = 'default-user'
): Message[] {
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  if (isWildcard) {
    const stmt = db.prepare(`
      SELECT * FROM (
        SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
        FROM messages
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `);
    return (stmt.all(userId, limit) as any[]).map(formatMessageRow);
  }

  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
      FROM messages
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    ) ORDER BY created_at ASC, id ASC
  `);

  return (stmt.all(userId, sessionId, limit) as any[]).map(formatMessageRow);
}

/**
 * Searches messages within a date range (inclusive, YYYY-MM-DD) scoped to user_id.
 * If sessionId is null/wildcard, searches across all sessions for that user.
 */
export function searchMessagesByDateRange(
  sessionId: string | null | undefined,
  startDateStr: string,
  endDateStr: string,
  userId: string = 'default-user'
): Message[] {
  // Normalize date range bounds in case they are reversed
  const [start, end] = startDateStr <= endDateStr ? [startDateStr, endDateStr] : [endDateStr, startDateStr];
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  if (isWildcard) {
    const stmt = db.prepare(`
      SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
      FROM messages
      WHERE user_id = ? AND date_str >= ? AND date_str <= ?
      ORDER BY created_at ASC, id ASC
    `);
    return (stmt.all(userId, start, end) as any[]).map(formatMessageRow);
  }

  const stmt = db.prepare(`
    SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
    FROM messages
    WHERE user_id = ? AND session_id = ? AND date_str >= ? AND date_str <= ?
    ORDER BY created_at ASC, id ASC
  `);

  return (stmt.all(userId, sessionId, start, end) as any[]).map(formatMessageRow);
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
  userId?: string;
}

/**
 * Searches messages using SQLite FTS5 BM25 ranking when available,
 * or falls back to LIKE search across messages when FTS5 is not supported.
 */
export function searchMessagesFTS(
  rawQuery: string,
  options: SearchFTSOptions = {}
): Message[] {
  const { sessionId, startDateStr, endDateStr, limit = 20, userId = 'default-user' } = options;
  const isWildcard = !sessionId || sessionId === '*' || sessionId.toLowerCase() === 'all';

  const conditions: string[] = ['m.user_id = ?'];
  const params: any[] = [userId];

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

  const ftsAvailable = isFTS5Available();

  // If FTS5 is not available, fall back to LIKE search over same user_id and date filter
  if (!ftsAvailable) {
    const cleaned = rawQuery
      .replace(/['"“”‘’`*?:;!@#$%^&()_+={}\[\]|\\<>\/,.~-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = cleaned.split(' ').filter(t => t.length > 1);

    if (tokens.length > 0) {
      const likeParts = tokens.map(() => 'm.content LIKE ?').join(' OR ');
      conditions.push(`(${likeParts})`);
      for (const t of tokens) {
        params.push(`%${t}%`);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const sql = `
        SELECT m.id, m.user_id, m.session_id, m.role, m.content, m.created_at, m.date_str, m.keywords, m.is_demo, m.trace,
               -0.5 as rank
        FROM messages m
        ${whereClause}
        ORDER BY m.created_at DESC
        LIMIT ?
      `;
      params.push(limit);
      return (db.prepare(sql).all(...params) as any[]).map(formatMessageRow);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT m.id, m.user_id, m.session_id, m.role, m.content, m.created_at, m.date_str, m.keywords, m.is_demo, m.trace,
             0 as rank
      FROM messages m
      ${whereClause}
      ORDER BY m.created_at ASC
      LIMIT ?
    `;
    params.push(limit);
    return (db.prepare(sql).all(...params) as any[]).map(formatMessageRow);
  }

  // FTS5 is available: use existing FTS5/BM25 path
  const sanitized = sanitizeFTSQuery(rawQuery);
  if (sanitized) {
    conditions.push('messages_fts MATCH ?');
    params.push(sanitized);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT m.id, m.user_id, m.session_id, m.role, m.content, m.created_at, m.date_str, m.keywords, m.is_demo, m.trace,
             bm25(messages_fts) as rank
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      ${whereClause}
      ORDER BY rank ASC, m.created_at DESC
      LIMIT ?
    `;
    params.push(limit);
    return (db.prepare(sql).all(...params) as any[]).map(formatMessageRow);
  }

  // If no FTS search terms, return date/session filtered messages
  if (conditions.length > 0) {
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace, 0 as rank
      FROM messages m
      ${whereClause}
      ORDER BY created_at ASC
      LIMIT ?
    `;
    params.push(limit);
    return (db.prepare(sql).all(...params) as any[]).map(formatMessageRow);
  }

  return [];
}

/**
 * Checks if the messages table is empty (optionally scoped to a user).
 */
export function isDatabaseEmpty(userId?: string): boolean {
  if (userId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE user_id = ?');
    const result = stmt.get(userId) as { count: number | bigint };
    return Number(result.count) === 0;
  }
  const stmt = db.prepare('SELECT COUNT(*) as count FROM messages');
  const result = stmt.get() as { count: number | bigint };
  return Number(result.count) === 0;
}

/**
 * Returns all messages currently stored in the database, optionally scoped to a user.
 */
export function getAllMessages(limit: number = 500, userId?: string): Message[] {
  if (userId) {
    const stmt = db.prepare(`
      SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
      FROM messages
      WHERE user_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `);
    return (stmt.all(userId, limit) as any[]).map(formatMessageRow);
  }

  const stmt = db.prepare(`
    SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
    FROM messages
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  return (stmt.all(limit) as any[]).map(formatMessageRow);
}

/**
 * Creates a new session record scoped to a user, or reuses an existing session row.
 * Scoped to userId.
 */
export function createSession(
  userId: string = 'default-user',
  title?: string | null,
  sessionId?: string
): Session {
  const id = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const sessionTitle = title ? title.trim() : null;

  // Check if session row already exists for this id
  const existing = db.prepare('SELECT id, user_id, title, created_at FROM sessions WHERE id = ?').get(id) as any;
  if (existing) {
    return {
      id: String(existing.id),
      user_id: String(existing.user_id),
      title: existing.title ? String(existing.title) : null,
      created_at: String(existing.created_at)
    };
  }

  const createdAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, title, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, userId, sessionTitle, createdAt);

  return {
    id,
    user_id: userId,
    title: sessionTitle,
    created_at: createdAt
  };
}

export const ensureSession = createSession;

/**
 * Retrieves all sessions for a specific user, sorted most recent first.
 */
export function getUserSessions(userId: string = 'default-user'): Session[] {
  const stmt = db.prepare(`
    SELECT id, user_id, title, created_at
    FROM sessions
    WHERE user_id = ?
    ORDER BY created_at DESC
  `);
  return (stmt.all(userId) as any[]).map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    title: row.title ? String(row.title) : null,
    created_at: String(row.created_at)
  }));
}

/**
 * Retrieves the session history list for a user, sorted newest first.
 * Returns ONLY sessions with at least one message.
 * Title = the first user message truncated to 50 chars, with trailing punctuation trimmed.
 * Sort by last_message_at, newest first. Returns up to 50 items.
 */
export function getUserSessionsWithSummary(userId: string = 'default-user'): SessionSummary[] {
  const stmt = db.prepare(`
    SELECT 
      m.session_id AS id,
      (
        SELECT m2.content
        FROM messages m2
        WHERE m2.session_id = m.session_id AND m2.user_id = ? AND m2.role = 'user'
        ORDER BY m2.created_at ASC, m2.id ASC
        LIMIT 1
      ) AS first_user_content,
      (
        SELECT m3.content
        FROM messages m3
        WHERE m3.session_id = m.session_id AND m3.user_id = ?
        ORDER BY m3.created_at ASC, m3.id ASC
        LIMIT 1
      ) AS first_any_content,
      MAX(m.created_at) AS last_message_at
    FROM messages m
    WHERE m.user_id = ?
    GROUP BY m.session_id
    HAVING COUNT(m.id) > 0
    ORDER BY last_message_at DESC
    LIMIT 50
  `);

  const rows = stmt.all(userId, userId, userId) as Array<{
    id: string;
    first_user_content: string | null;
    first_any_content: string | null;
    last_message_at: string;
  }>;

  return rows.map((row) => {
    const raw = (row.first_user_content ?? row.first_any_content ?? '').trim();
    const title = formatSessionTitle(raw);
    return {
      id: String(row.id),
      title,
      last_message_at: String(row.last_message_at)
    };
  });
}

/**
 * Retrieves all messages for a session only if it belongs to the specified user.
 * Returns null if the session does not belong to the user or does not exist.
 */
export function getSessionMessages(sessionId: string, userId: string = 'default-user'): Message[] | null {
  const sessRow = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? LIMIT 1').get(sessionId, userId);
  const msgRow = !sessRow ? db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND user_id = ? LIMIT 1').get(sessionId, userId) : true;

  if (!sessRow && !msgRow) {
    return null;
  }

  const stmt = db.prepare(`
    SELECT id, user_id, session_id, role, content, created_at, date_str, keywords, is_demo, trace
    FROM messages
    WHERE session_id = ? AND user_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  return (stmt.all(sessionId, userId) as any[]).map(formatMessageRow);
}

/**
 * Returns the earliest date_str for messages stored for this user, or null if no messages exist.
 */
export function getEarliestMessageDate(userId: string = 'default-user'): string | null {
  const row = db
    .prepare("SELECT MIN(date_str) AS earliest_date FROM messages WHERE user_id = ? AND date_str IS NOT NULL AND date_str != ''")
    .get(userId) as { earliest_date: string | null } | undefined;
  return row?.earliest_date || null;
}

/**
 * Clears messages and sessions from the database (optionally scoped to a user) and rebuilds FTS5 index if available.
 */
export function clearDatabase(userId?: string): void {
  if (userId) {
    const stmtMsg = db.prepare('DELETE FROM messages WHERE user_id = ?');
    stmtMsg.run(userId);
    const stmtSess = db.prepare('DELETE FROM sessions WHERE user_id = ?');
    stmtSess.run(userId);
  } else {
    db.exec('DELETE FROM messages;');
    db.exec('DELETE FROM sessions;');
  }
  if (isFTS5Available()) {
    try {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
    } catch {
      // Ignore if table is already cleared or fts not present
    }
  }
}

/**
 * Returns database statistics (optionally scoped to a user).
 */
export function getDatabaseStats(userId?: string) {
  if (userId) {
    const totalStmt = db.prepare('SELECT COUNT(*) as total FROM messages WHERE user_id = ?');
    const sessionStmt = db.prepare('SELECT COUNT(DISTINCT session_id) as session_count FROM messages WHERE user_id = ?');
    const datesStmt = db.prepare('SELECT COUNT(DISTINCT date_str) as date_count FROM messages WHERE user_id = ?');
    const demoStmt = db.prepare('SELECT COUNT(*) as demo_count FROM messages WHERE user_id = ? AND is_demo = 1');

    return {
      totalMessages: Number((totalStmt.get(userId) as { total: number | bigint }).total),
      sessionsCount: Number((sessionStmt.get(userId) as { session_count: number | bigint }).session_count),
      datesCount: Number((datesStmt.get(userId) as { date_count: number | bigint }).date_count),
      demoCount: Number((demoStmt.get(userId) as { demo_count: number | bigint }).demo_count)
    };
  }

  const totalStmt = db.prepare('SELECT COUNT(*) as total FROM messages');
  const sessionStmt = db.prepare('SELECT COUNT(DISTINCT session_id) as session_count FROM messages');
  const datesStmt = db.prepare('SELECT COUNT(DISTINCT date_str) as date_count FROM messages');
  const demoStmt = db.prepare('SELECT COUNT(*) as demo_count FROM messages WHERE is_demo = 1');

  return {
    totalMessages: Number((totalStmt.get() as { total: number | bigint }).total),
    sessionsCount: Number((sessionStmt.get() as { session_count: number | bigint }).session_count),
    datesCount: Number((datesStmt.get() as { date_count: number | bigint }).date_count),
    demoCount: Number((demoStmt.get() as { demo_count: number | bigint }).demo_count)
  };
}
