import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch {}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS bindings(thread TEXT PRIMARY KEY, project TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pins(thread TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, thread TEXT NOT NULL, project TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
    `);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  projects() { return this.db.prepare('SELECT * FROM projects ORDER BY name').all(); }
  project(id) { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
  addProject(project) { this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id, project.name, project.path); return project; }
  removeProject(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM bindings WHERE project=?').run(id);this.db.prepare('DELETE FROM projects WHERE id=?').run(id);this.db.prepare('DELETE FROM kv WHERE key=?').run('project-removal/'+id);this.db.exec('COMMIT'); }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  binding(thread) { return this.db.prepare('SELECT project FROM bindings WHERE thread=?').get(thread)?.project; }
  bind(thread, project) { this.db.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(thread) DO UPDATE SET project=excluded.project').run(thread, project); }
  pin(thread, pinned) { if (pinned) this.db.prepare('INSERT OR IGNORE INTO pins VALUES(?)').run(thread); else this.db.prepare('DELETE FROM pins WHERE thread=?').run(thread); }
  pins() { return this.db.prepare('SELECT thread FROM pins').all().map(r => r.thread); }
  submission(id) { const row = this.db.prepare('SELECT * FROM submissions WHERE id=?').get(id); return row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : null; }
  enqueue(job) { this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)').run(job.id, job.thread, job.project, JSON.stringify(job.payload), 'queued', null, job.created); }
  jobs() { return this.db.prepare("SELECT id,thread,project,status,result,created FROM submissions WHERE status IN ('queued','starting','running','uncertain','interrupted') ORDER BY created").all().map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null })); }
  updateJob(id, status, result = null) { this.db.prepare('UPDATE submissions SET status=?, result=? WHERE id=?').run(status, result ? JSON.stringify(result) : null, id); }
  recoverJobs() { this.db.prepare("UPDATE submissions SET status='uncertain' WHERE status IN ('starting','running')").run(); }
  close() { this.db.close(); }
}
