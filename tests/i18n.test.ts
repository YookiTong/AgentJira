import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { englishMessages, normalizeLocale, translate, translateServiceText } from '../shared/i18n.ts';
import { statusLabels } from '../shared/types.ts';
import { boardColumns, runPurposeLabels, runStatusLabels, stageLabels } from '../shared/workflow.ts';
import { views } from '../apps/web/src/workspace-state.ts';
import { Store } from '../server/store.ts';
import { Workspaces } from '../server/workspaces.ts';
import { Orchestrator } from '../server/orchestrator.ts';
import { createApp } from '../server/app.ts';
import { FakeBackend, sampleEnglishPlan } from './fake-backend.ts';
const han = /[\u3400-\u9fff]/;
async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'agent-jira-language-'));
  const store = new Store(join(root, 'db.sqlite')), backend = new FakeBackend();
  backend.plan = sampleEnglishPlan();
  const service = new Orchestrator(store, new Workspaces(root), new Map([[backend.id, backend]]));
  const app = await createApp(store, service, backend, { serveStatic: false });
  t.after(async () => { await service.close(); await app.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, backend, service, app };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 7000;
  while (!fn()) { if (Date.now() > end) throw new Error('State wait timed out'); await new Promise(r => setTimeout(r, 15)); }
}
test('中英目录覆盖全部页面静态文案、状态和无障碍标签', async () => {
  const keys = new Set([...Object.values(statusLabels), ...Object.values(runStatusLabels), ...Object.values(runPurposeLabels), ...Object.values(stageLabels), ...boardColumns.map(v => v.label), ...views.flatMap(v => [v.label, v.description])]);
  for (const file of ['App.tsx', 'ProjectViews.tsx', 'Graph.tsx', 'WorkspaceUI.tsx', 'api.ts']) {
    const source = ts.createSourceFile(file, await readFile(`apps/web/src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && han.test(node.text)) keys.add(node.text);
      if (ts.isJsxText(node) && han.test(node.text) && !['简体中文', '文/A'].includes(node.text.trim())) assert.fail(`Hardcoded visible copy in ${file}: ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const key of keys) {
    assert.notEqual(englishMessages[key], undefined, `Missing translation: ${key}`);
    assert.equal(han.test(translate('en', key)), false, `Untranslated English copy: ${key}`);
  }
  assert.ok(keys.size > 280);
});
test('语言与模板插值保持用户内容，不替换路径、名字或目标', () => {
  assert.equal(normalizeLocale('en-GB,en;q=0.8'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(translate('en', '给{p0}发送消息', { p0: '见川' }), 'Message 见川');
  assert.equal(translate('zh-CN', '给{p0}发送消息', { p0: 'Morgan' }), '给Morgan发送消息');
  assert.equal(translateServiceText('en', '已验收「中文文档 $&」：All checks passed'), 'Approved 中文文档 $&: All checks passed');
  assert.equal(translateServiceText('en', '原始用户内容 /tmp/原始材料.md'), '原始用户内容 /tmp/原始材料.md');
});
test('英文项目完整通过需求确认、并行执行、返工、汇合和文件交付', async t => {
  const { app, store, backend } = await setup(t); backend.rejectOnce = 'a';
  const created = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'accept-language': 'en' }, payload: { goal: 'Prepare a local launch brief', language: 'en', start: true } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  await until(() => store.get(id).stage === 'awaiting_confirmation');
  let project = store.get(id);
  assert.equal(project.language, 'en'); assert.equal(project.tasks.length, 0);
  assert.equal(han.test(project.supervisorName!), false);
  assert.equal(project.runs.some(r => r.purpose === 'execution'), false);
  const version = project.requirements!.at(-1)!.version;
  await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/api/projects/${id}/requirements/confirm`, payload: { version }, headers: { 'accept-language': 'en' } })));
  await until(() => store.get(id).status === 'completed'); project = store.get(id);
  assert.equal(backend.planningCalls, 1); assert.equal(backend.peak, 2);
  assert.equal(backend.attempts.get('a'), 2); assert.equal(backend.attempts.get('join'), 1);
  const copy = JSON.stringify({ title: project.title, requirements: project.requirements, members: project.members, messages: project.messages, tasks: project.tasks.map(({ title, description, acceptance, summary }) => ({ title, description, acceptance, summary })), summary: project.finalSummary });
  assert.equal(han.test(copy), false, copy);
  assert.ok(backend.prompts.every(prompt => prompt.startsWith('This project uses English.')));
  assert.ok([...backend.sessions.values()].every(session => session.instructions.includes('Write all user-facing text in English')));
  for (const artifact of project.artifacts) {
    const response = await app.inject(`/api/projects/${id}/artifacts/${artifact.id}`);
    assert.equal(response.statusCode, 200); assert.ok(response.body.length); assert.equal(han.test(response.body), false);
  }
  assert.equal(project.revisions[0].requirementsVersion, version);
  const memberId = project.members[0].id, headers = { 'accept-language': 'en' };
  const blank = await app.inject({ method: 'PATCH', url: `/api/projects/${id}/members/${memberId}`, headers, payload: { name: '  ' } });
  assert.equal(blank.statusCode, 400); assert.equal(blank.json().error, 'A team member needs a name.');
  const renamed = await app.inject({ method: 'PATCH', url: `/api/projects/${id}/members/${memberId}`, headers, payload: { name: '  River  ' } });
  assert.equal(renamed.json().members.find((m: { id: string }) => m.id === memberId).name, 'River');
});
test('英文 API 错误与 OpenAPI 保持英语，读取项目不改写原始内容', async t => {
  const { app } = await setup(t), headers = { 'accept-language': 'en' };
  const missing = await app.inject({ url: '/api/projects/missing', headers });
  assert.equal(missing.statusCode, 404); assert.equal(missing.json().error, 'Project not found.');
  const invalid = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { goal: 'Test project', language: 'fr' } });
  assert.equal(invalid.statusCode, 400); assert.equal(han.test(invalid.json().error), false);
  const source = '原始项目内容保持中文';
  const create = await app.inject({ method: 'POST', url: '/api/projects', payload: { goal: source, start: false, language: 'zh-CN' } });
  const original = create.json();
  const read = (await app.inject({ url: `/api/projects/${original.id}`, headers })).json();
  assert.equal(read.goal, source); assert.deepEqual(read, original);
  const schema = (await app.inject('/api/openapi.json?lang=en')).json();
  assert.equal(schema.info.title, 'Agent Jira API');
  assert.equal(schema.paths['/api/projects'].get.summary, 'List projects');
  assert.deepEqual(schema.paths['/api/projects'].post.requestBody.content['application/json'].schema.properties.language.enum, ['zh-CN', 'en']);
});
