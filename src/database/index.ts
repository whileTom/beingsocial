import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'messages.db');

export function initDatabase(): Database.Database {
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Messages received from platforms
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL CHECK(platform IN ('whatsapp', 'instagram')),
      chat_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- AI-generated response suggestions
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      content TEXT NOT NULL,
      style TEXT NOT NULL CHECK(style IN ('casual', 'detailed', 'brief', 'technical', 'transparent')),
      ai_provider TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- User actions on suggestions
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      suggestion_id INTEGER REFERENCES suggestions(id),
      action_type TEXT NOT NULL CHECK(action_type IN ('approved', 'edited', 'skipped', 'custom')),
      final_response TEXT,
      sent_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Conversation context cache
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_name TEXT,
      last_message_at INTEGER,
      UNIQUE(platform, chat_id)
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_messages_platform_chat ON messages(platform, chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
    CREATE INDEX IF NOT EXISTS idx_suggestions_message ON suggestions(message_id);
  `);

  // Migration: Add message_hash column if not exists
  try {
    db.prepare('ALTER TABLE messages ADD COLUMN message_hash TEXT').run();
    db.prepare('CREATE INDEX idx_messages_hash ON messages(message_hash)').run();
  } catch (e) {
    // Column likely exists
  }

  return db;

  return db;
}

export class MessageStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  addMessage(message: {
    platform: 'whatsapp' | 'instagram';
    chatId: string;
    senderName: string;
    senderId: string;
    content: string;
    timestamp: number;
    isFromMe: boolean;
  }): number {

    // STABLE HASH: SHA256(Platform + ChatID + Content + Timestamp + IsFromMe)
    // Now includes timestamp since we extract real timestamps from Instagram UI
    const hash = crypto.createHash('sha256')
      .update(`${message.platform}:${message.chatId}:${message.content}:${message.timestamp}:${message.isFromMe}`)
      .digest('hex');

    // Check if this specific hash already exists (idempotency)
    const check = this.db.prepare(`
        SELECT id FROM messages 
        WHERE message_hash = ?
    `);
    const existing = check.get(hash) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    const stmt = this.db.prepare(`
      INSERT INTO messages (platform, chat_id, sender_name, sender_id, content, timestamp, is_from_me, message_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      message.platform,
      message.chatId,
      message.senderName,
      message.senderId,
      message.content,
      message.timestamp,
      message.isFromMe ? 1 : 0,
      hash
    );

    return result.lastInsertRowid as number;
  }

  getUnprocessedMessages(): Array<{
    id: number;
    platform: string;
    chatId: string;
    senderName: string;
    content: string;
    timestamp: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, platform, chat_id as chatId, sender_name as senderName, content, timestamp
      FROM messages
      WHERE processed = 0 AND is_from_me = 0
      ORDER BY timestamp ASC
    `);

    return stmt.all() as any[];
  }

  getRecentMessages(limit: number = 50): Array<{
    platform: string;
    senderName: string;
    content: string;
    timestamp: number;
    isFromMe: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT platform, sender_name as senderName, content, timestamp, is_from_me as isFromMe
      FROM messages
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return (stmt.all(limit) as any[]).map(m => ({
      ...m,
      timestamp: m.timestamp * 1000
    })).reverse();
  }

  isDuplicate(platform: string, chatId: string, content: string, timestamp: number, isFromMe: boolean = false): boolean {
    // Use same hash as addMessage for consistency
    const hash = crypto.createHash('sha256')
      .update(`${platform}:${chatId}:${content}:${timestamp}:${isFromMe}`)
      .digest('hex');

    const check = this.db.prepare(`SELECT id FROM messages WHERE message_hash = ?`);
    return check.get(hash) !== undefined;
  }

  getThreads(): Array<{
    platform: string;
    chatId: string;
    senderName: string;
    lastMessage: string;
    lastTimestamp: number;
  }> {
    const stmt = this.db.prepare(`
        SELECT 
            platform, 
            chat_id as chatId, 
            MAX(timestamp) as lastTimestamp,
            (SELECT sender_name FROM messages m2 WHERE m2.platform=messages.platform AND m2.chat_id=messages.chat_id AND is_from_me=0 ORDER BY timestamp DESC LIMIT 1) as senderName,
            (SELECT content FROM messages m2 WHERE m2.platform=messages.platform AND m2.chat_id=messages.chat_id ORDER BY timestamp DESC LIMIT 1) as lastMessage
        FROM messages
        GROUP BY platform, chat_id
        ORDER BY lastTimestamp DESC
    `);

    // Fallback: if senderName is null (e.g. only sent messages), use "You" or generic
    return (stmt.all() as any[]).map(t => ({
      ...t,
      lastTimestamp: t.lastTimestamp * 1000, // Convert to ms
      senderName: t.senderName || 'Unknown User'
    }));
  }

  getThreadMessages(platform: string, chatId: string): Array<{
    platform: string;
    senderName: string;
    content: string;
    timestamp: number;
    isFromMe: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT platform, sender_name as senderName, content, timestamp, is_from_me as isFromMe
      FROM messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp ASC
    `);

    return (stmt.all(platform, chatId) as any[]).map(m => ({
      ...m,
      timestamp: m.timestamp * 1000
    }));
  }

  getConversationContext(platform: string, chatId: string, limit: number = 50): Array<{
    content: string;
    isFromMe: boolean;
    senderName: string;
    timestamp: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT content, is_from_me as isFromMe, sender_name as senderName, timestamp
      FROM messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return (stmt.all(platform, chatId, limit) as any[]).map(m => ({
      ...m,
      timestamp: m.timestamp * 1000
    })).reverse();
  }

  markAsProcessed(messageId: number): void {
    const stmt = this.db.prepare('UPDATE messages SET processed = 1 WHERE id = ?');
    stmt.run(messageId);
  }

  addSuggestion(suggestion: {
    messageId: number;
    content: string;
    style: 'casual' | 'detailed' | 'brief' | 'technical' | 'transparent';
    aiProvider: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO suggestions (message_id, content, style, ai_provider)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      suggestion.messageId,
      suggestion.content,
      suggestion.style,
      suggestion.aiProvider
    );

    return result.lastInsertRowid as number;
  }

  getSuggestionsForMessage(messageId: number): Array<{
    id: number;
    content: string;
    style: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, content, style
      FROM suggestions
      WHERE message_id = ?
    `);

    return stmt.all(messageId) as any[];
  }

  recordAction(action: {
    messageId: number;
    suggestionId?: number;
    actionType: 'approved' | 'edited' | 'skipped' | 'custom';
    finalResponse?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO actions (message_id, suggestion_id, action_type, final_response, sent_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        action.messageId,
        action.suggestionId ?? null,
        action.actionType,
        action.finalResponse ?? null,
        action.actionType !== 'skipped' ? Math.floor(Date.now() / 1000) : null
      );
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        console.warn(`⚠️ Ignoring action for unknown message ID ${action.messageId} (stale button?)`);
        return;
      }
      throw error;
    }
  }
}

export default { initDatabase, MessageStore };
