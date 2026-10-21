import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import staticFiles from '@fastify/static';
import { z, ZodError } from 'zod';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { AgentBackend } from './backends/backend.ts';
import { templates, type ProjectEvent } from '../shared/types.ts';
import { planApiSchema, requirementsOutput } from './domain.ts';
import { exportPlan } from '../shared/workflow.ts';
import { verifiedFile } from './workspaces.ts';
import { normalizeLocale, translate, translateServiceText, type Locale } from '../shared/i18n.ts';
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const projectParams = object({ id: string }, ['id']);
function localizedSchema(value: unknown, locale: Locale): unknown {
  if (Array.isArray(value)) return value.map(item => localizedSchema(item, locale));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['summary', 'description', 'title'].includes(key) && typeof item === 'string'
      ? translate(locale, item) : localizedSchema(item, locale)]));
}
export async function createApp(store: Store, service: Orchestrator, backend: AgentBackend, options: { port?: number; serveStatic?: boolean } = {}) {
  const port = options.port || 4310;
  const app = Fastify({ logger: false, bodyLimit: 15 * 1024 * 1024 });
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); streams.clear(); });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return reply.code(403).send({ error: translate(normalizeLocale(request.headers['accept-language']), '仅允许本机访问') });
    const origin = request.headers.origin;
    const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'];
    if ((origin && !allowed.includes(origin)) || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: translate(normalizeLocale(request.headers['accept-language']), '请求来源不被允许') });
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    const locale = normalizeLocale(req.headers['accept-language']);
    reply.code(e instanceof ZodError || e.validation ? 400 : e.statusCode || 400).send({
      error: e instanceof ZodError || e.validation ? translate(locale, '输入内容不符合要求，请检查后重试。') : translateServiceText(locale, e.message),
      ...(e instanceof ZodError ? { details: e.issues } : e.validation ? { details: e.validation } : {}),
    });
  });
  await app.register(swagger, { openapi: { info: { title: 'Agent Jira API', description: '本机项目编排接口。写操作仅接受同源浏览器或本地程序请求。', version: '0.2.0' }, servers: [{ url: `http://127.0.0.1:${port}` }] } });
  app.get('/api/openapi.json', { schema: { tags: ['Agent API'], summary: '获取 OpenAPI 描述' } }, async req => localizedSchema(app.swagger(), normalizeLocale((req.query as { lang?: string }).lang || req.headers['accept-language'])));
  app.get('/api/health', { schema: { tags: ['Settings'], summary: '检查执行后端与登录状态' } }, async req => { const health = await backend.health(); return { ...health, message: translateServiceText(normalizeLocale(req.headers['accept-language']), health.message) }; });
  app.get('/api/templates', { schema: { tags: ['Projects'], summary: '团队模板' } }, async () => templates);
  app.get('/api/settings', { schema: { tags: ['Settings'], summary: '读取本地设置（不包含凭据）' } }, async () => store.settings());
  app.put('/api/settings', { schema: { tags: ['Settings'], summary: '更新运行设置', body: object({ codexPath: string, model: string, concurrency: { type: 'integer', minimum: 1, maximum: 8 }, maxReworks: { type: 'integer', minimum: 0, maximum: 5 }, maxPhases: { type: 'integer', minimum: 1, maximum: 30 } }, ['codexPath', 'model', 'concurrency', 'maxReworks', 'maxPhases']) } }, async req => {
    if (service.activeCount()) throw new Error('请先暂停正在运行的项目再修改执行设置');
    const value = z.object({ codexPath: z.string().max(2000), model: z.string().max(200), concurrency: z.number().int().min(1).max(8), maxReworks: z.number().int().min(0).max(5), maxPhases: z.number().int().min(1).max(30) }).parse(req.body);
    await backend.close(); store.saveSettings(value); const health = await backend.health(); return { settings: value, health: { ...health, message: translateServiceText(normalizeLocale(req.headers['accept-language']), health.message) } };
  });
  app.get('/api/directories', { schema: { tags: ['Projects'], summary: '选择本地工作目录', querystring: object({ path: string }) } }, async req => {
    const selected = (req.query as { path?: string }).path || homedir();
    const path = await realpath(selected); if (!(await stat(path)).isDirectory()) throw new Error('不是文件夹');
    const entries = (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200).map(d => ({ name: d.name, path: join(path, d.name) }));
    let git = false; try { await access(join(path, '.git')); git = true; } catch {}
    return { path, parent: dirname(path), entries, git };
  });
  app.get('/api/projects', { schema: { tags: ['Projects'], summary: '列出项目' } }, async () => store.list());
  app.post('/api/projects', { schema: { tags: ['Projects'], summary: '提交目标并整理需求；确认后才执行，支持 Idempotency-Key', body: object({ goal: { type: 'string', minLength: 2, maxLength: 16000 }, language: { type: 'string', enum: ['zh-CN', 'en'] }, template: { type: 'string', enum: ['development', 'research', 'content'], description: '可选项目类型提示，不预设团队角色' }, workingDirectory: string, sourceThreadId: string, start: { type: 'boolean' } }, ['goal']) } }, async req => {
    const input = req.body as { goal: string; language?: Locale; template?: 'development' | 'research' | 'content'; workingDirectory?: string; sourceThreadId?: string; start?: boolean };
    const key = req.headers['idempotency-key']?.toString().slice(0, 200);
    const existing = key ? store.requestProject(key) : undefined;
    if (existing) return store.get(existing);
    const source = input.sourceThreadId && backend.readThread ? await backend.readThread(input.sourceThreadId) : undefined;
    const p = await service.create({ ...input, language: input.language || normalizeLocale(req.headers['accept-language']), backend: backend.id, source }, key);
    return input.start === false ? p : service.start(p.id);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id', { schema: { tags: ['Projects'], summary: '获取项目、任务、产出与运行记录', params: projectParams } }, async req => store.get(req.params.id));
  app.put<{ Params: { id: string } }>('/api/projects/:id/requirements', { schema: { tags: ['Requirements'], summary: '保存新版需求并等待确认；version 为当前版本，首次为 0', params: projectParams, body: object({ version: { type: 'integer', minimum: 0 }, document: requirementsOutput }, ['version', 'document']) } }, req => {
    const body = req.body as { version: number; document: unknown }; return service.saveRequirements(req.params.id, body.version, body.document);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/requirements/confirm', { schema: { tags: ['Requirements'], summary: '确认最新需求版本，自动设计团队与计划；相同版本幂等', params: projectParams, body: object({ version: { type: 'integer', minimum: 1 } }, ['version']) } }, req => service.confirmRequirements(req.params.id, (req.body as { version: number }).version));
  app.post<{ Params: { id: string } }>('/api/projects/:id/control', { schema: { tags: ['Runs'], summary: '开始、继续或暂停项目', params: projectParams, body: object({ action: { type: 'string', enum: ['start', 'resume', 'pause'] } }, ['action']) } }, async req => (req.body as { action: string }).action === 'pause' ? service.pause(req.params.id) : service.start(req.params.id));
  app.post<{ Params: { id: string } }>('/api/projects/:id/messages', { schema: { tags: ['Runs'], summary: '给主管或指定节点追加 Prompt', params: projectParams, body: object({ content: { type: 'string', minLength: 1, maxLength: 16000 }, taskId: string }, ['content']) } }, async req => {
    const { content, taskId } = req.body as { content: string; taskId?: string }; return service.submitMessage(req.params.id, content, taskId);
  });
  app.post<{ Params: { id: string; taskId: string } }>('/api/projects/:id/tasks/:taskId/retry', { schema: { tags: ['Runs'], summary: '重试任务并重新验收下游', params: object({ id: string, taskId: string }, ['id', 'taskId']) } }, req => service.retry(req.params.id, req.params.taskId));
  app.patch<{ Params: { id: string; taskId: string } }>('/api/projects/:id/tasks/:taskId', { schema: { tags: ['Tasks'], summary: '调整待执行任务的成员、0–10 优先级与依赖', params: object({ id: string, taskId: string }, ['id', 'taskId']), body: object({ memberId: string, priority: { type: 'integer', minimum: 0, maximum: 10 }, dependencies: { type: 'array', items: string } }) } }, req => service.editTask(req.params.id, req.params.taskId, req.body as any));
  app.patch<{ Params: { id: string } }>('/api/projects/:id/supervisor', { schema: { tags: ['Teams'], summary: '修改本项目主管的名字', params: projectParams, body: object({ name: { type: 'string', minLength: 1, maxLength: 40 } }, ['name']) } }, req => service.renameSupervisor(req.params.id, (req.body as { name: string }).name));
  app.patch<{ Params: { id: string; memberId: string } }>('/api/projects/:id/members/:memberId', { schema: { tags: ['Teams'], summary: '编辑团队成员，下一次执行生效', params: object({ id: string, memberId: string }, ['id', 'memberId']), body: object({ name: { type: 'string', minLength: 1, maxLength: 100 }, role: { type: 'string', minLength: 1, maxLength: 200 }, instructions: { type: 'string', maxLength: 12000 }, model: string }) } }, req => service.updateMember(req.params.id, req.params.memberId, req.body as any));
  app.get<{ Params: { id: string } }>('/api/projects/:id/plan', { schema: { tags: ['Agent API'], summary: '导出当前计划 JSON', params: projectParams } }, async req => {
    return exportPlan(store.get(req.params.id));
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/plan', { schema: { tags: ['Agent API'], summary: '导入计划（暂停状态下应用，下一次继续执行）', params: projectParams, body: planApiSchema } }, req => service.importPlan(req.params.id, req.body));
  app.post<{ Params: { id: string } }>('/api/projects/:id/attachments', { schema: { tags: ['Artifacts'], summary: '添加参考材料，单文件不超过 10 MB', params: projectParams, body: object({ name: { type: 'string', minLength: 1, maxLength: 255 }, base64: string }, ['name', 'base64']) } }, async req => {
    const p = store.get(req.params.id); if (!['draft', 'paused', 'blocked'].includes(p.status)) throw new Error('请暂停后添加材料，让主管在下一轮读取');
    const body = req.body as { name: string; base64: string };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw new Error('文件编码无效');
    const a = await service.workspaces.input(p, body.name, Buffer.from(body.base64, 'base64'));
    store.update(p.id, x => x.artifacts.push(a)); return a;
  });
  app.get<{ Params: { id: string; artifactId: string } }>('/api/projects/:id/artifacts/:artifactId', { schema: { tags: ['Artifacts'], summary: '下载已记录的交付物或参考材料', params: object({ id: string, artifactId: string }, ['id', 'artifactId']) } }, async (req, reply) => {
    const p = store.get(req.params.id), artifact = p.artifacts.find(a => a.id === req.params.artifactId);
    if (!artifact) return reply.code(404).send({ error: translate(normalizeLocale(req.headers['accept-language']), '交付物不存在') });
    const file = await verifiedFile(p.workspace, artifact.path);
    reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(artifact.path).replace(/^\d+-/, ''))}`);
    return readFile(file.path);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>('/api/projects/:id/events', { schema: { tags: ['Runs'], summary: 'SSE 实时事件，支持 Last-Event-ID', params: projectParams, querystring: object({ after: { type: 'integer', minimum: 0 } }) } }, async (req, reply) => {
    const snapshot = store.get(req.params.id);
    const after = Number(req.headers['last-event-id'] || req.query.after || 0);
    reply.hijack(); streams.add(reply.raw); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    const send = (event: ProjectEvent) => { if (event.projectId === snapshot.id && !reply.raw.destroyed) reply.raw.write(`id: ${event.id}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`); };
    store.events.on('event', send);
    for (const event of store.history(snapshot.id, Number.isFinite(after) ? after : 0)) send(event);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    req.raw.on('close', () => { clearInterval(heartbeat); store.events.off('event', send); streams.delete(reply.raw); });
  });
  app.get('/api/codex/threads', { schema: { tags: ['Imports'], summary: '只读列出本机 Codex 聊天', querystring: object({ cursor: string, search: string }) } }, req => { const q = req.query as { cursor?: string; search?: string }; if (!backend.listThreads) throw new Error('此后端不支持历史导入'); return backend.listThreads(q.cursor, q.search); });
  app.get<{ Params: { id: string } }>('/api/codex/threads/:id', { schema: { tags: ['Imports'], summary: '预览所选聊天的内容快照', params: projectParams } }, req => { if (!backend.readThread) throw new Error('此后端不支持历史导入'); return backend.readThread(req.params.id); });
  if (options.serveStatic !== false) {
    const root = resolve('dist');
    try {
      await access(join(root, 'index.html')); await app.register(staticFiles, { root });
      app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: translate(normalizeLocale(req.headers['accept-language']), '接口不存在') }) : reply.sendFile('index.html'));
    } catch { app.get('/', async (_req, reply) => reply.type('text/plain').send('请先运行 npm run build，或使用 npm run dev:web 启动前端。')); }
  }
  return app;
}
