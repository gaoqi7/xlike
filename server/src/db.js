import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "xlike.db");

let dbPromise;

export function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
  }
  return dbPromise;
}

export async function initDb() {
  const db = await getDb();
  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      name TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_likes_user_created
      ON likes (user_id, created_at DESC);
  `);
}

export async function upsertUser(db, user) {
  await db.run(
    `
      INSERT INTO users (id, username, name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        name = excluded.name,
        updated_at = excluded.updated_at
    `,
    [user.id, user.username, user.name || null, new Date().toISOString()]
  );
}

export async function upsertLike(db, like, ownerId) {
  await db.run(
    `
      INSERT INTO likes (id, user_id, author_id, text, created_at, raw_json, inserted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        author_id = excluded.author_id,
        text = excluded.text,
        created_at = excluded.created_at,
        raw_json = excluded.raw_json
    `,
    [
      like.id,
      ownerId,
      like.author_id,
      like.text,
      like.created_at,
      JSON.stringify(like),
      new Date().toISOString(),
    ]
  );
}
