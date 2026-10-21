import { mkdir, writeFile } from 'node:fs/promises';
import type { Project } from '../shared/types.ts';
const language = process.env.HELIU_LANGUAGE === 'en' ? 'en' : 'zh-CN';
const base = process.env.HELIU_URL || 'http://127.0.0.1:4310';
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Accept-Language': language, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await r.json(); if (!r.ok) throw new Error(value.error); return value as T;
}
const health = await api<{ connected: boolean; authenticated: boolean; message: string }>('/health');
if (!health.connected || !health.authenticated) throw new Error(health.message);
const p = await api<Project>('/projects', { language, goal: language === 'en' ? 'Offline acceptance project: create an English quickstart.md for Agent Jira, a local project workspace with a supervisor who gathers requirements, designs a team and plan, dispatches parallel modules, and reviews real files. First prepare requirements for confirmation. Once confirmed, assign exactly two independent parallel modules: one member writes introduction.md (a one-sentence product description and a note that model backends can be extended); another writes steps.md (three steps: confirm the brief, review the plan and modules, open approved deliverables). Name the team and roles yourself. A third merge module depends on both, reads both actual files, and combines them into quickstart.md. Review and finish. Do not use the internet, install dependencies, add further stages, or ask for more research. All requirements and deliverables must be in English.' : '离线小项目验收：为「Agent Jira」项目工作台生成一份 quickstart.md。请先整理需求供确认。需求确定后必须安排两个独立并行模块：一位成员写 introduction.md（一句中文产品介绍及「模型接入可扩展」说明），另一位成员写 steps.md（三个中文使用步骤：确认需求、查看实验计划与任务、查看验收交付）。由主管自主命名角色和成员，两个模块不要互相依赖。第三个汇合模块依赖前两个，实际读取两份文件后合成 quickstart.md，再由主管验收并结束。不要联网、不要安装依赖，不需要额外调研或扩展阶段。全部内容依据本次目标完成。', start: true });
console.log(`真实 Codex 项目 ${p.id}\n${base}/?project=${p.id}`);
let previous = '', confirmed = false; const deadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deadline) {
  const current = await api<Project>(`/projects/${p.id}`);
  const state = `${current.status} / ${current.tasks.map(t => `${t.title}:${t.status}`).join(' | ')}`;
  if (state !== previous) { console.log(state); previous = state; }
  if (current.stage === 'awaiting_confirmation' && !confirmed) {
    const revision = current.requirements?.at(-1);
    if (!revision || revision.document.questions.length) throw new Error('验收项目仍缺少需求信息');
    if (current.tasks.length || current.runs.some(r => r.purpose === 'execution')) throw new Error('确认前已启动成员任务');
    await api(`/projects/${p.id}/requirements/confirm`, { version: revision.version }); confirmed = true;
    console.log(`已验证需求门槛，确认 v${revision.version}`); continue;
  }
  if (current.status === 'blocked' || current.status === 'paused') throw new Error(current.blocker || '项目阻塞');
  if (current.status === 'completed') {
    if (current.language !== language) throw new Error('Project language was not preserved');
    const artifacts = current.artifacts.filter(a => current.tasks.some(t => t.artifactIds.includes(a.id)));
    if (!artifacts.length) throw new Error('没有已验收交付物');
    if (current.tasks.length < 3 || !current.tasks.some(t => t.kind === 'join' && t.dependencies.length >= 2)) throw new Error('没有并行与汇合模块');
    const executions = current.runs.filter(r => r.purpose === 'execution' && r.status === 'completed');
    const parallel = executions.some((a, i) => executions.slice(i + 1).some(b => a.taskId !== b.taskId && a.startedAt < b.endedAt! && b.startedAt < a.endedAt!));
    if (!parallel) throw new Error('未观察到真实并行执行');
    if (!current.revisions[0]?.plan?.strategy || current.revisions[0].requirementsVersion !== current.confirmedRequirementsVersion) throw new Error('计划未绑定确认需求');
    for (const a of artifacts) { const r = await fetch(`${base}/api/projects/${p.id}/artifacts/${a.id}`); if (!r.ok || !(await r.text()).length) throw new Error('产出无法下载'); }
    await mkdir('.cache', { recursive: true }); await writeFile(language === 'en' ? '.cache/codex-smoke-en.json' : '.cache/codex-smoke-v2.json', JSON.stringify({ language, parallel, confirmed, taskCount: current.tasks.length, executionCount: executions.length, id: current.id, title: current.title, status: current.status, artifacts, summary: current.finalSummary }, null, 2));
    console.log(JSON.stringify({ status: 'passed', projectId: p.id, artifacts: artifacts.map(a => a.name), summary: current.finalSummary })); process.exit(0);
  }
  await new Promise(r => setTimeout(r, 1500));
}
await api(`/projects/${p.id}/control`, { action: 'pause' });
throw new Error('真实 Codex 验收超时，已暂停并保留现场');
