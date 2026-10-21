import type { Member, Plan, Project, Task, TaskSpec, TaskStatus } from './types.ts';
import { translate, type Locale } from './i18n.ts';

export function supervisorName(p: Pick<Project, 'id' | 'supervisorName' | 'language'>) {
  const names = p.language === 'en' ? ['Morgan', 'Avery', 'Rowan', 'Alex', 'Quinn', 'Casey'] : ['知衡', '见川', '予安', '云舟', '若溪', '星野'];
  return p.supervisorName || names[[...p.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % names.length];
}
export const priorityLabel = (priority: number) => priority >= 8 ? '高' : priority >= 4 ? '中' : '低';
export const runStatusLabels = { running: '进行中', completed: '已结束', interrupted: '已中断', failed: '未成功' };
export const runPurposeLabels = { requirements: '整理需求', planning: '项目规划', execution: '模块执行', review: '交付验收', final: '阶段总结' };
export const latestRequirements = (p: Project) => p.requirements?.at(-1);
export const projectSummary = (p: Project) => (latestRequirements(p)?.document.objective.trim() || p.goal).replace(/\s+/g, ' ').trim();
export function needsConfirmation(p: Project) {
  return p.workflowVersion === 2 && (p.stage === 'requirements' || !latestRequirements(p) || latestRequirements(p)!.version !== p.confirmedRequirementsVersion);
}
export const visibleTasks = (p: Project) => p.tasks.filter(t => t.status !== 'superseded');
export function currentMembers(p: Project): Member[] {
  const plan = [...p.revisions].reverse().find(r => r.plan)?.plan;
  const ids = new Set([...visibleTasks(p).map(t => t.memberId), ...(plan?.members.map(m => m.id) || p.members.map(m => m.id))]);
  return p.members.filter(m => ids.has(m.id));
}
export function taskSpec(t: TaskSpec): TaskSpec {
  const { id, title, description, memberId, kind, dependencies, acceptance, priority, method, inputs, expectedOutputs, experiment } = t;
  return { id, title, description, memberId, kind, dependencies, acceptance, priority,
    ...(method !== undefined ? { method } : {}), ...(inputs !== undefined ? { inputs } : {}),
    ...(expectedOutputs !== undefined ? { expectedOutputs } : {}), ...(experiment !== undefined ? { experiment } : {}) };
}
export function exportPlan(p: Project): Plan {
  const previous = [...p.revisions].reverse().find(r => r.plan)?.plan;
  return { title: p.title, summary: p.revisions.at(-1)?.summary || p.goal, question: null,
    members: currentMembers(p), tasks: visibleTasks(p).map(taskSpec),
    ...(previous?.strategy ? { strategy: previous.strategy } : {}),
    ...(p.confirmedRequirementsVersion ? { requirementsVersion: p.confirmedRequirementsVersion } : {}) };
}
export const boardColumns = [
  { id: 'ready', label: '准备进行' }, { id: 'active', label: '正在进行' }, { id: 'done', label: '已经完成' },
] as const;
export function boardColumn(status: TaskStatus): 'ready' | 'active' | 'done' | null {
  if (status === 'superseded') return null;
  if (status === 'completed') return 'done';
  return status === 'running' || status === 'reviewing' ? 'active' : 'ready';
}
export function taskReason(p: Project, task: Task, locale: Locale = 'zh-CN'): string {
  const t = (key: string) => translate(locale, key);
  if (task.status === 'blocked') return task.feedback || t('需要处理后继续');
  if (task.status === 'interrupted') return task.feedback || t('执行已中断，等待继续');
  if (task.status === 'reviewing') return t('文件已提交，主管正在验收');
  if (task.status === 'running') return t('成员正在执行，可查看实时记录');
  if (task.status === 'completed') return task.summary || t('已通过主管验收');
  if (needsConfirmation(p)) return t('等待需求确认');
  if (p.status === 'paused') return t('项目已暂停');
  const waiting = task.dependencies.map(id => p.tasks.find(t => t.id === id)).filter(t => t && t.status !== 'completed');
  if (waiting.length) return translate(locale, '等待：{p0}', { p0: waiting.map(t => t!.title).join(locale === 'en' ? ', ' : '、') });
  return task.reworks ? translate(locale, '准备第 {p0} 次返工', { p0: task.reworks }) : t('依赖已满足，等待调度');
}
export function roleColumns(p: Project) {
  const columns = new Map<string, { role: string; members: Member[]; tasks: Task[] }>();
  for (const member of currentMembers(p)) {
    const role = member.role.trim();
    const column = columns.get(role) || { role, members: [], tasks: [] };
    column.members.push(member); columns.set(role, column);
  }
  for (const task of visibleTasks(p)) {
    const member = p.members.find(m => m.id === task.memberId);
    if (member) columns.get(member.role.trim())?.tasks.push(task);
  }
  return [...columns.values()];
}
export const stageLabels = { requirements: '需求整理', awaiting_confirmation: '待确认需求', planning: '计划生成', execution: '执行交付' };
