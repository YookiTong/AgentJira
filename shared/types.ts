import type { Locale } from './i18n';
export type TemplateId = 'development' | 'research' | 'content';
export type ProjectStatus = 'draft' | 'planning' | 'running' | 'paused' | 'blocked' | 'completed';
export type TaskStatus = 'pending' | 'running' | 'reviewing' | 'completed' | 'blocked' | 'interrupted' | 'superseded';
export type ProjectStage = 'requirements' | 'awaiting_confirmation' | 'planning' | 'execution';
export interface RequirementsDocument {
  title: string; projectType: TemplateId; objective: string; scope: string[]; inputs: string[];
  constraints: string[]; deliverables: string[]; acceptance: string[]; questions: string[];
}
export interface RequirementsRevision {
  version: number; document: RequirementsDocument; createdAt: string; source: 'supervisor' | 'user'; confirmedAt?: string;
}
export interface Experiment { hypothesis: string; variables: string[]; controls: string[]; setup: string; metrics: string[] }
export interface Member { id: string; name: string; role: string; instructions: string; model?: string }
export interface TaskSpec { id: string; title: string; description: string; memberId: string; kind: 'task' | 'join'; dependencies: string[]; acceptance: string[]; priority: number; method?: string[]; inputs?: string[]; expectedOutputs?: string[]; experiment?: Experiment | null }
export interface Task extends TaskSpec { status: TaskStatus; phase: number; reworks: number; sessionId?: string; workspace?: string; feedback?: string; artifactIds: string[]; commit?: string; summary?: string }
export interface Artifact { id: string; projectId: string; taskId?: string; runId?: string; name: string; path: string; bytes: number; sha256: string; createdAt: string; kind: 'input' | 'output' }
export interface Check { name: string; passed: boolean; detail: string }
export interface TaskResult { summary: string; artifacts: { path: string; label: string }[]; checks: Check[]; needsInput: string | null }
export interface RunRecord { id: string; taskId?: string; purpose: 'requirements' | 'planning' | 'execution' | 'review' | 'final'; sessionId?: string; status: 'running' | 'completed' | 'interrupted' | 'failed'; startedAt: string; endedAt?: string; log: string; error?: string; result?: unknown }
export interface Message { id: string; role: 'user' | 'supervisor' | 'system'; content: string; createdAt: string; taskId?: string; handled?: boolean }
export interface PlanRevision { number: number; summary: string; taskIds: string[]; createdAt: string; requirementsVersion?: number; plan?: Plan }
export interface Project {
  id: string; title: string; goal: string; template: TemplateId; backend: string; model: string;
  supervisorName?: string; priorityScale?: 10;
  language?: Locale;
  workflowVersion?: 1 | 2; stage?: ProjectStage; typeHint?: TemplateId;
  requirements?: RequirementsRevision[]; confirmedRequirementsVersion?: number;
  status: ProjectStatus; phase: number; generation: number; version: number;
  createdAt: string; updatedAt: string; workspace: string; contextPath?: string; repoPath?: string;
  integrationPath?: string; integrationBranch?: string; supervisorSessionId?: string;
  members: Member[]; tasks: Task[]; messages: Message[]; runs: RunRecord[]; artifacts: Artifact[]; revisions: PlanRevision[];
  blocker?: string; source?: { id: string; title: string; transcript: string }; finalSummary?: string;
}
export interface Settings { codexPath: string; model: string; concurrency: number; maxReworks: number; maxPhases: number }
export interface BackendHealth { id: string; connected: boolean; authenticated: boolean; version: string; message: string; models: { id: string; name: string; isDefault?: boolean }[] }
export interface BackendEvent { type: 'text' | 'tool' | 'status'; text: string }
export interface ThreadSummary { id: string; title: string; cwd?: string; updatedAt?: number }
export interface Plan { title: string; summary: string; question: string | null; members: Member[]; tasks: TaskSpec[]; strategy?: string; requirementsVersion?: number }
export interface Review { decision: 'accept' | 'revise' | 'blocked'; summary: string; feedback: string }
export interface FinalDecision { decision: 'complete' | 'extend' | 'ask' | 'blocked'; summary: string; plan: Plan | null }
export interface ProjectEvent { id: number; projectId: string; type: string; data: unknown; createdAt: string }
export const templates: { id: TemplateId; name: string; description: string; roles: string[]; prompt: string }[] = [
  { id: 'development', name: '产品开发', description: '从需求、设计到开发与测试', roles: ['产品经理', '设计师', '工程师', '测试工程师'], prompt: '明确需求和接口，将可独立开发的模块并行安排，最后集成、测试并验收。' },
  { id: 'research', name: '研究调研', description: '并行探索，交叉核验，汇总观点', roles: ['研究员', '资料分析师', '事实核验员', '报告编辑'], prompt: '拆分研究问题，记录可核验的来源，分辨事实与推断，通过交叉核验后整合报告。' },
  { id: 'content', name: '内容创作', description: '从创意、素材到完整交付', roles: ['策划', '内容创作者', '编辑', '质量审阅员'], prompt: '定义受众与交付格式，按内容单元并行创作，保持风格一致，最终编辑和验收。' },
];
export const statusLabels: Record<ProjectStatus | TaskStatus, string> = {
  draft: '待启动', planning: '主管规划中', running: '执行中', paused: '已暂停', blocked: '需处理', completed: '已完成',
  pending: '待执行', reviewing: '验收中', interrupted: '已中断', superseded: '已替代',
};
