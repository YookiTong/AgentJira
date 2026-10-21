import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Workspaces, git, verifiedFile } from '../server/workspaces.ts';
import { Orchestrator } from '../server/orchestrator.ts';
import { createApp } from '../server/app.ts';
import { latestRequirements, needsConfirmation, exportPlan, boardColumn, boardColumns, roleColumns, taskReason } from '../shared/workflow.ts';
import { workspaceReducer, restoreWorkspace, emptyWorkspace } from '../apps/web/src/workspace-state.ts';
import { readyTasks, validatePlan } from '../server/domain.ts';
import { FakeBackend, samplePlan, sampleRequirements } from './fake-backend.ts';
async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'heliu-test-')), store = new Store(join(root, 'db.sqlite')), backend = new FakeBackend();
  const service = new Orchestrator(store, new Workspaces(root), new Map([[backend.id, backend]]));
  t.after(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const create = () => service.create({ goal: '测试交付闭环', template: 'research', backend: backend.id });
  return { root, store, backend, service, create };
}
async function until(fn: () => boolean, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('状态等待超时'); await new Promise(r => setTimeout(r, 15)); }
}
async function approvedStart(service: Orchestrator, id: string) {
  await service.start(id);
  if (needsConfirmation(service.store.get(id))) {
    await until(() => service.store.get(id).stage === 'awaiting_confirmation' || !needsConfirmation(service.store.get(id)));
    if (needsConfirmation(service.store.get(id))) await service.confirmRequirements(id, latestRequirements(service.store.get(id))!.version);
  }
  return service.store.get(id);
}
test('计划校验拒绝重复、缺失依赖、无效成员和循环', () => {
  assert.equal(validatePlan(samplePlan()).tasks.length, 3);
  const duplicate = samplePlan(); duplicate.tasks[1].id = 'a'; assert.throws(() => validatePlan(duplicate), /重复/);
  const missing = samplePlan(); missing.tasks[1].dependencies = ['unknown']; assert.throws(() => validatePlan(missing), /不存在/);
  const member = samplePlan(); member.tasks[0].memberId = 'unknown'; assert.throws(() => validatePlan(member), /成员不存在/);
  const cycle = samplePlan(); cycle.tasks[0].dependencies = ['join']; assert.throws(() => validatePlan(cycle), /循环/);
});
test('优先级统一为 0–10，接口拒绝越界值并按较大值先调度', async t => {
  const { service, store, backend, create } = await harness(t);
  const p = await create();
  store.update(p.id, x => { delete x.workflowVersion; delete x.stage; });
  await service.importPlan(p.id, samplePlan());
  const app = await createApp(store, service, backend, { serveStatic: false });
  t.after(() => app.close());
  for (const value of [-1, 11, 2.5]) {
    const response = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/tasks/a`, payload: { priority: value } });
    assert.equal(response.statusCode, 400);
    const invalid = samplePlan(); invalid.tasks[0].priority = value;
    assert.throws(() => validatePlan(invalid));
  }
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/tasks/a`, payload: { priority: 0 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/tasks/b`, payload: { priority: 10 } })).statusCode, 200);
  assert.deepEqual(readyTasks(store.get(p.id)).map(task => task.id), ['b', 'a']);
  const schema = (await app.inject('/api/openapi.json')).json();
  assert.equal(schema.paths['/api/projects/{id}/tasks/{taskId}'].patch.requestBody.content['application/json'].schema.properties.priority.maximum, 10);
});
test('主管名字可按项目编辑并持久化，空名字不会覆盖已有值', async t => {
  const { service, store, backend, create, root } = await harness(t);
  const a = await create(), b = await create(), originalB = b.supervisorName;
  assert.ok(a.supervisorName);
  const app = await createApp(store, service, backend, { serveStatic: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${a.id}/supervisor`, payload: { name: '  沐言  ' } })).statusCode, 200);
  assert.equal(store.get(a.id).supervisorName, '沐言');
  assert.equal(store.get(b.id).supervisorName, originalB);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/${a.id}/supervisor`, payload: { name: '  ' } })).statusCode, 400);
  const connection = new Store(join(root, 'db.sqlite'));
  assert.equal(connection.get(a.id).supervisorName, '沐言');
  assert.equal(connection.get(a.id).tasks.length, 0);
  assert.equal(connection.get(a.id).messages.length, a.messages.length);
  connection.close();
});
test('旧优先级只换算一次并备份原始数据，历史记录不受影响', async t => {
  const { store, create, root } = await harness(t);
  const p = await create(), plan = samplePlan();
  plan.tasks.forEach((task, index) => { task.priority = [100, 50, 0][index]; });
  delete p.priorityScale; delete p.supervisorName;
  p.tasks = plan.tasks.map(task => ({ ...task, status: 'completed', phase: 1, reworks: 0, artifactIds: [] }));
  p.revisions = [{ number: 1, createdAt: p.createdAt, summary: '历史计划', taskIds: p.tasks.map(task => task.id), plan }];
  p.runs = [{ id: 'original-run', purpose: 'execution', status: 'completed', startedAt: p.createdAt, log: 'priority: 100 是当时的原始输出' }];
  store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p), p.id);
  let connection = new Store(join(root, 'db.sqlite'));
  const migrated = connection.get(p.id);
  assert.deepEqual(migrated.tasks.map(task => task.priority), [10, 5, 0]);
  assert.deepEqual(migrated.revisions[0].plan!.tasks.map(task => task.priority), [10, 5, 0]);
  assert.deepEqual(migrated.runs, p.runs);
  assert.deepEqual(migrated.messages, p.messages);
  assert.ok(migrated.supervisorName);
  const backup = connection.db.prepare('SELECT original_data FROM project_migrations WHERE project_id=?').get(p.id) as { original_data: string };
  assert.equal(JSON.parse(backup.original_data).tasks[0].priority, 100);
  connection.close();
  connection = new Store(join(root, 'db.sqlite'));
  assert.deepEqual(connection.get(p.id), migrated);
  connection.close();
});
test('自动并行、验收、汇合和新阶段形成真实交付闭环', async t => {
  const { service, create, store, backend } = await harness(t); backend.extendOnce = true;
  const p = await create(); await approvedStart(service, p.id);
  await until(() => store.get(p.id).status === 'completed');
  const done = store.get(p.id);
  assert.equal(done.phase, 2); assert.equal(done.tasks.length, 4); assert.ok(done.tasks.every(t => t.status === 'completed'));
  assert.equal(backend.peak, 2); assert.ok(backend.order.indexOf('start:join') > backend.order.indexOf('review:a')); assert.ok(backend.order.indexOf('start:join') > backend.order.indexOf('review:b'));
  for (const a of done.artifacts) assert.match(await readFile(a.path, 'utf8'), /真实生成/);
  assert.ok(done.runs.every(r => r.status === 'completed')); assert.equal(done.revisions.length, 2);
});
test('验收返工期间不解锁下游', async t => {
  const { service, create, store, backend } = await harness(t); backend.rejectOnce = 'a';
  const p = await create(); await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed');
  assert.equal(backend.attempts.get('a'), 2); assert.equal(backend.attempts.get('join'), 1);
  assert.ok(backend.order.indexOf('start:join') > backend.order.lastIndexOf('review:a'));
  assert.equal(store.get(p.id).tasks.find(t => t.id === 'a')!.reworks, 1);
});
test('不存在的产出不能完成任务，达到返工上限后保留阻塞', async t => {
  const { service, create, store, backend } = await harness(t); backend.missingFile = true;
  const p = await create(); await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'blocked');
  assert.equal(backend.attempts.get('a'), 3); assert.equal(backend.attempts.get('b'), 3); assert.equal(backend.attempts.get('join'), undefined);
  assert.equal(store.get(p.id).artifacts.length, 0);
});
test('重复开始和调度事件不会重复派发，重试会失效下游', async t => {
  const { service, create, store, backend } = await harness(t); const p = await create();
  await Promise.all([approvedStart(service, p.id), approvedStart(service, p.id), approvedStart(service, p.id)]);
  for (let i = 0; i < 20; i++) service.kick();
  await until(() => store.get(p.id).status === 'completed'); assert.equal(backend.attempts.get('a'), 1);
  await service.retry(p.id, 'a'); await until(() => store.get(p.id).status === 'completed');
  assert.equal(backend.attempts.get('a'), 2); assert.equal(backend.attempts.get('b'), 1); assert.equal(backend.attempts.get('join'), 2);
  assert.ok(store.get(p.id).artifacts.length > 3);
});
test('暂停中断活动任务，继续复用会话且不会误报完成', async t => {
  const { service, create, store, backend } = await harness(t); backend.delay = 200;
  const p = await create(); await approvedStart(service, p.id); await until(() => backend.active === 2);
  await service.pause(p.id); const paused = store.get(p.id);
  assert.equal(paused.status, 'paused'); assert.equal(backend.active, 0); assert.equal(paused.tasks.filter(t => t.status === 'completed').length, 0);
  assert.ok(paused.runs.some(r => r.status === 'interrupted'));
  const sessions = paused.tasks.filter(t => t.sessionId).map(t => t.sessionId);
  await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed');
  assert.deepEqual(store.get(p.id).tasks.filter(t => sessions.includes(t.sessionId)).map(t => t.sessionId), sessions);
});
test('服务恢复保留未知运行为中断，不自行重放', async t => {
  const { service, create, store, backend } = await harness(t); const p = await create();
  store.update(p.id, x => { delete x.workflowVersion; delete x.stage; delete x.requirements; });
  await service.importPlan(p.id, samplePlan());
  store.update(p.id, x => { x.status = 'running'; x.tasks[0].status = 'running'; x.runs.push({ id: 'lost', purpose: 'execution', taskId: 'a', status: 'running', startedAt: new Date().toISOString(), log: '部分输出' }); });
  await service.recover(); assert.equal(store.get(p.id).status, 'paused'); assert.equal(store.get(p.id).tasks[0].status, 'interrupted');
  assert.equal(backend.attempts.size, 0); assert.equal(store.get(p.id).runs[0].log, '部分输出');
});
test('并发数对多个项目共同生效', async t => {
  const { service, create, store, backend } = await harness(t); store.saveSettings({ ...store.settings(), concurrency: 2 });
  const a = await create(), b = await create(); await Promise.all([approvedStart(service, a.id), approvedStart(service, b.id)]);
  await until(() => store.get(a.id).status === 'completed' && store.get(b.id).status === 'completed'); assert.ok(backend.peak <= 2);
});
test('相同创建请求只产生一个项目，数据跨连接持久化', async t => {
  const { service, store, backend, root } = await harness(t);
  const input = { goal: '测试', template: 'research' as const, backend: backend.id };
  const [a, b] = await Promise.all([service.create(input, 'same-request'), service.create(input, 'same-request')]); assert.equal(a.id, b.id); assert.equal(store.list().length, 1);
  const reader = new Store(join(root, 'db.sqlite')); assert.equal(reader.get(a.id).goal, '测试'); reader.close();
});
test('文件校验拒绝目录逃逸和符号链接逃逸', async t => {
  const { root } = await harness(t); const dir = join(root, 'sandbox'); await mkdir(dir); await writeFile(join(root, 'outside'), 'private'); await symlink(join(root, 'outside'), join(dir, 'link'));
  await assert.rejects(verifiedFile(dir, '../outside'), /工作目录/); await assert.rejects(verifiedFile(dir, 'link'), /工作目录/);
});
test('代码成员在独立 worktree 执行并集成到专用分支', async t => {
  const { service, store, backend, root } = await harness(t);
  const repo = join(root, 'repo'); await mkdir(repo); await git(repo, ['init', '-b', 'main']); await writeFile(join(repo, 'README.md'), 'base'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'initial']); const head = await git(repo, ['rev-parse', 'HEAD']);
  const p = await service.create({ goal: '代码任务集成验收', template: 'development', backend: backend.id, workingDirectory: repo }); await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed', 12000);
  const done = store.get(p.id); assert.ok(done.integrationPath); assert.equal(await git(repo, ['rev-parse', 'HEAD']), head); assert.equal(await git(repo, ['status', '--porcelain']), '');
  await readFile(join(done.integrationPath!, 'a.md')); await readFile(join(done.integrationPath!, 'b.md')); await readFile(join(done.integrationPath!, 'join.md'));
  assert.notEqual(done.tasks[0].workspace, done.tasks[1].workspace); assert.ok(done.tasks.every(t => t.commit));
});
test('API 契约、参数验证与来源检查', async t => {
  const { store, service, backend, create } = await harness(t), app = await createApp(store, service, backend, { serveStatic: false });
  t.after(async () => { await app.close(); });
  const headers = { host: '127.0.0.1:4310' };
  const spec = await app.inject({ method: 'GET', url: '/api/openapi.json', headers }); assert.equal(spec.statusCode, 200); assert.ok(spec.json().paths['/api/projects/{id}/messages']);
  const forbidden = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...headers, origin: 'https://attacker.example' }, payload: { goal: 'bad', template: 'research' } }); assert.equal(forbidden.statusCode, 403);
  const dns = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'attacker.example' } }); assert.equal(dns.statusCode, 403);
  const invalid = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { goal: '', template: 'oops' } }); assert.equal(invalid.statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { goal: '有效 API 项目', template: 'research', start: false } }); assert.equal(created.statusCode, 200); assert.equal(created.json().backend, backend.id);
  const p = await create(); const found = await app.inject({ method: 'GET', url: `/api/projects/${p.id}`, headers }); assert.equal(found.json().id, p.id);
  assert.ok(store.history(p.id, 0).length > 0);
});
test('询问进度由主管回答，不打断成员或替换计划', async t => {
  const { service, create, store, backend } = await harness(t); backend.delay = 100;
  const p = await create(); await approvedStart(service, p.id); await until(() => backend.active === 2);
  await service.submitMessage(p.id, '请解释目前安排，进度怎样？');
  await until(() => store.get(p.id).status === 'completed');
  assert.equal(store.get(p.id).revisions.length, 1); assert.equal(backend.attempts.get('a'), 1); assert.equal(backend.interrupts, 0);
  assert.ok(store.get(p.id).messages.some(m => m.handled === true));
});
test('主管接受方向调整后中断旧任务并保留历史', async t => {
  const { service, create, store, backend } = await harness(t); backend.delay = 120; backend.controlAction = 'replan';
  const p = await create(); await approvedStart(service, p.id); await until(() => backend.active === 2);
  backend.plan = { ...samplePlan(), tasks: samplePlan().tasks.map(x => ({ ...x, id: `new_${x.id}`, dependencies: x.dependencies.map(d => `new_${d}`) })) };
  await service.submitMessage(p.id, '改变目标，重新安排任务。');
  await until(() => store.get(p.id).stage === 'awaiting_confirmation' && latestRequirements(store.get(p.id))!.version === 2);
  assert.equal(backend.active, 0); assert.equal(backend.attempts.get('new_a'), undefined);
  await service.confirmRequirements(p.id, 2); await until(() => store.get(p.id).status === 'completed');
  const done = store.get(p.id); assert.ok(done.tasks.some(t => t.id === 'a' && t.status === 'superseded')); assert.equal(done.tasks.filter(t => t.status === 'completed').length, 3);
  assert.ok(done.runs.some(r => r.status === 'interrupted')); assert.equal(done.revisions.length, 2);
});
test('导出结构可重新导入，已验收节点不可被改写', async t => {
  const { service, create, store } = await harness(t); const p = await create();
  store.update(p.id, x => { delete x.workflowVersion; delete x.stage; delete x.requirements; });
  await service.importPlan(p.id, samplePlan()); await service.importPlan(p.id, samplePlan());
  assert.equal(new Set(store.get(p.id).tasks.map(t => t.id)).size, store.get(p.id).tasks.length);
  await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed');
  const done = store.get(p.id), exported = { title: done.title, summary: 'roundtrip', question: null, members: done.members, tasks: done.tasks.filter(t => t.status !== 'superseded') };
  await service.importPlan(p.id, exported);
  exported.tasks[0].description = '改变已验收交付'; await assert.rejects(service.importPlan(p.id, exported), /改写已验收任务/);
});
test('单个开发任务也必须汇入集成分支才能交付', async t => {
  const { service, store, backend } = await harness(t); backend.plan.tasks = [samplePlan().tasks[0]];
  const p = await service.create({ goal: '小型开发项目', template: 'development', backend: backend.id });
  await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed', 12000);
  const done = store.get(p.id); assert.equal(done.tasks.length, 2); assert.equal(done.tasks[1].kind, 'join'); await readFile(join(done.integrationPath!, 'a.md'));
});
test('SSE 发送状态快照和增量，断线重连恢复且不阻塞服务关闭', async t => {
  const { store, service, backend, create } = await harness(t), app = await createApp(store, service, backend, { serveStatic: false });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await app.close(); });
  const p = await create(); const controller = new AbortController();
  const response = await fetch(`${address}/api/projects/${p.id}/events`, { signal: controller.signal }); assert.equal(response.status, 200);
  const reader = response.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: snapshot/);
  const event = store.emit(p.id, 'verification.event', { ok: true }); let data = '';
  while (!data.includes('verification.event')) data += new TextDecoder().decode((await reader.read()).value);
  assert.match(data, new RegExp(`id: ${event.id}`)); controller.abort();
  const next = new AbortController(); const reconnect = await fetch(`${address}/api/projects/${p.id}/events`, { headers: { 'Last-Event-ID': String(event.id) }, signal: next.signal });
  const again = new TextDecoder().decode((await reconnect.body!.getReader().read()).value); assert.match(again, /event: snapshot/); assert.doesNotMatch(again, /verification.event/);
  await app.close(); next.abort();
});

test('需求确认是服务端门槛，重复确认幂等且计划绑定需求版本', async t => {
  const { service, store, backend, create } = await harness(t), p = await create();
  await Promise.all([service.start(p.id), service.start(p.id)]);
  await until(() => store.get(p.id).stage === 'awaiting_confirmation');
  assert.equal(backend.requirementCalls, 1); assert.equal(backend.planningCalls, 0);
  assert.equal(store.get(p.id).members.length, 0); assert.equal(store.get(p.id).tasks.length, 0);
  await service.start(p.id); service.kick();
  await assert.rejects(service.importPlan(p.id, samplePlan()), /先确认/);
  assert.equal(backend.attempts.size, 0);
  await Promise.all([service.confirmRequirements(p.id, 1), service.confirmRequirements(p.id, 1), service.confirmRequirements(p.id, 1)]);
  await until(() => store.get(p.id).status === 'completed');
  const done = store.get(p.id);
  assert.equal(backend.planningCalls, 1); assert.equal(backend.attempts.get('a'), 1);
  assert.ok(done.requirements![0].confirmedAt);
  assert.equal(done.revisions[0].requirementsVersion, 1); assert.equal(done.revisions[0].plan!.tasks.length, 3);
  assert.equal(done.revisions[0].plan!.strategy, samplePlan().strategy);
  assert.equal(exportPlan(done).requirementsVersion, 1);
});

test('过期需求、未解决问题及未确认的新版本不能执行', async t => {
  const { service, store, backend, create } = await harness(t); backend.requirementsQuestions = ['目标受众是谁？'];
  const p = await create(); await service.start(p.id); await until(() => store.get(p.id).stage === 'awaiting_confirmation');
  await assert.rejects(service.confirmRequirements(p.id, 1), /待解决问题/);
  await service.saveRequirements(p.id, 1, { ...sampleRequirements(), inputs: ['受众：新用户'] });
  await assert.rejects(service.confirmRequirements(p.id, 1), /最新版本/);
  await assert.rejects(service.saveRequirements(p.id, 1, sampleRequirements()), /需求已更新/);
  await service.confirmRequirements(p.id, 2); await until(() => store.get(p.id).status === 'completed');
  await service.saveRequirements(p.id, 2, { ...sampleRequirements(), objective: '修订后的目标' });
  const attempts = backend.attempts.get('a');
  await service.start(p.id);
  await assert.rejects(service.retry(p.id, 'a'), /先确认/);
  await assert.rejects(service.importPlan(p.id, samplePlan()), /先确认/);
  assert.equal(backend.attempts.get('a'), attempts); assert.equal(store.get(p.id).stage, 'awaiting_confirmation');
  assert.equal(store.get(p.id).requirements!.length, 3); assert.ok(store.get(p.id).artifacts.length);
});

test('需求阶段暂停与服务恢复不会生成成员或创建代码工作区', async t => {
  const { service, store, backend } = await harness(t);
  const p = await service.create({ goal: '开发应用', backend: backend.id, template: 'development' });
  await service.start(p.id); await until(() => store.get(p.id).stage === 'awaiting_confirmation');
  assert.equal(store.get(p.id).integrationPath, undefined);
  await service.pause(p.id); await service.recover(); await service.start(p.id);
  assert.equal(store.get(p.id).stage, 'awaiting_confirmation'); assert.equal(backend.attempts.size, 0);
  assert.equal(backend.requirementCalls, 1);
});

test('无模板创建与需求 API 校验版本，计划导出包含模块方法', async t => {
  const { service, store, backend } = await harness(t), app = await createApp(store, service, backend, { serveStatic: false });
  t.after(async () => { await app.close(); });
  const headers = { host: '127.0.0.1:4310' };
  const response = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { goal: '无需模板的新项目', start: false } });
  assert.equal(response.statusCode, 200); const id = response.json().id;
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${id}/requirements`, headers, payload: { version: 0, document: sampleRequirements('content') } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().requirements[0].version, 1);
  const stale = await app.inject({ method: 'PUT', url: `/api/projects/${id}/requirements`, headers, payload: { version: 0, document: sampleRequirements() } });
  assert.equal(stale.statusCode, 409);
  const confirmed = await app.inject({ method: 'POST', url: `/api/projects/${id}/requirements/confirm`, headers, payload: { version: 1 } });
  assert.equal(confirmed.statusCode, 200);
  await until(() => store.get(id).status === 'completed');
  const exported = await app.inject({ method: 'GET', url: `/api/projects/${id}/plan`, headers });
  assert.ok(exported.json().tasks[0].method.length); assert.ok(exported.json().tasks[0].experiment.metrics.length);
  const roundtrip = await app.inject({ method: 'PUT', url: `/api/projects/${id}/plan`, headers, payload: exported.json() });
  assert.equal(roundtrip.statusCode, 200);
  const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json', headers })).json();
  assert.ok(spec.paths['/api/projects/{id}/requirements/confirm']);
});

test('侧栏切换三个项目时视图与草稿独立，并兼容旧标签缓存', () => {
  let state = emptyWorkspace();
  for (const id of ['a', 'b', 'c']) state = workspaceReducer(state, { type: 'open', id });
  state = workspaceReducer(state, { type: 'view', id: 'a', view: 'roles' });
  state = workspaceReducer(state, { type: 'view', id: 'b', view: 'board' });
  state = workspaceReducer(state, { type: 'draft', id: 'a', text: '项目 A 的补充' });
  state = workspaceReducer(state, { type: 'draft', id: 'b', text: '项目 B 的补充' });
  state = workspaceReducer(state, { type: 'open', id: 'a' });
  assert.equal(state.activeId, 'a');
  state = workspaceReducer(state, { type: 'open', id: null });
  assert.equal(state.activeId, null); assert.equal(state.drafts.a, '项目 A 的补充');
  state = restoreWorkspace(JSON.stringify({ ...state, openIds: ['a', 'b', 'c'], activeId: 'a' }), 'c');
  assert.equal(state.activeId, 'c'); assert.equal(state.views.a, 'roles'); assert.equal(state.views.b, 'board');
  state = workspaceReducer(state, { type: 'open', id: 'a' });
  assert.equal(state.drafts.a, '项目 A 的补充');
  assert.equal('openIds' in state, false);
  assert.equal(restoreWorkspace(JSON.stringify(state), null).activeId, null);
  assert.equal(workspaceReducer(state, { type: 'reconcile', ids: ['b', 'c'] }).activeId, null);
  assert.deepEqual(restoreWorkspace('invalid', null), emptyWorkspace());
});

test('三列状态映射与按角色聚合共享模块，调整负责人后正确移列', async t => {
  const { service, store, create } = await harness(t), p = await create();
  await approvedStart(service, p.id); await until(() => store.get(p.id).status === 'completed');
  const project = store.get(p.id);
  assert.deepEqual(boardColumns.map(c => c.label), ['准备进行', '正在进行', '已经完成']);
  assert.deepEqual(['pending', 'blocked', 'interrupted', 'running', 'reviewing', 'completed', 'superseded'].map(s => boardColumn(s as any)), ['ready', 'ready', 'ready', 'active', 'active', 'done', null]);
  project.members.push({ id: 'second-researcher', name: '另一位研究员', role: '研究', instructions: '独立研究' });
  project.tasks[1].memberId = 'second-researcher';
  let columns = roleColumns(project);
  assert.equal(columns.find(c => c.role === '研究')!.members.length, 2);
  assert.equal(columns.find(c => c.role === '研究')!.tasks.length, 2);
  project.tasks[1].memberId = 'editor'; columns = roleColumns(project);
  assert.equal(columns.find(c => c.role === '汇合')!.tasks.length, 2);
  project.tasks[0].status = 'blocked'; project.tasks[0].feedback = '缺少文件';
  assert.equal(taskReason(project, project.tasks[0]), '缺少文件');
  project.tasks[0].status = 'reviewing'; assert.match(taskReason(project, project.tasks[0]), /验收/);
});

test('不同项目生成独立团队，旧版项目读取不会伪造需求', async t => {
  const { service, store, backend, create } = await harness(t), first = await create();
  await approvedStart(service, first.id); await until(() => store.get(first.id).status === 'completed');
  backend.plan = { ...samplePlan(), members: [{ id: 'writer', name: '作者', role: '文案', instructions: '写作' }], tasks: [{ ...samplePlan().tasks[0], memberId: 'writer' }] };
  const second = await create(); await approvedStart(service, second.id); await until(() => store.get(second.id).status === 'completed');
  assert.notDeepEqual(store.get(first.id).members, store.get(second.id).members);
  const legacy = await create(); store.update(legacy.id, x => { delete x.workflowVersion; delete x.stage; delete x.requirements; x.status = 'completed'; });
  await service.recover(); const old = store.get(legacy.id);
  assert.equal(old.requirements, undefined); assert.equal(old.status, 'completed'); assert.equal(needsConfirmation(old), false);
});
