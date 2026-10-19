import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// All documents (including registrants and payment authorizations) are encrypted at rest.
// Transactions must remain synchronous: no network operation inside a SQLite transaction.
export class Store {
  constructor(path, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('32-byte DATA_KEY required');
    this.key = key;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    // Detect a wrong encryption key at startup rather than during a paid order.
    try {
      const check = this.get('meta', 'keycheck');
      if (!check) this.put('meta', 'keycheck', { valid: true });
    } catch (error) { this.db.close(); throw error; }
  }
  encode(kind, id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decode(kind, id, body) {
    const bytes = Buffer.from(body, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${kind}:${id}`)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT body FROM docs WHERE kind=? AND id=?').get(kind, id);
    return row ? this.decode(kind, id, row.body) : null;
  }
  put(kind, id, value) {
    this.db.prepare('INSERT INTO docs VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, id, this.encode(kind, id, value));
    return value;
  }
  all(kind) { return this.db.prepare('SELECT id,body FROM docs WHERE kind=?').all(kind).map(r => this.decode(kind, r.id, r.body)); }
  delete(kind, id) { this.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run(kind, id); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result?.then) throw Error('async SQLite transaction forbidden'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  consumeNonce(id, at) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM nonces WHERE at < ?').run(at - 610000);
      return this.db.prepare('INSERT OR IGNORE INTO nonces VALUES (?,?)').run(id, at).changes === 1;
    });
  }
  close() { this.db.close(); }
}
