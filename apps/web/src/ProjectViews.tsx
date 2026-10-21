import { t as tr, countLabel, getLocale } from './i18n';
import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, FileText, GitMerge, LoaderCircle, Pencil, Users } from 'lucide-react';
import type { Member, Project, RequirementsDocument, Task } from '../../../shared/types';
import { statusLabels } from '../../../shared/types';
import { boardColumn, boardColumns, latestRequirements, needsConfirmation, priorityLabel, roleColumns, supervisorName, taskReason, visibleTasks } from '../../../shared/workflow';
import { api, post, time } from './api';
import { AgentAvatar, MessageText, SectionCard } from './WorkspaceUI';
type ProjectProps = {
    project: Project;
    onTask: (id: string) => void;
};
const typeNames = { development: '代码开发', research: '研究调研', content: '内容与通用交付' };
const fields = [
    ['scope', '工作范围'], ['inputs', '输入材料'], ['constraints', '约束条件'],
    ['deliverables', '预期交付'], ['acceptance', '完成标准'], ['questions', '待确认事项'],
] as const;
function Lines({ items, empty = tr("暂未填写") }: {
    items?: string[];
    empty?: string;
}) {
    return items?.length ? <ul className="document-list">{items.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p className="muted">{empty}</p>;
}
export function RequirementsView({ project, onUpdate, onError }: {
    project: Project;
    onUpdate: (p: Project) => void;
    onError: (s: string) => void;
}) {
    const latest = latestRequirements(project);
    const [document, setDocument] = useState<RequirementsDocument | null>(latest?.document || null);
    const [selected, setSelected] = useState<number | null>(null), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false);
    useEffect(() => { setDocument(latest?.document || null); setSelected(null); setEditing(false); }, [project.id, latest?.version]);
    const confirmed = !needsConfirmation(project), historical = selected !== null && selected !== latest?.version;
    const shown = historical ? project.requirements?.find(r => r.version === selected)?.document : document;
    const dirty = JSON.stringify(document) !== JSON.stringify(latest?.document);
    const working = project.runs.some(r => r.status === 'running');
    async function submit(confirm: boolean) {
        if (!document || !latest)
            return;
        const clean = { ...document, ...Object.fromEntries(fields.map(([key]) => [key, document[key].map(s => s.trim()).filter(Boolean)])) };
        setBusy(true);
        try {
            let updated = project;
            if (JSON.stringify(clean) !== JSON.stringify(latest.document) || (confirmed && !confirm))
                updated = await api<Project>(`/projects/${project.id}/requirements`, { method: 'PUT', body: JSON.stringify({ version: latest.version, document: clean }) });
            if (confirm)
                updated = await post<Project>(`/projects/${project.id}/requirements/confirm`, { version: latestRequirements(updated)!.version });
            setDocument(clean);
            onUpdate(updated);
            setEditing(false);
        }
        catch (e) {
            onError((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    if (!latest || !shown)
        return <div className="document-page"><SectionCard><div className="empty-state"><FileText size={32}/>
    <h3>{project.workflowVersion !== 2 ? tr("原有项目，记录完整保留") : project.status === 'planning' ? tr("{p0}正在整理需求", { p0: supervisorName(project) }) : tr("等待整理项目需求")}</h3>
    <p>{project.workflowVersion !== 2 ? tr("此项目没有历史需求文档。主动修订后，可进入需求确认与自动规划流程。") : tr("需求会整理成一份可编辑的文档，等你确认后再安排团队。")}</p>
    {project.workflowVersion !== 2 && <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try {
            onUpdate(await post(`/projects/${project.id}/messages`, { content: tr("请重新整理项目需求，进入需求确认流程；保留已有任务记录，等待我确认后再设计新计划。") }));
        }
        catch (e) {
            onError((e as Error).message);
        }
        finally {
            setBusy(false);
        } }}>{tr("修订项目需求")}</button>}
  </div></SectionCard></div>;
    const editable = !historical && (!confirmed || editing);
    return <div className="document-page requirements-page">
    <div className="document-heading"><div className="document-status"><span className={`badge ${confirmed && !historical ? 's-completed' : 's-pending'}`}>{historical ? tr("历史版本") : confirmed ? tr("需求已确认") : tr("待你确认")}</span><span>{historical ? tr("查看当时的需求内容") : confirmed ? tr("{p0}按此版本推进", { p0: supervisorName(project) }) : tr("确认内容，开始规划")}</span></div><div className="document-heading-actions">
      {confirmed && !historical && !editing && <button className="secondary" onClick={() => setEditing(true)}><Pencil size={13}/>{tr("修订")}</button>}
      <select aria-label={tr("需求版本")} value={selected ?? latest.version} onChange={e => setSelected(Number(e.target.value))}>{[...(project.requirements || [])].reverse().map(r => <option value={r.version} key={r.version}>{tr("需求 v")}{r.version}{r.confirmedAt ? tr(" · 已确认") : ''}</option>)}</select>
    </div></div>
    {editing && <div className="info-box"><AlertCircle size={16}/><p>{tr("保存后暂停本项目，重新确认再规划。已有记录与文件会保留。")}</p></div>}
    <SectionCard title={tr("项目概览")} className="brief-card"><div className="requirements-overview">
      <label>{tr("项目名称")}{editable ? <input value={shown.title} onChange={e => setDocument({ ...shown, title: e.target.value })}/> : <strong>{shown.title}</strong>}</label>
      <label>{tr("项目类型")}{editable ? <select value={shown.projectType} onChange={e => setDocument({ ...shown, projectType: e.target.value as RequirementsDocument['projectType'] })}>{Object.entries(typeNames).map(([k, v]) => <option key={k} value={k}>{tr(v)}</option>)}</select> : <span className="type-tag">{tr(typeNames[shown.projectType])}</span>}</label>
      <label className="full-field">{tr("项目目标")}{editable ? <textarea rows={3} value={shown.objective} onChange={e => setDocument({ ...shown, objective: e.target.value })}/> : <p className="objective-copy">{shown.objective}</p>}</label>
    </div></SectionCard>
    <div className="requirements-grid">{fields.filter(([key]) => key !== 'questions' || editable || shown.questions.length).map(([key, label], index) => <SectionCard key={key} title={tr(label)} action={<span className="section-number">{String(index + 1).padStart(2, '0')}</span>} className={key === 'questions' ? 'questions-card' : ''}>
      {editable ? <textarea aria-label={tr(label)} rows={4} value={shown[key].join('\n')} placeholder={key === 'questions' ? tr("没有待确认事项时留空") : tr("每行一项")} onChange={e => setDocument({ ...shown, [key]: e.target.value.split('\n') })}/> : <Lines items={shown[key]} empty={key === 'inputs' ? tr("暂无额外输入材料") : key === 'constraints' ? tr("暂无额外约束") : tr("暂无内容")}/>}
    </SectionCard>)}</div>
    {!historical && editable && <div className="document-actions"><button className="secondary" disabled={busy || (!dirty && !editing)} onClick={() => void submit(false)}>{tr("保存需求")}</button>
      {!confirmed && <button className="primary" disabled={busy || working || !!document?.questions.some(q => q.trim())} onClick={() => void submit(true)}>{busy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}{tr("确认需求并制定计划")}</button>}
      {editing && <button className="text-button" onClick={() => { setEditing(false); setDocument(latest.document); }}>{tr("取消修订")}</button>}
    </div>}
    {!historical && !confirmed && document?.questions.some(q => q.trim()) && <p className="document-meta">{tr("还有待确认事项。可以编辑文档，或在右侧对话中补充信息。")}</p>}
  </div>;
}
function TaskCard({ project, task, onTask }: ProjectProps & {
    task: Task;
}) {
    const member = project.members.find(m => m.id === task.memberId);
    return <button className="board-card" data-task-id={task.id} onClick={() => onTask(task.id)}>
    <div className="card-topline"><span className="module-type">{task.kind === 'join' ? <><GitMerge size={12}/>{tr("汇合模块")}</> : tr("执行模块")}</span><span className={`badge s-${task.status}`}>{tr(statusLabels[task.status])}</span></div>
    <strong>{task.title}</strong><p className={['blocked', 'interrupted'].includes(task.status) ? 'task-issue' : ''}>{taskReason(project, task, getLocale())}</p>
    <div className="card-assignee"><span><AgentAvatar name={member?.name || tr("待分配")}/>{member?.name || tr("待分配")}</span><span className={`priority priority-${priorityLabel(task.priority)}`} title={tr("优先级 0–10，数字越大越优先")}>{tr("优先级").trim()} {task.priority}</span></div>
    {task.status === 'completed' && <span className="card-result"><FileText size={13}/>{countLabel(task.artifactIds.length, 'files')}<span>{tr("查看结果")}<ArrowRight size={13}/></span></span>}
  </button>;
}
export function TaskBoard(props: ProjectProps) {
    return <div className="board status-board">{boardColumns.map(column => {
            const tasks = visibleTasks(props.project).filter(t => boardColumn(t.status) === column.id);
            return <section className={`board-column column-${column.id}`} key={column.id}><h3><i />{tr(column.label)}<span>{tasks.length}</span></h3><div className="column-content">{tasks.map(task => <TaskCard {...props} task={task} key={task.id}/>)}{!tasks.length && <div className="column-empty">{tr("暂无模块")}</div>}</div></section>;
        })}</div>;
}
export function RoleBoard({ onMember, ...props }: ProjectProps & {
    onMember: (m: Member) => void;
}) {
    const columns = roleColumns(props.project);
    if (!columns.length)
        return <div className="document-page"><SectionCard><div className="empty-state"><Users size={32}/><h3>{tr("等待组建项目团队")}</h3><p>{tr("确认需求后，")}{supervisorName(props.project)}{tr("会设计角色与分工。每位成员都有名字和明确的职责。")}</p></div></SectionCard></div>;
    return <div className="board role-board">{columns.map(column => <section className="board-column" key={column.role}>
    <h3>{column.role}<span>{column.tasks.length}</span></h3><div className="role-members">{column.members.map(m => <button key={m.id} onClick={() => onMember(m)} title={tr("编辑{p0}的名字与职责", { p0: m.name })}><AgentAvatar name={m.name}/><span><strong>{m.name}</strong><small>{m.instructions || tr("查看职责")}</small></span><Pencil size={13}/></button>)}</div>
    <div className="column-content">{column.tasks.map(task => <TaskCard {...props} key={task.id} task={task}/>)}{!column.tasks.length && <div className="column-empty">{tr("尚未分配模块")}</div>}</div>
  </section>)}</div>;
}
export function TaskMethod({ task }: {
    task: Task;
}) {
    return <div className="task-method">
    {!!task.method?.length && <SectionCard title={tr("执行步骤")} className="method-steps"><ol className="document-list steps-list">{task.method.map((s, i) => <li key={i}>{s}</li>)}</ol></SectionCard>}
    {!!task.inputs?.length && <SectionCard title={tr("输入材料")}><Lines items={task.inputs}/></SectionCard>}
    {!!task.expectedOutputs?.length && <SectionCard title={tr("预期产出")}><Lines items={task.expectedOutputs}/></SectionCard>}
    {task.experiment && <SectionCard title={tr("实验设计")} className="experiment-detail"><dl><div><dt>{tr("假设")}</dt><dd>{task.experiment.hypothesis || tr("未设假设")}</dd></div><div><dt>{tr("变量")}</dt><dd><Lines items={task.experiment.variables}/></dd></div><div><dt>{tr("对照")}</dt><dd><Lines items={task.experiment.controls}/></dd></div><div><dt>{tr("实验设置")}</dt><dd>{task.experiment.setup}</dd></div><div><dt>{tr("评价指标")}</dt><dd><Lines items={task.experiment.metrics}/></dd></div></dl></SectionCard>}
  </div>;
}
export function ExperimentPlanView({ project, onTask }: ProjectProps) {
    const revisions = project.revisions.filter(r => r.plan), [selected, setSelected] = useState<number | null>(null);
    const revision = revisions.find(r => r.number === selected) || revisions.at(-1);
    if (!revision?.plan)
        return <div className="document-page"><SectionCard><div className="empty-state"><FileText size={32}/><h3>{project.workflowVersion !== 2 ? tr("此项目没有历史计划文档") : project.stage === 'planning' ? tr("正在设计团队与执行方案") : tr("先确认需求，再制定计划")}</h3><p>{tr("计划将说明每个模块做什么、由谁负责，以及如何验收。")}</p></div></SectionCard></div>;
    const plan = revision.plan;
    return <div className="document-page plan-page"><div className="document-heading"><div className="document-status"><span className="type-tag">{countLabel(plan.tasks.length, 'modules')}</span><span>{revision.requirementsVersion ? tr("基于需求 v{p0}", { p0: revision.requirementsVersion }) : tr("旧版计划")} · {time(revision.createdAt)}</span></div><select aria-label={tr("计划版本")} value={revision.number} onChange={e => setSelected(Number(e.target.value))}>{[...revisions].reverse().map(r => <option key={r.number} value={r.number}>{tr("计划 v")}{r.number}</option>)}</select></div>
    <SectionCard title={tr("总体方案")} className="strategy-card"><MessageText text={plan.summary} project={project}/>{plan.strategy && plan.strategy !== plan.summary && <details className="strategy-details"><summary>{tr("完整执行方案")}<ChevronDown size={14}/></summary><MessageText text={plan.strategy} project={project}/></details>}</SectionCard>
    <div className="plan-modules">{plan.tasks.map((spec, index) => {
            const live = project.tasks.find(t => t.id === spec.id), task = { ...spec, status: live?.status || 'superseded', phase: live?.phase || 1, reworks: live?.reworks || 0, artifactIds: live?.artifactIds || [] } as Task;
            const member = revision.number === revisions.at(-1)?.number ? project.members.find(m => m.id === (live?.memberId || spec.memberId)) : plan.members.find(m => m.id === spec.memberId);
            return <article className="plan-module" key={spec.id}><header className="plan-module-head"><span className="module-number">{String(index + 1).padStart(2, '0')}</span><div><h3><button onClick={() => onTask(spec.id)}>{spec.title}<ArrowRight size={16}/></button></h3><div className="plan-owner"><AgentAvatar name={member?.name || tr("待分配")}/><span>{member?.name} · {member?.role}</span></div></div><span className={`badge s-${task.status}`}>{tr(statusLabels[task.status])}</span></header>
        <p className="module-description">{spec.description}</p><div className="plan-dependencies"><GitMerge size={14}/><span>{spec.dependencies.length ? tr("前置模块") : tr("可独立执行")}</span>{spec.dependencies.map(id => <button key={id} onClick={() => onTask(id)}>{plan.tasks.find(t => t.id === id)?.title || id}</button>)}</div>
        <details className="plan-method-details"><summary>{tr("执行方法与验收标准")}<ChevronDown size={14}/></summary><TaskMethod task={task}/><SectionCard title={tr("验收标准")}><Lines items={spec.acceptance}/></SectionCard></details>
      </article>;
        })}</div></div>;
}
