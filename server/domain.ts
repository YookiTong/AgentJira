import { z } from 'zod';
import type { Plan, Project, Task } from '../shared/types.ts';
export const memberSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(100), role: z.string().min(1).max(200), instructions: z.string().max(12000), model: z.string().optional() });
const lines = z.array(z.string().trim().min(1).max(4000)).max(40);
export const requirementsSchema = z.object({ title: z.string().trim().min(1).max(200), projectType: z.enum(['development', 'research', 'content']),
  objective: z.string().trim().min(1).max(16000), scope: lines.min(1), inputs: lines, constraints: lines,
  deliverables: lines.min(1), acceptance: lines.min(1), questions: lines });
const experimentSchema = z.object({ hypothesis: z.string(), variables: lines, controls: lines, setup: z.string(), metrics: lines });
export const taskSchema = z.object({ id: z.string().regex(/^[\w-]{1,80}$/), title: z.string().min(1).max(200), description: z.string().min(1).max(16000), memberId: z.string(), kind: z.enum(['task', 'join']), dependencies: z.array(z.string()).max(100), acceptance: z.array(z.string().min(1)).min(1).max(15), priority: z.number().int().min(0).max(10),
  method: lines.optional(), inputs: lines.optional(), expectedOutputs: lines.optional(), experiment: experimentSchema.nullable().optional() });
export const planSchema = z.object({ title: z.string().min(1), summary: z.string(), question: z.string().nullable(), members: z.array(memberSchema).max(15), tasks: z.array(taskSchema).max(60), strategy: z.string().max(16000).optional(), requirementsVersion: z.number().int().positive().optional() });
export const resultSchema = z.object({ summary: z.string().min(1), artifacts: z.array(z.object({ path: z.string().min(1), label: z.string().min(1) })).max(30), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })).max(30), needsInput: z.string().nullable() });
export const reviewSchema = z.object({ decision: z.enum(['accept', 'revise', 'blocked']), summary: z.string(), feedback: z.string() });
export const finalSchema = z.object({ decision: z.enum(['complete', 'extend', 'ask', 'blocked']), summary: z.string(), plan: planSchema.nullable() });
export const controlSchema = z.object({ action: z.enum(['reply', 'replan', 'pause', 'resume']), summary: z.string().min(1) });
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown) => ({ type: 'array', items });
const memberOutput = obj({ id: str, name: str, role: str, instructions: str });
export const requirementsOutput = obj({ title: str, projectType: { type: 'string', enum: ['development', 'research', 'content'] },
  objective: str, scope: arr(str), inputs: arr(str), constraints: arr(str), deliverables: arr(str), acceptance: arr(str), questions: arr(str) });
const experimentOutput = obj({ hypothesis: str, variables: arr(str), controls: arr(str), setup: str, metrics: arr(str) });
const taskOutput = obj({ id: str, title: str, description: str, memberId: str, kind: { type: 'string', enum: ['task', 'join'] },
  dependencies: arr(str), acceptance: arr(str), priority: { type: 'integer', minimum: 0, maximum: 10, description: '优先级 0–10，数值越大越先执行' }, method: arr(str), inputs: arr(str), expectedOutputs: arr(str),
  experiment: { anyOf: [experimentOutput, { type: 'null' }] } });
export const planOutput = obj({ title: str, summary: str, strategy: str, question: { type: ['string', 'null'] }, members: arr(memberOutput), tasks: arr(taskOutput) });
export const planApiSchema = { ...planOutput, required: ['title', 'summary', 'question', 'members', 'tasks'], properties: {
  ...planOutput.properties, requirementsVersion: { type: 'integer', minimum: 1 },
  members: arr({ ...memberOutput, properties: { ...memberOutput.properties, model: str } }),
  tasks: arr({ ...taskOutput, required: ['id', 'title', 'description', 'memberId', 'kind', 'dependencies', 'acceptance', 'priority'] }),
} };
export const resultOutput = obj({ summary: str, artifacts: arr(obj({ path: str, label: str })), checks: arr(obj({ name: str, passed: { type: 'boolean' }, detail: str })), needsInput: { type: ['string', 'null'] } });
export const reviewOutput = obj({ decision: { type: 'string', enum: ['accept', 'revise', 'blocked'] }, summary: str, feedback: str });
export const finalOutput = obj({ decision: { type: 'string', enum: ['complete', 'extend', 'ask', 'blocked'] }, summary: str, plan: { anyOf: [planOutput, { type: 'null' }] } });
export const controlOutput = obj({ action: { type: 'string', enum: ['reply', 'replan', 'pause', 'resume'] }, summary: str });
export function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}
export function validatePlan(input: unknown, retained: Task[] = []): Plan {
  const plan = planSchema.parse(input);
  if (!plan.question && ((!plan.tasks.length && !retained.length) || !plan.members.length)) throw new Error('计划需要至少一个成员和任务');
  const members = new Set(plan.members.map(m => m.id));
  if (members.size !== plan.members.length) throw new Error('成员 ID 重复');
  const ids = new Set(retained.map(t => t.id));
  for (const t of plan.tasks) {
    if (ids.has(t.id)) throw new Error(`任务 ID 重复：${t.id}`);
    if (!members.has(t.memberId)) throw new Error(`任务 ${t.id} 的成员不存在`);
    ids.add(t.id);
  }
  const all = [...retained, ...plan.tasks];
  const map = new Map(all.map(t => [t.id, t]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('任务依赖不能形成循环');
    if (visited.has(id)) return;
    const t = map.get(id);
    if (!t) throw new Error(`依赖的任务不存在：${id}`);
    visiting.add(id); t.dependencies.forEach(visit); visiting.delete(id); visited.add(id);
  };
  all.forEach(t => visit(t.id));
  return plan;
}
export function activeTasks(p: Project) { return p.tasks.filter(t => t.status !== 'superseded'); }
export function readyTasks(p: Project) {
  const done = new Set(p.tasks.filter(t => t.status === 'completed').map(t => t.id));
  return activeTasks(p).filter(t => t.status === 'pending' && t.dependencies.every(id => done.has(id))).sort((a, b) => b.priority - a.priority);
}
export function descendants(tasks: Task[], taskId: string): Set<string> {
  const result = new Set([taskId]);
  let changed = true;
  while (changed) { changed = false; for (const t of tasks) if (!result.has(t.id) && t.dependencies.some(id => result.has(id))) { result.add(t.id); changed = true; } }
  return result;
}
