import { t as tr, useLocale, setLocale, projectUrl, unitLabel } from './i18n';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleHelp, Command, File, FileText, Folder, FolderOpen, GitBranch, GitMerge, Home, Layers, LayoutDashboard, ListTodo, LoaderCircle, MessageSquare, Menu, Network, Paperclip, Pause, Play, Plus, RefreshCw, Search, Send, Settings as SettingsIcon, ShieldCheck, Sparkles, Users, Workflow, X, Zap, AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';
import type { Artifact, BackendHealth, Member, Project, Settings, Task, TemplateId, ThreadSummary } from '../../../shared/types';
import { templates, statusLabels } from '../../../shared/types';
import { api, post, download, fileBase64, time } from './api';
import { Graph, memberColor } from './Graph';
import { currentMembers, latestRequirements, needsConfirmation, roleColumns, projectSummary, runStatusLabels, stageLabels, supervisorName, visibleTasks } from '../../../shared/workflow';
import { RequirementsView, ExperimentPlanView, TaskBoard, RoleBoard, TaskMethod } from './ProjectViews';
import { ActivityView, AgentAvatar, ArtifactRow, FilesView, MessageText, SectionCard, SupervisorPanel } from './WorkspaceUI';
import { restoreWorkspace, workspaceReducer, views, type View, type WorkspaceAction } from './workspace-state';
const templateIcon = { development: Layers, research: Search, content: FileText };
function Badge({ status }: {
    status: string;
}) { return <span className={`badge s-${status}`}><i />{tr(statusLabels[status as keyof typeof statusLabels] || status)}</span>; }
function Spinner() { return <LoaderCircle size={16} className="spin"/>; }
function Modal({ title, subtitle, children, onClose, wide }: {
    title: string;
    subtitle?: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const root = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        root.current?.focus();
        const key = (e: KeyboardEvent) => {
            if (e.key === 'Escape')
                closeRef.current();
            if (e.key === 'Tab') {
                const items = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
                if (!items?.length)
                    return;
                const first = items[0], last = items[items.length - 1];
                if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
                    e.preventDefault();
                    last.focus();
                }
                else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        window.addEventListener('keydown', key);
        return () => { window.removeEventListener('keydown', key); document.body.style.overflow = previousOverflow; previous?.focus({ preventScroll: true }); };
    }, []);
    return <div className="modal-shade" onMouseDown={e => { if (e.target === e.currentTarget)
        onClose(); }}><div ref={root} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label={tr("关闭")}><X size={19}/></button></div>{children}</div></div>;
}
export function App() {
    const locale = useLocale();
    const [projects, setProjects] = useState<Project[]>([]);
    const [workspace, setWorkspace] = useState(() => { try {
        return restoreWorkspace(localStorage.getItem('heliu-workspace-v2'), new URLSearchParams(location.search).get('project'));
    }
    catch {
        return restoreWorkspace(null, new URLSearchParams(location.search).get('project'));
    } });
    const selectedId = workspace.activeId;
    const project = projects.find(p => p.id === selectedId) || null;
    const view = selectedId ? workspace.views[selectedId] || (project?.workflowVersion === 2 ? 'requirements' : 'flow') : 'requirements';
    const prompt = selectedId ? workspace.drafts[selectedId] || '' : '';
    const [health, setHealth] = useState<BackendHealth | null>(null), [error, setError] = useState('');
    const [connection, setConnection] = useState<'connecting' | 'online' | 'offline' | 'reconnecting'>('connecting');
    const [busyIds, setBusyIds] = useState<string[]>([]);
    const activeActions = useRef(new Set<string>());
    const busy = busyIds.includes(selectedId || '@new');
    const [supervisorOpen, setSupervisorOpen] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false), [importOpen, setImportOpen] = useState(false), [directoryOpen, setDirectoryOpen] = useState(false), [planOpen, setPlanOpen] = useState(false);
    const [selectedTask, setSelectedTask] = useState<string | null>(null), [editingMember, setEditingMember] = useState<Member | null>(null);
    const [goal, setGoal] = useState(() => { try {
        return localStorage.getItem('heliu-new-project-draft') || '';
    }
    catch {
        return '';
    } }), [directory, setDirectory] = useState(''), [files, setFiles] = useState<File[]>([]), [source, setSource] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const attachmentRef = useRef<HTMLInputElement>(null), creationKey = useRef(crypto.randomUUID());
    const creationSignature = useRef('');
    const updateWorkspace = useCallback((action: WorkspaceAction) => setWorkspace(old => workspaceReducer(old, action)), []);
    const setProject = useCallback((p: Project) => setProjects(old => {
        const existing = old.find(x => x.id === p.id);
        if (existing && existing.version > p.version)
            return old;
        return existing ? old.map(x => x.id === p.id ? p : x) : [...old, p];
    }), []);
    const reload = useCallback(async () => {
        let incoming: Project[];
        try { incoming = await api<Project[]>('/projects'); setConnection('online'); }
        catch (error) { setConnection('offline'); throw error; }
        setProjects(old => { const all = new Map(old.map(p => [p.id, p])); for (const p of incoming)
            if (!all.has(p.id) || all.get(p.id)!.version <= p.version)
                all.set(p.id, p); return [...all.values()]; });
        return incoming;
    }, []);
    useEffect(() => { try {
        localStorage.setItem('heliu-workspace-v2', JSON.stringify(workspace));
    }
    catch { /* UI state is optional when storage is full. */ } }, [workspace]);
    useEffect(() => { try {
        localStorage.setItem('heliu-new-project-draft', goal);
    }
    catch { /* Keep editing when browser storage is unavailable. */ } }, [goal]);
    useEffect(() => {
        void reload().then(list => updateWorkspace({ type: 'reconcile', ids: list.map(p => p.id) })).catch(e => setError(e.message));
        api<BackendHealth>('/health').then(setHealth).catch(e => setError(e.message));
        const timer = setInterval(() => void reload().catch(() => { }), 10000);
        return () => clearInterval(timer);
    }, [reload, updateWorkspace]);
    useEffect(() => {
        history.replaceState({}, '', projectUrl(selectedId));
        document.documentElement.lang = locale;
        document.title = `Agent Jira · ${tr('项目工作台')}`;
    }, [selectedId, locale]);
    useEffect(() => { const handler = () => {
        const params = new URLSearchParams(location.search);
        if (params.has('lang')) setLocale(params.get('lang') === 'en' ? 'en' : 'zh-CN');
        updateWorkspace({ type: 'open', id: params.get('project') });
    }; window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, [updateWorkspace]);
    useEffect(() => { window.scrollTo(0, 0); }, [selectedId, view]);
    useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
    useEffect(() => { setSelectedTask(null); setEditingMember(null); setPlanOpen(false); setSupervisorOpen(false); }, [selectedId]);
    useEffect(() => { if (!error)
        return; const timer = setTimeout(() => setError(''), 9000); return () => clearTimeout(timer); }, [error]);
    useEffect(() => {
        if (!selectedId)
            return;
        let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => api<Project>(`/projects/${selectedId}`).then(p => { if (!disposed)
            setProject(p); }).catch(e => { if (!disposed)
            setError(e.message); });
        void refresh();
        const events = new EventSource(`/api/projects/${selectedId}/events`);
        events.addEventListener('snapshot', e => { if (!disposed) {
            setConnection('online'); setProject(JSON.parse((e as MessageEvent).data));
        } });
        events.addEventListener('error', () => { if (!disposed) setConnection(previous => previous === 'offline' ? 'offline' : 'reconnecting'); });
        events.addEventListener('update', () => { if (!timer)
            timer = setTimeout(() => { timer = undefined; void refresh(); }, 250); });
        return () => { disposed = true; events.close(); clearTimeout(timer); };
    }, [selectedId, setProject]);
    const chooseProject = (id: string | null) => { setSidebarOpen(false); history.pushState({}, '', projectUrl(id)); updateWorkspace({ type: 'open', id }); };
    const setView = (next: View) => { if (selectedId)
        updateWorkspace({ type: 'view', id: selectedId, view: next }); };
    const onTask = useCallback((id: string) => setSelectedTask(id), []);
    const act = async (id: string | null, work: () => Promise<unknown>) => { const key = id || '@new';
    if (activeActions.current.has(key)) return;
    activeActions.current.add(key); setBusyIds(old => [...old, key]); try {
        await work();
        await reload();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        activeActions.current.delete(key);
        setBusyIds(old => old.filter(x => x !== key));
    } };
    const create = () => act(null, async () => {
        if (goal.trim().length < 2)
            throw new Error(tr("先告诉主管你希望完成的目标"));
        const attachments = await Promise.all(files.map(async file => {
            const base64 = await fileBase64(file);
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
            return { name: file.name, base64, sha256: [...hash].map(n => n.toString(16).padStart(2, '0')).join('') };
        }));
        const payload = JSON.stringify({ goal: goal.trim(), language: locale, workingDirectory: directory || undefined, sourceThreadId: source?.id, start: false });
        if (creationSignature.current !== payload) { creationKey.current = crypto.randomUUID(); creationSignature.current = payload; }
        const p = await api<Project>('/projects', { method: 'POST', headers: { 'Idempotency-Key': creationKey.current }, body: payload });
        setProject(p);
        const uploaded = [...p.artifacts];
        for (const attachment of attachments)
            if (!uploaded.some(a => a.kind === 'input' && a.name === attachment.name && a.sha256 === attachment.sha256)) {
                const { name, base64 } = attachment;
                uploaded.push(await post<Artifact>(`/projects/${p.id}/attachments`, { name, base64 }));
            }
        setProject(await post<Project>(`/projects/${p.id}/control`, { action: 'start' }));
        chooseProject(p.id);
        updateWorkspace({ type: 'view', id: p.id, view: 'requirements' });
        creationKey.current = crypto.randomUUID();
        creationSignature.current = '';
        setGoal('');
        setFiles([]);
        setSource(null);
        setDirectory('');
    });
    const control = (action: string) => { if (project)
        void act(project.id, async () => setProject(await post(`/projects/${project.id}/control`, { action }))); };
    const send = () => { if (!project || !prompt.trim() || activeActions.current.has(project.id))
        return; const id = project.id, text = prompt.trim(); updateWorkspace({ type: 'draft', id, text: '' }); void act(id, async () => { try {
        setProject(await post(`/projects/${id}/messages`, { content: text }));
    }
    catch (e) {
        setWorkspace(old => old.drafts[id] ? old : workspaceReducer(old, { type: 'draft', id, text }));
        throw e;
    } }); };
    const tasks = project ? visibleTasks(project) : [], members = project ? currentMembers(project) : [];
    const done = tasks.filter(t => t.status === 'completed').length, running = tasks.filter(t => ['running', 'reviewing'].includes(t.status)).length;
    const isRunning = project && ['planning', 'running'].includes(project.status);
    const canAttach = project && ['draft', 'paused', 'blocked'].includes(project.status);
    const task = project?.tasks.find(t => t.id === selectedTask);
    const currentArtifacts = project?.artifacts.filter(a => a.kind === 'output' && tasks.some(t => t.artifactIds.includes(a.id))) || [];
    const badgeLabel = (p: Project) => p.stage === 'awaiting_confirmation' && needsConfirmation(p) ? tr("待确认") : p.stage === 'requirements' && p.status === 'planning' ? tr("整理需求") : tr(statusLabels[p.status]);
    const reconnect = async () => { setConnection('connecting'); try { await reload(); setHealth(await api('/health')); } catch (e) { setError((e as Error).message); } };
    return <div className="app-shell">
    <aside id="project-navigation" className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label={tr("项目导航")}>
      <button className="brand" aria-label="Agent Jira" onClick={() => chooseProject(null)}><span className="brand-mark"><Workflow size={23}/></span><span>Agent Jira<small>{tr("项目工作台")}</small></span></button>
      <button className="new-project" onClick={() => chooseProject(null)}><Plus size={17}/>{tr("新建项目")}</button>
      <nav><button className={`nav-item ${!selectedId ? 'active' : ''}`} onClick={() => chooseProject(null)}><Home size={17}/>{tr("项目工作台")}</button></nav>

      <div className="sidebar-label">{tr("所有项目")}<span>{projects.length}</span></div>
      <nav className="project-nav" aria-label={tr("项目列表")}>{projects.length ? projects.map(p => {
        const modules = visibleTasks(p), completed = modules.filter(t => t.status === 'completed').length;
        return <button key={p.id} className={`project-link ${selectedId === p.id ? 'selected' : ''}`} aria-label={p.title} aria-current={selectedId === p.id ? 'page' : undefined} onClick={() => chooseProject(p.id)} title={`${p.title}\n${projectSummary(p)}`}>
          <span className="project-link-heading"><strong>{p.title}</strong><span className={`status-dot s-${p.status}`}/></span>
          <span className="project-link-summary">{projectSummary(p)}</span>
          <span className="project-link-meta"><span>{badgeLabel(p)}</span><span>{modules.length ? tr("{p0}/{p1} 模块完成", { p0: completed, p1: modules.length }) : tr("整理目标与需求")}</span></span>
        </button>;
      }) : <p className="sidebar-empty">{tr("从一个目标开始")}<br />{tr("主管为每个项目设计团队。")}</p>}</nav>
      <div className="sidebar-bottom"><a className="nav-item" href={`/api/openapi.json?lang=${locale}`} target="_blank" rel="noreferrer"><Command size={16}/>{tr("接口文档")}<ArrowUpRight size={12}/></a><button className="nav-item" onClick={() => setSettingsOpen(true)}><SettingsIcon size={16}/>{tr("设置与模型")}<span className={`connection-dot ${health?.connected && health.authenticated ? 'connected' : ''}`}/></button><div className="local-note"><ShieldCheck size={14}/>{tr("本地工作空间")}</div></div>
    </aside>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label={tr("关闭项目列表")} onClick={() => setSidebarOpen(false)}/>}
    <main className="workspace-main">
      <header className="topbar"><div className="topbar-location"><button className="sidebar-toggle" aria-controls="project-navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(open => !open)}><Menu size={17}/>{tr("项目")}</button><div className="breadcrumb"><span>{tr("我的工作空间")}</span><ChevronRight size={13}/><strong>{project ? tr("项目工作区") : tr("全部项目")}</strong></div></div><div className="topbar-actions">
        <label className="language-switch" title={tr('新项目使用当前语言规划；已有内容保留原文。')}><span aria-hidden="true">文/A</span><select aria-label={tr('界面语言')} value={locale} onChange={e => setLocale(e.target.value === 'en' ? 'en' : 'zh-CN')}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
        <button className={`connection-label connection-${connection}`} onClick={() => connection === 'online' ? setSettingsOpen(true) : void reconnect()} title={connection === 'online' ? tr('设置与模型') : tr('重新连接')}><span className={`connection-dot ${connection === 'online' && health?.connected && health.authenticated ? 'connected' : ''}`}/>{connection === 'offline' ? tr('本地服务离线') : connection === 'reconnecting' ? tr('连接中断，自动重连') : connection === 'connecting' ? tr('正在连接本地服务') : health === null ? tr("正在连接 Codex") : health.connected && health.authenticated ? tr("Codex 已连接") : tr("连接需检查")}<ChevronDown size={12}/></button>
      </div></header>
      {!selectedId ? <div className="home-page">
        <div className="home-intro"><div className="eyebrow"><span />{tr("让想法有序发生")}</div><h1>{tr("从一个目标，")}<br /><span>{tr("到一份交付。")}</span></h1><p>{tr("和主管明确需求，让一支专属团队协作完成。")}</p></div>
        <div className="composer-card"><div className="composer-heading"><span className="avatar supervisor-avatar"><Sparkles size={17}/></span><span>{tr("告诉主管，你想完成什么")}</span><span className="auto-label">{tr("先确认需求")}</span></div><textarea aria-label={tr("项目目标")} value={goal} onChange={e => setGoal(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !busy)
            void create(); }} placeholder={tr("你想完成什么？可以说说目标、已有材料，以及希望得到的结果。")}/>
          {(files.length > 0 || directory || source) && <div className="input-chips">{directory && <span><Folder size={12}/>{directory.split('/').at(-1)}<button aria-label={tr("移除工作目录")} onClick={() => setDirectory('')}><X size={11}/></button></span>}{source && <span><MessageSquare size={12}/>{source.title.slice(0, 20)}<button aria-label={tr("移除导入聊天")} onClick={() => setSource(null)}><X size={11}/></button></span>}{files.map((f, i) => <span key={i}><File size={12}/>{f.name}<button aria-label={tr("移除 {p0}", { p0: f.name })} onClick={() => setFiles(old => old.filter((_, n) => n !== i))}><X size={11}/></button></span>)}</div>}
          <div className="composer-footer"><div className="input-actions"><button aria-label={tr("材料")} onClick={() => attachmentRef.current?.click()}><Paperclip size={17}/><span>{tr("材料")}</span></button><button aria-label={tr("工作目录")} onClick={() => setDirectoryOpen(true)}><Folder size={17}/><span>{tr("工作目录")}</span></button></div><button className="primary submit-goal" disabled={busy || goal.trim().length < 2} onClick={() => void create()}>{busy ? <Spinner /> : <ArrowUp size={16}/>}{tr("开始整理需求")}</button></div></div>
        <input hidden ref={attachmentRef} type="file" multiple onChange={e => { const list = [...(e.target.files || [])]; if (list.some(f => f.size > 10 * 1024 * 1024))
            setError(tr("单个附件不能超过 10 MB"));
        else
            setFiles(old => [...old, ...list]); e.target.value = ''; }}/>
        <div className="import-hint"><span>{tr("继续已有讨论")}</span><button onClick={() => setImportOpen(true)}><MessageSquare size={14}/>{tr("导入已有聊天")}<ArrowRight size={13}/></button></div>
        <div className="how-it-works"><div><FileText size={17}/><span>{tr("确认需求")}</span></div><ChevronRight size={15}/><div><Users size={17}/><span>{tr("主管组队")}</span></div><ChevronRight size={15}/><div><GitBranch size={17}/><span>{tr("模块协作")}</span></div><ChevronRight size={15}/><div><CheckCheck size={17}/><span>{tr("汇合交付")}</span></div></div>
        <div className="section-line recent-title"><h3>{tr("你的项目")}</h3><span>{tr("打开项目，继续上次的工作")}</span></div>
        {projects.length ? <div className="recent-projects">{projects.map(p => <button key={p.id} onClick={() => chooseProject(p.id)}><span className="project-folder"><Layers size={20}/></span><div><strong>{p.title}</strong><p className="recent-project-summary">{projectSummary(p)}</p><small>{visibleTasks(p).filter(t => t.status === 'completed').length} / {visibleTasks(p).length}{tr("个模块已完成 ·")}{p.workflowVersion === 2 ? (p.stage ? tr(stageLabels[p.stage]) : '') : tr("旧版项目")}</small></div><span className={`badge s-${p.status}`}>{badgeLabel(p)}</span><ArrowUpRight size={15}/></button>)}</div> : <p className="muted">{tr("项目会显示在左侧列表中，每个项目保留独立的页面和对话。")}</p>}
      </div> : project ? <section className="project-surface" id={`project-panel-${project.id}`} aria-label={project.title}>
        <nav className="project-subtabs" role="tablist" aria-label={tr("{p0}的页面", { p0: project.title })}>{views.map(v => <button key={v.id} id={`view-tab-${project.id}-${v.id}`} role="tab" aria-selected={view === v.id} aria-controls={`project-view-${project.id}`} onClick={() => setView(v.id)} className={view === v.id ? 'active' : ''}>{tr(v.label)}{v.id === 'roles' && <small>{roleColumns(project).length}</small>}</button>)}</nav>
        <div className="project-page"><div className="project-content">
        <div className="project-heading"><div><div className="project-eyebrow"><Layers size={13}/>{project.workflowVersion === 2 ? tr("项目档案") : tr("旧版项目")}<span>·</span>{supervisorName(project)}{tr("负责")}</div><h1>{project.title}</h1><p className="project-goal"><span>{tr("项目摘要")}</span>{projectSummary(project)}</p></div><div className="project-actions"><span className={`badge s-${project.status}`}><i />{badgeLabel(project)}</span>{isRunning ? <button className="secondary" disabled={busy} onClick={() => control('pause')}><Pause size={14}/>{tr("暂停")}</button> : project.status !== 'completed' && project.stage !== 'awaiting_confirmation' ? <button className="primary" disabled={busy} onClick={() => control('resume')}><Play size={14}/>{tr("继续")}</button> : null}</div></div>
        {project.stage && <div className="stage-track">{Object.entries(stageLabels).map(([stage, label], i) => <span key={stage} className={project.stage === stage ? 'active' : ''}><i>{i + 1}</i>{tr(label)}</span>)}</div>}
        {!!tasks.length && <div className="compact-progress"><div><span><CheckCircle2 size={14}/>{tr("完成模块")}</span><strong>{done}<small> / {tasks.length}</small></strong></div><div><span><Zap size={14}/>{tr("正在进行")}</span><strong>{running}<small> {unitLabel(running, 'modules')}</small></strong></div><div><span><FileText size={14}/>{tr("交付文件")}</span><strong>{currentArtifacts.length}<small> {unitLabel(currentArtifacts.length, 'files')}</small></strong></div></div>}
        {project.blocker && <div className="blocker"><AlertCircle size={17}/><span>{project.blocker}</span></div>}
        {needsConfirmation(project) && project.stage === 'awaiting_confirmation' && view !== 'requirements' && <button className="requirements-notice" onClick={() => setView('requirements')}><FileText size={14}/>{tr("需求等待确认，点击查看")}<ArrowRight size={14}/></button>}
        <div className="view-toolbar"><div><h2>{tr(views.find(v => v.id === view)?.label || '')}</h2><p>{tr(views.find(v => v.id === view)?.description || '')}</p></div>{view === 'plan' && <div className="view-tools"><button className="secondary" onClick={() => setPlanOpen(true)}><ArrowUp size={14}/>{tr("导入")}</button><button className="secondary" onClick={() => void act(project.id, async () => download(`${project.title}-plan.json`, await api(`/projects/${project.id}/plan`)))}><ArrowDownToLine size={14}/>{tr("导出")}</button></div>}</div>
        <div key={`${project.id}-${view}`} className={`view-content view-${view}`} role="tabpanel" id={`project-view-${project.id}`} aria-labelledby={`view-tab-${project.id}-${view}`}>
          {view === 'requirements' && <RequirementsView key={project.id} project={project} onError={setError} onUpdate={p => { setProject(p); if (p.stage === 'planning')
            updateWorkspace({ type: 'view', id: p.id, view: 'plan' }); }}/>}
          {view === 'plan' && <ExperimentPlanView key={project.id} project={project} onTask={onTask}/>}
          {view === 'flow' && <><div className="graph-caption"><span><span className="live-dot"/> {isRunning ? tr("模块实时同步") : tr("项目模块图")}</span><div><span><i className="legend-dot normal"/>{tr("执行模块")}</span><span><i className="legend-dot join"/>{tr("汇合模块")}</span></div></div><div className="flow-wrap"><Graph key={project.id} project={project} onSelect={onTask}/></div><div className="graph-footnote"><GitBranch size={13}/>{tr("上游全部验收后，汇合模块才能启动。")}</div></>}
          {view === 'board' && <TaskBoard project={project} onTask={onTask}/>}
          {view === 'roles' && <RoleBoard project={project} onTask={onTask} onMember={setEditingMember}/>}
          {view === 'overview' && <ActivityView project={project}/>}
          {view === 'artifacts' && <FilesView project={project} upload={<label className={`secondary upload-label ${!canAttach ? 'disabled' : ''}`} title={!canAttach ? tr(project.status === 'completed' ? '修订需求后可添加材料' : '暂停项目后可添加材料') : tr('添加参考材料')}><Paperclip size={14}/>{tr("添加材料")}<input hidden type="file" disabled={!canAttach || busy} onChange={e => { const file = e.target.files?.[0]; if (file)
            void act(project.id, async () => { await post(`/projects/${project.id}/attachments`, { name: file.name, base64: await fileBase64(file) }); }); e.target.value = ''; }}/></label>}/>}
        </div>
      </div><SupervisorPanel key={project.id} project={project} prompt={prompt} busy={busy} onDraft={text => updateWorkspace({ type: 'draft', id: project.id, text })} onSend={send} onTask={onTask} onRename={() => setSupervisorOpen(true)}/></div></section> : <div className="loading-page"><Spinner />{tr("正在打开项目…")}</div>}
    </main>
    {error && <div className="toast" role="alert"><AlertCircle size={17}/><span>{error}</span><button aria-label={tr("关闭通知")} onClick={() => setError('')}><X size={15}/></button></div>}
    {supervisorOpen && project && <SupervisorModal key={project.id} project={project} onClose={() => setSupervisorOpen(false)} onUpdate={setProject} onError={setError}/>}
    {settingsOpen && <SettingsModal health={health} onHealth={setHealth} onClose={() => setSettingsOpen(false)} onError={setError}/>}
    {directoryOpen && <DirectoryModal initial={directory} onSelect={path => { setDirectory(path); setDirectoryOpen(false); }} onClose={() => setDirectoryOpen(false)} onError={setError}/>}
    {importOpen && <ImportModal onClose={() => setImportOpen(false)} onError={setError} onSelect={thread => { setSource(thread); if (!goal)
        setGoal(tr("根据已有讨论继续推进项目：{p0}", { p0: thread.title })); setImportOpen(false); }}/>}
    {task && project && <TaskModal key={`${project.id}:${task.id}`} project={project} task={task} onClose={() => setSelectedTask(null)} onError={setError} onUpdate={setProject}/>}
    {editingMember && project && <MemberModal key={`${project.id}:${editingMember.id}`} member={editingMember} project={project} onClose={() => setEditingMember(null)} onError={setError} onUpdate={setProject}/>}
    {planOpen && project && <PlanModal project={project} onClose={() => setPlanOpen(false)} onError={setError} onUpdate={setProject}/>}
  </div>;
}
type ModalEvents = {
    onClose: () => void;
    onError: (message: string) => void;
};
function SupervisorModal({ project, onClose, onError, onUpdate }: ModalEvents & {
    project: Project;
    onUpdate: (p: Project) => void;
}) {
    const [name, setName] = useState(supervisorName(project)), [busy, setBusy] = useState(false);
    const save = async () => { setBusy(true); try {
        onUpdate(await api(`/projects/${project.id}/supervisor`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }));
        onClose();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <Modal title={tr("认识你的主管")} subtitle={tr("每个项目都有一位负责统筹的伙伴")} onClose={onClose}><div className="form"><div className="identity-card"><AgentAvatar name={name || tr("主管")} lead/><div><strong>{name || tr("项目主管")}</strong><span>{tr("项目主管")}</span></div></div><label>{tr("主管名字")}<input maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder={tr("给这位伙伴起个名字")}/></label><SectionCard title={tr("负责的工作")}><p>{tr("整理需求、设计团队与执行方案，跟进模块进度，并检查最终交付。")}</p></SectionCard><div className="modal-actions"><button className="secondary" onClick={onClose}>{tr("取消")}</button><button className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? <Spinner /> : <Check size={14}/>}{tr("保存名字")}</button></div></div></Modal>;
}
function SettingsModal({ health, onHealth, onClose, onError }: ModalEvents & {
    health: BackendHealth | null;
    onHealth: (h: BackendHealth) => void;
}) {
    const [settings, setSettings] = useState<Settings | null>(null), [busy, setBusy] = useState(false);
    useEffect(() => { api<Settings>('/settings').then(setSettings).catch(e => onError(e.message)); }, [onError]);
    const save = async () => { setBusy(true); try {
        const r = await api<{
            health: BackendHealth;
        }>('/settings', { method: 'PUT', body: JSON.stringify(settings) });
        onHealth(r.health);
        if (!r.health.connected || !r.health.authenticated)
            onError(r.health.message);
        else
            onClose();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <Modal title={tr("设置与模型")} subtitle={tr("配置本地执行器与自动推进方式")} onClose={onClose}>{settings ? <div className="form"><div className="provider-card"><span className="provider-icon"><Command size={22}/></span><div><strong>Codex</strong><small>{health?.version || tr("本地 App Server")}</small></div><span className={`badge ${health?.connected && health.authenticated ? 's-completed' : 's-blocked'}`}>{health?.connected && health.authenticated ? tr("已连接") : tr("待连接")}</span></div><label>{tr("Codex 可执行文件路径")}<input value={settings.codexPath} placeholder={tr("自动检测本机安装")} onChange={e => setSettings({ ...settings, codexPath: e.target.value })}/><small>{tr("可留空。路径异常时可指定桌面版附带的 Codex 程序。")}</small></label><label>{tr("默认模型")}<input list="models" value={settings.model} placeholder={tr("使用 Codex 配置的默认模型")} onChange={e => setSettings({ ...settings, model: e.target.value })}/><datalist id="models">{health?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist><small>{tr("用于新项目；已有团队可单独编辑成员模型。")}</small></label><div className="form-row"><label>{tr("并发成员数")}<input type="number" min={1} max={8} value={settings.concurrency} onChange={e => setSettings({ ...settings, concurrency: Number(e.target.value) })}/></label><label>{tr("自动返工次数")}<input type="number" min={0} max={5} value={settings.maxReworks} onChange={e => setSettings({ ...settings, maxReworks: Number(e.target.value) })}/></label><label>{tr("自动阶段上限")}<input type="number" min={1} max={30} value={settings.maxPhases} onChange={e => setSettings({ ...settings, maxPhases: Number(e.target.value) })}/></label></div><div className="info-box"><GitBranch size={16}/><p>{tr("并发成员数限制同时执行的模块。验收未通过时，主管会在返工次数范围内安排修正。")}</p></div><div className="modal-actions"><button className="secondary" onClick={onClose}>{tr("取消")}</button><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : <Check size={14}/>}{tr("保存并检查连接")}</button></div></div> : <div className="modal-loading"><Spinner /></div>}</Modal>;
}
function DirectoryModal({ initial, onSelect, onClose, onError }: ModalEvents & {
    initial: string;
    onSelect: (path: string) => void;
}) {
    const [listing, setListing] = useState<{
        path: string;
        parent: string;
        entries: {
            name: string;
            path: string;
        }[];
        git: boolean;
    } | null>(null), [path, setPath] = useState(initial), [busy, setBusy] = useState(false);
    const load = async (value: string) => { setBusy(true); try {
        const result = await api<NonNullable<typeof listing>>(`/directories?path=${encodeURIComponent(value)}`);
        setListing(result);
        setPath(result.path);
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    useEffect(() => { void load(initial); }, []);
    return <Modal title={tr("选择工作目录")} subtitle={tr("作为项目上下文；代码项目在独立工作区执行")} onClose={onClose}><div className="form"><div className="path-picker"><input aria-label={tr("目录路径")} value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter')
        void load(path); }}/><button className="secondary" onClick={() => void load(path)}>{tr("打开")}</button></div><div className="folder-list">{busy ? <Spinner /> : <>{listing && listing.path !== listing.parent && <button onClick={() => void load(listing.parent)}><ArrowLeft size={16}/>{tr("上一级")}</button>}{listing?.entries.map(d => <button key={d.path} onClick={() => void load(d.path)}><Folder size={17}/>{d.name}<ChevronRight size={13}/></button>)}</>}</div><div className="modal-actions"><span className="muted">{listing?.git ? tr("Git 仓库") : tr("普通文件夹")}</span><button className="primary" disabled={!listing || busy || path !== listing.path} onClick={() => listing && onSelect(listing.path)}>{tr("选择此目录")}</button></div></div></Modal>;
}
function ImportModal({ onSelect, onClose, onError }: ModalEvents & {
    onSelect: (thread: {
        id: string;
        title: string;
    }) => void;
}) {
    const [threads, setThreads] = useState<ThreadSummary[]>([]), [cursor, setCursor] = useState<string>(), [search, setSearch] = useState(''), [busy, setBusy] = useState(true);
    const [preview, setPreview] = useState<{
        id: string;
        title: string;
        transcript: string;
    } | null>(null);
    const load = async (next?: string) => { setBusy(true); try {
        const r = await api<{
            data: ThreadSummary[];
            nextCursor?: string;
        }>(`/codex/threads?search=${encodeURIComponent(search)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
        setThreads(old => next ? [...old, ...r.data] : r.data);
        setCursor(r.nextCursor);
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    useEffect(() => { void load(); }, []);
    return <Modal title={tr("从 Codex 导入")} subtitle={tr("选择本机聊天，提取目标并建立项目专属会话")} onClose={onClose} wide><div className="form">{preview ? <><button className="text-button" onClick={() => setPreview(null)}><ArrowLeft size={14}/>{tr("返回聊天列表")}</button><h3>{preview.title}</h3><pre className="import-preview">{preview.transcript || tr("这条聊天暂时没有可导入的文本内容。")}</pre><div className="modal-actions"><button className="primary" disabled={!preview.transcript} onClick={() => onSelect(preview)}>{tr("作为项目上下文")}<ArrowRight size={14}/></button></div></> : <><div className="path-picker"><input aria-label={tr("搜索 Codex 聊天")} value={search} onChange={e => setSearch(e.target.value)} placeholder={tr("搜索聊天标题…")} onKeyDown={e => { if (e.key === 'Enter')
        void load(); }}/><button className="secondary" onClick={() => void load()}><Search size={15}/></button></div><div className="thread-list">{threads.map(t => <button key={t.id} onClick={() => { setBusy(true); api<NonNullable<typeof preview>>(`/codex/threads/${t.id}`).then(setPreview).catch(e => onError(e.message)).finally(() => setBusy(false)); }}><MessageSquare size={17}/><div><strong>{t.title}</strong><small>{t.cwd || tr("本机聊天")}</small></div><ChevronRight size={14}/></button>)}{busy && <div className="modal-loading"><Spinner /></div>}{!busy && !threads.length && <p className="muted">{tr("没有找到本机可读取的聊天。")}</p>}</div>{cursor && <button className="secondary" disabled={busy} onClick={() => void load(cursor)}>{tr("加载更多")}</button>}</>}</div></Modal>;
}
function TaskModal({ project, task, onClose, onError, onUpdate }: ModalEvents & {
    project: Project;
    task: Task;
    onUpdate: (p: Project) => void;
}) {
    const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [tab, setTab] = useState<'detail' | 'runs'>('detail');
    const [memberId, setMemberId] = useState(task.memberId), [priority, setPriority] = useState(task.priority), [dependencies, setDependencies] = useState(task.dependencies);
    const act = async (fn: () => Promise<Project>) => { setBusy(true); try {
        onUpdate(await fn());
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const runs = project.runs.filter(r => r.taskId === task.id), member = project.members.find(m => m.id === task.memberId);
    const canRun = !needsConfirmation(project) && project.stage !== 'planning' && task.status !== 'superseded';
    const outputs = project.artifacts.filter(a => task.artifactIds.includes(a.id));
    return <Modal title={task.title} subtitle={`${member?.name || tr("待分配")} · ${member?.role || tr("团队成员")} · ${task.kind === 'join' ? tr("汇合模块") : tr("执行模块")}`} onClose={onClose} wide>
    <div className="task-modal-top"><Badge status={task.status}/><span>{tr("第")}{task.phase}{tr("阶段")}{task.reworks > 0 ? tr(" · 已返工 {p0} 次", { p0: task.reworks }) : ''}</span><button className="secondary" disabled={busy || !canRun} onClick={() => void act(() => post<Project>(`/projects/${project.id}/tasks/${task.id}/retry`, {}))}><RefreshCw size={14}/>{tr("重新执行")}</button></div>
    <div className="detail-tabs"><button className={tab === 'detail' ? 'active' : ''} onClick={() => setTab('detail')}>{tr("任务详情")}</button><button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>{tr("执行记录")}<span>{runs.length}</span></button></div>
    <div className="form task-detail-body">{tab === 'detail' ? <>
      <SectionCard title={tr("任务目标")}><p className="task-description">{task.description}</p></SectionCard>
      <TaskMethod task={task}/>
      {(task.summary || outputs.length > 0) && <SectionCard title={tr("执行结果")} className="result-card">{task.summary && <MessageText text={task.summary} project={project}/>}<div className="artifact-grid">{outputs.map(a => <ArtifactRow key={a.id} artifact={a} project={project}/>)}</div></SectionCard>}
      <SectionCard title={tr("验收标准")}><ul className="acceptance-list">{task.acceptance.map((text, i) => <li key={i}><ShieldCheck size={15}/><span>{text}</span></li>)}</ul></SectionCard>
      {task.feedback && <div className="blocker"><AlertCircle size={17}/><span>{task.feedback}</span></div>}
      <SectionCard title={tr("任务安排")} description={task.status === 'pending' ? tr("待执行模块可以调整负责人、优先级和依赖。") : tr("此模块已开始执行，安排保留供查看。")}>
        <div className="form-row"><label>{tr("负责人")}<select value={memberId} disabled={task.status !== 'pending'} onChange={e => setMemberId(e.target.value)}>{project.members.map(m => <option value={m.id} key={m.id}>{m.name} · {m.role}</option>)}</select></label><label>{tr("优先级（0–10）")}<input type="number" min={0} max={10} step={1} value={priority} disabled={task.status !== 'pending'} onChange={e => setPriority(Number(e.target.value))}/><small>{tr("数字越大越优先，10 为最高。")}</small></label></div>
        <label className="field-title">{tr("前置模块")}</label><div className="dependency-list">{project.tasks.filter(t => t.id !== task.id && t.status !== 'superseded').map(t => <label key={t.id}><input type="checkbox" checked={dependencies.includes(t.id)} disabled={task.status !== 'pending'} onChange={e => setDependencies(old => e.target.checked ? [...old, t.id] : old.filter(id => id !== t.id))}/><span>{t.title}</span></label>)}{project.tasks.length < 2 && <span className="muted">{tr("可独立执行")}</span>}</div>
        {task.status === 'pending' && <button className="secondary" disabled={busy || !Number.isInteger(priority) || priority < 0 || priority > 10} onClick={() => void act(() => api(`/projects/${project.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ memberId, priority, dependencies }) }))}>{tr("保存安排")}</button>}
      </SectionCard>
      <details className="technical-details"><summary>{tr("模块信息")}</summary><p>{tr("模块编号：")}{task.id}</p>{task.workspace && <code>{task.workspace}</code>}</details>
    </> : <div className="task-runs">{runs.length ? [...runs].reverse().map(r => <details key={r.id} className="run-details"><summary><span className={`status-dot s-${r.status}`}/><span>{r.purpose === 'review' ? tr("{p0}验收", { p0: supervisorName(project) }) : tr("{p0}执行", { p0: member?.name || tr("成员") })}<small>{time(r.startedAt)}</small></span><span className={`badge s-${r.status}`}>{tr(runStatusLabels[r.status])}</span></summary><pre>{r.error || r.log || tr("等待输出…")}</pre>{project.artifacts.filter(a => a.runId === r.id).map(a => <ArtifactRow key={a.id} artifact={a} project={project}/>)}<div className="run-session">{tr("会话编号：")}{r.sessionId}</div></details>) : <div className="empty-state"><FileText size={28}/><h3>{tr("尚未开始执行")}</h3><p>{tr("开始后可在这里查看操作记录与输出。")}</p></div>}</div>}
      <SectionCard title={tr("继续这个模块")} description={tr("补充要求后，将重新执行并验收相关模块。")} className="task-prompt"><label className="sr-only" htmlFor="module-prompt">{tr("补充模块要求")}</label><textarea id="module-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={tr("你希望调整或补充什么？")}/><div className="module-prompt-action"><button className="primary" disabled={busy || !prompt.trim() || !canRun} onClick={() => void act(async () => { const p = await post<Project>(`/projects/${project.id}/messages`, { content: prompt, taskId: task.id }); setPrompt(''); return p; })}>{busy ? <Spinner /> : <ArrowUp size={15}/>}{tr("提交补充")}</button></div></SectionCard>
    </div>
  </Modal>;
}
function MemberModal({ member, project, onClose, onError, onUpdate }: ModalEvents & {
    member: Member;
    project: Project;
    onUpdate: (p: Project) => void;
}) {
    const [value, setValue] = useState(member), [busy, setBusy] = useState(false);
    const save = async () => { setBusy(true); try {
        const { name, role, instructions, model } = value;
        onUpdate(await api(`/projects/${project.id}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ name, role, instructions, model: model || '' }) }));
        onClose();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <Modal title={tr("编辑团队成员")} subtitle={tr("名字用于识别成员，角色说明其负责的工作")} onClose={onClose}><div className="form"><div className="form-row"><label>{tr("名字")}<input maxLength={100} value={value.name} onChange={e => setValue({ ...value, name: e.target.value })}/></label><label>{tr("角色")}<input maxLength={200} value={value.role} onChange={e => setValue({ ...value, role: e.target.value })}/></label></div><label>{tr("职责与工作方式")}<textarea rows={6} value={value.instructions} onChange={e => setValue({ ...value, instructions: e.target.value })}/></label><label>{tr("模型")}<input value={value.model || ''} placeholder={tr("使用项目默认模型")} onChange={e => setValue({ ...value, model: e.target.value })}/></label><div className="modal-actions"><button className="secondary" onClick={onClose}>{tr("取消")}</button><button className="primary" disabled={busy || !value.name.trim() || !value.role.trim()} onClick={() => void save()}>{busy ? <Spinner /> : <Check size={14}/>}{tr("保存")}</button></div></div></Modal>;
}
function PlanModal({ project, onClose, onError, onUpdate }: ModalEvents & {
    project: Project;
    onUpdate: (p: Project) => void;
}) {
    const [value, setValue] = useState(''), [busy, setBusy] = useState(false);
    const running = ['running', 'planning'].includes(project.status) || needsConfirmation(project);
    return <Modal title={tr("导入计划 JSON")} subtitle={tr("使用导出的计划结构，或让 Codex 按 API 契约生成")} onClose={onClose} wide><div className="form"><label className="secondary upload-label"><FileText size={14}/>{tr("选择 JSON 文件")}<input hidden type="file" accept=".json,application/json" onChange={e => { const f = e.target.files?.[0]; if (f)
        f.text().then(setValue).catch(e => onError(e.message)); }}/></label><textarea rows={13} className="code-input" aria-label={tr("计划 JSON")} value={value} onChange={e => setValue(e.target.value)} placeholder='{"title":"…","summary":"…","question":null,"members":[],"tasks":[]}'/>{running && <div className="info-box"><Pause size={15}/><p>{tr("请先确认需求，并暂停项目后再应用新计划。")}</p></div>}<div className="modal-actions"><button className="primary" disabled={running || busy || !value.trim()} onClick={() => { setBusy(true); Promise.resolve().then(() => { let plan: unknown; try { plan = JSON.parse(value); } catch { throw new Error(tr('计划 JSON 格式不正确，请检查引号、逗号与括号。')); } return api<Project>(`/projects/${project.id}/plan`, { method: 'PUT', body: JSON.stringify(plan) }); }).then(p => { onUpdate(p); onClose(); }).catch(e => onError(e.message)).finally(() => setBusy(false)); }}>{busy ? <Spinner /> : <Check size={14}/>}{tr("应用计划")}</button></div></div></Modal>;
}
