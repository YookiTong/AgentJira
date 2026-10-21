import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentBackend, SessionOptions, TurnOptions } from '../server/backends/backend.ts';
import type { BackendHealth, Plan, RequirementsDocument, Task } from '../shared/types.ts';
export const sampleRequirements = (projectType: RequirementsDocument['projectType'] = 'research', objective = '测试交付闭环'): RequirementsDocument => ({ title: '独立项目需求', projectType, objective, scope: ['完成指定目标'], inputs: [], constraints: ['仅在本地执行'], deliverables: ['可读取的交付文件'], acceptance: ['实际文件存在并通过验收'], questions: [] });
export const samplePlan = (): Plan => ({ title: '并行调研与汇合', summary: '两位成员独立准备材料，编辑汇总。', strategy: '先并行准备 A、B 材料，验收后由编辑汇合。', question: null,
  members: [{ id: 'researcher', name: '研究员', role: '研究', instructions: '准备材料' }, { id: 'editor', name: '编辑', role: '汇合', instructions: '综合材料' }],
  tasks: [
    { id: 'a', title: '调研 A', description: '生成 A.md', memberId: 'researcher', kind: 'task', dependencies: [], acceptance: ['文件存在且有内容'], priority: 5, method: ['读取输入并生成文件', '核对内容'], inputs: ['项目需求'], expectedOutputs: ['Markdown 文档'], experiment: { hypothesis: '两份独立材料可以汇合', variables: ['材料主题'], controls: ['相同验收标准'], setup: '本地文件实验', metrics: ['产出文件完整性'] } },
    { id: 'b', title: '调研 B', description: '生成 B.md', memberId: 'researcher', kind: 'task', dependencies: [], acceptance: ['文件存在且有内容'], priority: 5, method: ['读取输入并生成文件', '核对内容'], inputs: ['项目需求'], expectedOutputs: ['Markdown 文档'], experiment: { hypothesis: '两份独立材料可以汇合', variables: ['材料主题'], controls: ['相同验收标准'], setup: '本地文件实验', metrics: ['产出文件完整性'] } },
    { id: 'join', title: '汇合报告', description: '整合所有上游文件', memberId: 'editor', kind: 'join', dependencies: ['a', 'b'], acceptance: ['包含两份材料'], priority: 4, method: ['读取全部上游交付', '整合并验证'], inputs: ['A.md', 'B.md'], expectedOutputs: ['汇合报告'], experiment: null },
  ],
});
export const sampleEnglishRequirements = (projectType: RequirementsDocument['projectType'] = 'research', objective = 'Prepare a launch brief'): RequirementsDocument => ({
  title: 'Launch brief', projectType, objective, scope: ['Create and review the requested files'], inputs: ['The project goal'],
  constraints: ['Work locally'], deliverables: ['A reviewed report'], acceptance: ['Files exist and contain the required material'], questions: [],
});
export const sampleEnglishPlan = (): Plan => ({
  title: 'Launch brief', summary: 'Research two independent angles, then bring the evidence together in one reviewed report.',
  strategy: 'Run the audience and product research in parallel. Review both files before the editor combines them.', question: null,
  members: [{ id: 'researcher', name: 'Robin', role: 'Research', instructions: 'Prepare evidence with clear sources' }, { id: 'editor', name: 'Sam', role: 'Editorial', instructions: 'Combine and verify the evidence' }],
  tasks: samplePlan().tasks.map((task, index) => ({
    ...task, title: ['Understand the audience', 'Explore the product', 'Write the launch brief'][index],
    description: ['Identify the target audience and their needs.', 'Describe the product and its differentiators.', 'Read both source files and produce a coherent launch brief.'][index],
    method: ['Read the source material', 'Write the deliverable', 'Check it against the acceptance criteria'],
    inputs: ['Project requirements'], expectedOutputs: ['A Markdown document'], acceptance: ['The file exists and contains the requested evidence'],
    experiment: index === 2 ? null : { hypothesis: 'Independent research produces complementary evidence', variables: ['Research angle'], controls: ['Shared acceptance criteria'], setup: 'Two independent local documents', metrics: ['Completeness of the final brief'] },
  })),
});
export class FakeBackend implements AgentBackend {
  id = 'test-provider'; capabilities = { execution: true, history: false, resume: true };
  sessions = new Map<string, SessionOptions>(); active = 0; peak = 0;
  attempts = new Map<string, number>(); order: string[] = []; closed = false; interrupts = 0;
  prompts: string[] = [];
  plan = samplePlan(); requirementsQuestions: string[] = []; requirementCalls = 0; planningCalls = 0; delay = 25; rejectOnce?: string; missingFile = false; requireInput = false; extendOnce = false; finals = 0; controlAction = 'reply';
  async health(): Promise<BackendHealth> { return { id: this.id, connected: true, authenticated: true, version: 'test', message: 'test', models: [] }; }
  async createSession(options: SessionOptions) { const id = `session-${randomUUID()}`; this.sessions.set(id, options); return id; }
  async resume(_sessionId: string) {}
  async interrupt(_sessionId: string) { this.interrupts++; }
  async inspect(_sessionId: string) { return { state: 'idle' as const, completed: false }; }
  async runTurn(options: TurnOptions): Promise<string> {
    this.prompts.push(options.prompt);
    const english = options.prompt.startsWith('This project uses English.');
    const schema = options.outputSchema as any;
    if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (schema.properties.projectType) {
      this.requirementCalls++;
      const context = JSON.parse(options.prompt.slice(options.prompt.indexOf('\n{') + 1));
      return JSON.stringify({ ...(english ? sampleEnglishRequirements : sampleRequirements)(context.typeHint || context.projectType, context.goal), questions: this.requirementsQuestions });
    }
    if (schema.properties.action) return JSON.stringify({ action: this.controlAction, summary: english ? 'I have your update and will follow the current project state.' : '已了解，正在按项目状态处理你的消息。' });
    if (schema.properties.question) { this.planningCalls++; return JSON.stringify(this.plan); }
    if (schema.properties.decision && schema.properties.feedback) {
      const task = JSON.parse(options.prompt.split('\n任务：')[1].split('\n成员结果：')[0]) as Task;
      this.order.push(`review:${task.id}`);
      const reject = this.rejectOnce === task.id && (this.attempts.get(task.id) || 0) === 1;
      return JSON.stringify({ decision: reject ? 'revise' : 'accept', summary: reject ? english ? 'More evidence needed' : '需补充' : english ? 'Content approved' : '内容通过', feedback: reject ? english ? 'Add one supporting source' : '补充一项证据' : '' });
    }
    if (schema.properties.decision && schema.properties.plan) {
      this.finals++;
      if (this.extendOnce && this.finals === 1) return JSON.stringify({ decision: 'extend', summary: '补充交付说明', plan: { ...samplePlan(), tasks: [{ ...samplePlan().tasks[0], id: 'phase2', dependencies: ['join'] }] } });
      return JSON.stringify({ decision: 'complete', summary: english ? 'All material has been written, reviewed, and combined.' : '全部材料已生成、核验并汇合。', plan: null });
    }
    const task = JSON.parse(options.prompt.split('\n当前任务：')[1].split('\n工作目录：')[0]) as Task;
    const session = this.sessions.get(options.sessionId)!;
    this.order.push(`start:${task.id}`); this.active++; this.peak = Math.max(this.active, this.peak);
    this.attempts.set(task.id, (this.attempts.get(task.id) || 0) + 1);
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); this.interrupts++; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
        const timer = setTimeout(() => { options.signal.removeEventListener('abort', cancel); resolve(); }, this.delay);
        options.signal.addEventListener('abort', cancel, { once: true });
      });
      const filename = `${task.id}.md`;
      if (!this.missingFile) await writeFile(join(session.cwd, filename), `# ${task.title}\n\n${english ? 'Actual test output. Dependencies:' : '真实生成的测试文件。依赖：'}${task.dependencies.join(', ')}\n`);
      options.onEvent({ type: 'tool', text: `${english ? 'Wrote' : '写入'} ${filename}` });
      return JSON.stringify({ summary: english ? `${task.title} is complete.` : `${task.title}已完成`, artifacts: [{ path: filename, label: filename }], checks: [{ name: english ? 'File check' : '文件检查', passed: true, detail: english ? 'File exists' : '文件存在' }], needsInput: this.requireInput ? english ? 'Please provide the target audience' : '请提供目标用户资料' : null });
    } finally { this.active--; }
  }
  async close() { this.closed = true; }
}
