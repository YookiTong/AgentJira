import { resolve, join } from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { Store } from './store.ts';
import { Workspaces } from './workspaces.ts';
import { CodexBackend } from './backends/codex.ts';
import { Orchestrator } from './orchestrator.ts';
import { createApp } from './app.ts';
const root = resolve(process.env.HELIU_DATA_DIR || '.data'), port = Number(process.env.HELIU_PORT || 4310);
await mkdir(root, { recursive: true });
const lock = join(root, 'service.lock');
try { const handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); await handle.close(); }
catch {
  const pid = Number(await readFile(lock, 'utf8').catch(() => '0'));
  let alive = false; if (pid > 0) try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) throw new Error('此数据目录已有运行中的 Agent Jira 服务，请打开现有网页。');
  await unlink(lock).catch(() => {}); const handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); await handle.close();
}
const store = new Store(join(root, 'workbench.sqlite')), backend = new CodexBackend(store);
const service = new Orchestrator(store, new Workspaces(root), new Map([[backend.id, backend]]));
const app = await createApp(store, service, backend, { port });
let closed = false;
async function close() {
  if (closed) return; closed = true;
  await service.close(); await app.close(); store.close(); await unlink(lock).catch(() => {});
}
process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
try { await service.recover(); await app.listen({ host: '127.0.0.1', port }); console.log(`Agent Jira http://127.0.0.1:${port}`); }
catch (e) { await close(); throw e; }
