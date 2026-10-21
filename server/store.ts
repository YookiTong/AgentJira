import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Project, ProjectEvent, Settings } from '../shared/types.ts';
import { supervisorName } from '../shared/workflow.ts';
export class Store {
  db: DatabaseSync;
  events = new EventEmitter();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, backend TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (project_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id,task_id));
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_migrations (project_id TEXT NOT NULL, migration TEXT NOT NULL, original_data TEXT NOT NULL, PRIMARY KEY(project_id,migration));`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.db.prepare('SELECT id, data FROM projects').all() as { id: string; data: string }[]) {
        const project = JSON.parse(row.data) as Project;
        if (project.priorityScale === 10 && project.supervisorName) continue;
        this.db.prepare('INSERT OR IGNORE INTO project_migrations VALUES (?,?,?)').run(row.id, 'priority-10-and-agent-names', row.data);
        if (project.priorityScale !== 10) {
          const convert = (value: number) => Math.max(0, Math.min(10, Math.round(value / 10)));
          project.tasks.forEach(task => { task.priority = convert(task.priority); });
          project.revisions.forEach(revision => revision.plan?.tasks.forEach(task => { task.priority = convert(task.priority); }));
          project.priorityScale = 10;
        }
        project.supervisorName ||= supervisorName(project);
        project.version++;
        this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), row.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.events.setMaxListeners(100);
  }
  list(): Project[] { return (this.db.prepare('SELECT data FROM projects').all() as { data: string }[]).map(x => JSON.parse(x.data)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string): Project { const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as { data: string } | undefined; if (!row) throw Object.assign(new Error('项目不存在'), { statusCode: 404 }); return JSON.parse(row.data); }
  create(project: Project, key?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO projects VALUES (?,?)').run(project.id, JSON.stringify(project));
      if (key) this.db.prepare('INSERT INTO requests VALUES (?,?)').run(key, project.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit(project.id, 'project.created', {}); return project;
  }
  requestProject(key: string) { return (this.db.prepare('SELECT project_id FROM requests WHERE key=?').get(key) as { project_id: string } | undefined)?.project_id; }
  update(id: string, fn: (p: Project) => void, event = 'project.updated'): Project {
    this.db.exec('BEGIN IMMEDIATE'); let p: Project;
    try { p = this.get(id); fn(p); p.version++; p.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p), id); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.emit(id, event, { version: p.version }); return p;
  }
  emit(projectId: string, type: string, data: unknown) {
    const createdAt = new Date().toISOString();
    const row = this.db.prepare('INSERT INTO events(project_id,type,data,created_at) VALUES (?,?,?,?)').run(projectId, type, JSON.stringify(data), createdAt);
    const ev: ProjectEvent = { id: Number(row.lastInsertRowid), projectId, type, data, createdAt };
    this.events.emit('event', ev); return ev;
  }
  history(id: string, since: number, limit = 500): ProjectEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(id, since, limit) as any[];
    return rows.map(r => ({ id: r.id, projectId: r.project_id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
  }
  claim(projectId: string, taskId: string, runId: string) { return this.db.prepare('INSERT OR IGNORE INTO claims VALUES (?,?,?)').run(projectId, taskId, runId).changes === 1; }
  release(projectId: string, taskId: string, runId: string) { this.db.prepare('DELETE FROM claims WHERE project_id=? AND task_id=? AND run_id=?').run(projectId, taskId, runId); }
  clearClaims() { this.db.exec('DELETE FROM claims'); }
  session(id: string, backend: string): any { const row = this.db.prepare('SELECT data FROM sessions WHERE id=? AND backend=?').get(id, backend) as { data: string } | undefined; if (!row) throw new Error('执行会话不存在'); return JSON.parse(row.data); }
  saveSession(id: string, backend: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(id, backend, JSON.stringify(value)); }
  settings(): Settings { const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as { data: string } | undefined; return row ? JSON.parse(row.data) : { codexPath: '', model: '', concurrency: 3, maxReworks: 2, maxPhases: 8 }; }
  saveSettings(value: Settings) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1,?)').run(JSON.stringify(value)); }
  close() { this.db.close(); }
}
