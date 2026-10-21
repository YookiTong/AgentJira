import { t as tr } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowRight, ArrowUp, Check, CheckCheck, ChevronDown, FileText, FolderOpen, GitBranch, MessageSquare, Pencil, Sparkles } from 'lucide-react';
import type { Artifact, Message, Project } from '../../../shared/types';
import { runPurposeLabels, runStatusLabels, stageLabels, supervisorName, visibleTasks } from '../../../shared/workflow';
import { time } from './api';
export function SectionCard({ title, description, action, children, className = '' }: {
    title?: string;
    description?: string;
    action?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return <section className={`section-card ${className}`}>
    {(title || action) && <header className="section-card-head"><div>{title && <h3>{title}</h3>}{description && <p>{description}</p>}</div>{action}</header>}
    {children}
  </section>;
}
export function AgentAvatar({ name, lead = false }: {
    name: string;
    lead?: boolean;
}) {
    return <span className={`agent-avatar ${lead ? 'lead-avatar' : ''}`} aria-hidden="true">{name.slice(0, 1)}</span>;
}
export function MessageText({ text, project }: {
    text: string;
    project: Project;
}) {
    return <div className="rich-text"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ href, children }) => {
                let decoded = href || '';
                try {
                    decoded = decodeURIComponent(decoded);
                }
                catch { }
                const file = project.artifacts.find(a => a.path === decoded || a.path.endsWith('/' + decoded));
                if (file)
                    return <a href={`/api/projects/${project.id}/artifacts/${file.id}`} download>{children}</a>;
                if (href && /^https?:\/\//.test(href))
                    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                return <span>{children}</span>;
            } }}>{text}</ReactMarkdown></div>;
}
export function ArtifactRow({ artifact, project }: {
    artifact: Artifact;
    project: Project;
}) {
    const filename = artifact.path.split('/').at(-1)?.replace(/^\d+-/, '') || artifact.name;
    return <a className="artifact-row" href={`/api/projects/${project.id}/artifacts/${artifact.id}`} download>
    <span className="file-icon"><FileText size={20}/></span>
    <div><strong>{artifact.name}</strong><span className="artifact-filename">{filename}</span><small>
      {artifact.taskId ? project.tasks.find(t => t.id === artifact.taskId)?.title : tr("参考材料")} · {artifact.bytes < 1024 ? `${artifact.bytes} B` : `${(artifact.bytes / 1024).toFixed(1)} KB`}
    </small></div>
    <ArrowDownToLine size={16}/>
  </a>;
}
function CollapsibleMessage({ text, project }: {
    text: string;
    project: Project;
}) {
    const [expanded, setExpanded] = useState(false);
    const long = text.length > 200;
    return <><div className={`message-content ${long && !expanded ? 'message-collapsed' : ''}`}><MessageText text={text} project={project}/></div>
    {long && <button className="expand-copy" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? tr("收起") : tr("展开全文")}<ChevronDown size={12}/></button>}</>;
}
function ConversationMessage({ message, project, onTask }: {
    message: Message;
    project: Project;
    onTask: (id: string) => void;
}) {
    const name = message.role === 'user' ? tr("你") : supervisorName(project);
    if (message.role === 'system')
        return <div className="system-note"><Check size={12}/><span>{message.content}</span></div>;
    return <article className={`chat-message ${message.role}`}>
    <header className="message-meta"><span><AgentAvatar name={name} lead={message.role === 'supervisor'}/><strong>{name}</strong>{message.role === 'supervisor' && <small>{tr("主管")}</small>}</span><time dateTime={message.createdAt}>{time(message.createdAt)}</time></header>
    <CollapsibleMessage text={message.content} project={project}/>
    {message.taskId && <button className="message-task" onClick={() => onTask(message.taskId!)}><GitBranch size={13}/><span>{project.tasks.find(t => t.id === message.taskId)?.title || tr("查看模块")}</span><ArrowRight size={13}/></button>}
  </article>;
}
export function SupervisorPanel({ project, prompt, onDraft, onSend, onTask, onRename, busy }: {
    project: Project;
    prompt: string;
    onDraft: (value: string) => void;
    onSend: () => void;
    onTask: (id: string) => void;
    onRename: () => void;
    busy: boolean;
}) {
    const [mode, setMode] = useState<'chat' | 'updates'>('chat');
    const messagesRef = useRef<HTMLDivElement>(null);
    const name = supervisorName(project);
    const tasks = visibleTasks(project), done = tasks.filter(t => t.status === 'completed').length;
    const working = project.runs.some(r => r.status === 'running' && r.purpose !== 'execution');
    const updates = project.messages.filter(m => m.role === 'supervisor').slice().reverse();
    useEffect(() => {
        const messages = messagesRef.current;
        if (mode === 'chat' && messages) messages.scrollTop = messages.scrollHeight;
    }, [project.id, project.messages.length, mode]);
    return <aside className="supervisor-chat" aria-label={tr("项目协作")}>
    <div className="collaboration-heading"><h2>{tr("项目协作")}</h2><span className={`status-dot ${working ? 's-running' : 's-completed'}`}/></div>
    <button className="supervisor-profile" onClick={onRename} title={tr("修改主管名字")}>
      <AgentAvatar name={name} lead/><span><strong>{name}<small>{tr("项目主管")}</small></strong><span>{working ? tr("正在处理你的项目") : tr("整理需求、安排任务、验收交付")}</span></span><Pencil size={14}/>
    </button>
    <div className="collaboration-tabs" role="tablist" aria-label={tr("协作内容")}>
      <button role="tab" aria-selected={mode === 'chat'} className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><MessageSquare size={14}/>{tr("对话")}</button>
      <button role="tab" aria-selected={mode === 'updates'} className={mode === 'updates' ? 'active' : ''} onClick={() => setMode('updates')}><Sparkles size={14}/>{tr("进展")}</button>
    </div>
    {mode === 'chat' ? <div key="chat" ref={messagesRef} className="chat-messages">
      <div className="conversation-start"><span>{tr("本项目专属对话")}</span></div>
      {project.messages.map(message => <ConversationMessage key={message.id} message={message} project={project} onTask={onTask}/>)}
      {working && <div className="agent-thinking"><span className="thinking"><i /><i /><i /></span>{name}{tr("正在处理")}</div>}
    </div> : <div key="updates" className="progress-feed">
      <SectionCard className="progress-brief"><small>{project.stage ? tr(stageLabels[project.stage]) : tr("项目进度")}</small><strong>{project.status === 'completed' ? tr("全部模块已交付") : tr("{p0} / {p1} 个模块已完成", { p0: done, p1: tasks.length })}</strong><div className="progress-meter"><span style={{ width: `${tasks.length ? done / tasks.length * 100 : 0}%` }}/></div></SectionCard>
      {updates.length ? updates.map(message => <article className="update-card" key={message.id}><div className="update-card-meta"><span>{message.taskId ? tr("模块进展") : tr("主管更新")}</span><time>{time(message.createdAt)}</time></div><CollapsibleMessage text={message.content} project={project}/>{message.taskId && <button className="text-button" onClick={() => onTask(message.taskId!)}>{tr("查看模块")}<ArrowRight size={13}/></button>}</article>) : <div className="empty-state"><Sparkles size={24}/><h3>{tr("进展会在这里更新")}</h3><p>{tr("需求整理、任务安排与验收结果会按时间汇集。")}</p></div>}
    </div>}
    <div className="chat-compose"><textarea aria-label={tr("给{p0}发送消息", { p0: name })} value={prompt} onChange={e => onDraft(e.target.value)} placeholder={tr("和{p0}说说：补充需求、询问进度…", { p0: name })} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!busy && prompt.trim())
                    onSend();
            }
        }}/><div><span>{tr("Enter 发送 · Shift Enter 换行")}</span><button className="send-prompt" disabled={busy || !prompt.trim()} onClick={onSend} aria-label={tr("发送给主管")}><ArrowUp size={17}/></button></div></div>
  </aside>;
}
export function ActivityView({ project }: {
    project: Project;
}) {
    return <div className="document-page activity-page">
    <SectionCard title={project.finalSummary ? tr("本次交付总结") : tr("{p0}的最新安排", { p0: supervisorName(project) })} className="summary-card">
      <MessageText text={project.finalSummary || project.messages.filter(m => m.role === 'supervisor').at(-1)?.content || tr("主管正在了解项目目标。")} project={project}/>
      {project.integrationPath && <details className="technical-details"><summary>{tr("代码集成位置")}</summary><code>{project.integrationBranch}<br />{project.integrationPath}</code></details>}
    </SectionCard>
    <div className="history-grid">
      <SectionCard title={tr("需求版本")} description={tr("保留每次确认与修订")}>
        {project.requirements?.length ? [...project.requirements].reverse().map(r => <div className="history-item" key={r.version}><span className="version-label">v{r.version}</span><div><strong>{r.document.title}</strong><small>{r.confirmedAt ? tr("已确认") : tr("待确认")} · {time(r.createdAt)}</small></div></div>) : <p className="muted">{tr("此项目沿用旧版流程，没有需求确认记录。")}</p>}
      </SectionCard>
      <SectionCard title={tr("计划版本")} description={tr("记录分工与执行方案的变化")}>
        {project.revisions.length ? [...project.revisions].reverse().map(r => <div className="history-item" key={r.number}><span className="version-label">v{r.number}</span><div><p>{r.summary}</p><small>{r.taskIds.length}{tr("个模块 ·")}{time(r.createdAt)}</small></div></div>) : <p className="muted">{tr("确认需求后生成第一版计划。")}</p>}
      </SectionCard>
    </div>
    <SectionCard title={tr("执行记录")} description={tr("展开查看真实输出与操作记录")}>
      {project.runs.length ? [...project.runs].reverse().map(r => <details className="run-details" key={r.id}><summary><span className={`status-dot s-${r.status}`}/><span>{r.taskId ? project.tasks.find(t => t.id === r.taskId)?.title : supervisorName(project)}<small>{tr(runPurposeLabels[r.purpose])} · {time(r.startedAt)}</small></span><span className={`badge s-${r.status}`}>{tr(runStatusLabels[r.status])}</span></summary><pre>{r.error || r.log || tr("等待输出…")}</pre></details>) : <p className="muted">{tr("项目开始后，执行记录会显示在这里。")}</p>}
    </SectionCard>
  </div>;
}
export function FilesView({ project, upload }: {
    project: Project;
    upload: ReactNode;
}) {
    const tasks = visibleTasks(project);
    const outputs = project.artifacts.filter(a => a.kind === 'output' && tasks.some(t => t.artifactIds.includes(a.id)));
    const history = project.artifacts.filter(a => a.kind === 'output' && !outputs.some(current => current.id === a.id));
    const inputs = project.artifacts.filter(a => a.kind === 'input');
    return <div className="document-page files-page">
    <SectionCard title={tr("交付文件")} description={tr("{p0} 份文件已通过验收，可直接下载", { p0: outputs.length })} action={<CheckCheck size={19}/>}>
      {outputs.length ? <div className="artifact-grid">{outputs.map(a => <ArtifactRow key={a.id} artifact={a} project={project}/>)}</div> : <div className="empty-state"><FolderOpen size={28}/><h3>{tr("等待第一份交付")}</h3><p>{tr("模块通过验收后，文件会自动收录在这里。")}</p></div>}
    </SectionCard>
    <SectionCard title={tr("参考材料")} description={tr("提供给团队的项目背景与输入文件")} action={upload}>
      {inputs.length ? <div className="artifact-grid">{inputs.map(a => <ArtifactRow key={a.id} artifact={a} project={project}/>)}</div> : <p className="muted">{tr("暂未添加材料。你也可以直接在对话中补充背景。")}</p>}
    </SectionCard>
    {history.length > 0 && <details className="section-card artifact-history"><summary>{tr("历史执行文件")}<span>{history.length}</span></summary><p className="muted">{tr("已替代或未通过验收的文件，保留供追溯。")}</p><div className="artifact-grid">{history.map(a => <ArtifactRow key={a.id} artifact={a} project={project}/>)}</div></details>}
  </div>;
}
