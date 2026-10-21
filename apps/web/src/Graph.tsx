import { t as tr, useLocale } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, type Node, type NodeProps, type Edge, type Viewport } from '@xyflow/react';
import { Check, Circle, GitMerge, LoaderCircle, AlertCircle, ArrowUpRight, Network } from 'lucide-react';
import type { Project, Task } from '../../../shared/types';
import { statusLabels } from '../../../shared/types';
import { needsConfirmation } from '../../../shared/workflow';
export const colors = ['#a276c5', '#557ec2', '#55a28d', '#c99047', '#bf7388', '#6c91a4'];
export function memberColor(id: string) { return colors[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]; }
type TaskData = {
    task: Task;
    memberName: string;
    memberRole: string;
    ready: boolean;
    open: (id: string) => void;
};
function TaskNode({ data, selected }: NodeProps<Node<TaskData>>) {
    const { task, memberName, ready } = data;
    const active = task.status === 'running' || task.status === 'reviewing';
    return <button className={`flow-node ${task.kind === 'join' ? 'join-node' : ''} ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`} onClick={() => data.open(task.id)} aria-label={tr("查看任务：{p0}", { p0: task.title })}>
    <Handle type="target" position={Position.Left}/><Handle type="source" position={Position.Right}/>
    <div className="node-top"><span className={`node-kind ${task.kind}`}>{task.kind === 'join' ? <GitMerge size={14}/> : <Circle size={13}/>} {task.kind === 'join' ? tr("汇合 · 验收") : tr("执行模块")}</span><ArrowUpRight size={13}/></div>
    <strong>{task.title}</strong><p>{task.description}</p>
    <div className="node-bottom"><span className="node-owner"><span className="avatar tiny" style={{ background: memberColor(task.memberId) }}>{memberName.slice(0, 1)}</span>{memberName}</span><span className={`node-status s-${task.status}`}>{active ? <LoaderCircle className="spin" size={12}/> : task.status === 'completed' ? <Check size={13}/> : task.status === 'blocked' ? <AlertCircle size={12}/> : null}{ready ? tr("可执行") : tr(statusLabels[task.status])}</span></div>
  </button>;
}
const nodeTypes = { task: TaskNode };
// A wider project sidebar changes the usable canvas even at the same window size.
const viewportLayoutVersion = 2;
export function Graph({ project, onSelect }: {
    project: Project;
    onSelect: (id: string) => void;
}) {
    const locale = useLocale();
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<TaskData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const positions = useRef<Record<string, {
        x: number;
        y: number;
    }>>({});
    const [viewport] = useState<Viewport | undefined>(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(`heliu-viewport-${project.id}`) || 'null');
            if (saved && saved.layoutVersion === viewportLayoutVersion && saved.windowWidth === window.innerWidth && saved.windowHeight === window.innerHeight && [saved.x, saved.y, saved.zoom].every(Number.isFinite) && saved.zoom >= 0.25 && saved.zoom <= 1.5)
                return saved;
        }
        catch { /* Ignore damaged or unavailable view storage. */ }
    });
    useEffect(() => { try {
        positions.current = JSON.parse(localStorage.getItem(`heliu-layout-${project.id}`) || '{}');
    }
    catch {
        positions.current = {};
    } }, [project.id]);
    useEffect(() => {
        const tasks = project.tasks.filter(t => t.status !== 'superseded'), byId = new Map(tasks.map(t => [t.id, t]));
        const levels = new Map<string, number>();
        const depth = (id: string, seen = new Set<string>()): number => {
            if (levels.has(id))
                return levels.get(id)!;
            if (seen.has(id))
                return 0;
            seen.add(id);
            const deps = byId.get(id)?.dependencies.filter(d => byId.has(d)) || [];
            const d = deps.length ? 1 + Math.max(...deps.map(x => depth(x, new Set(seen)))) : 0;
            levels.set(id, d);
            return d;
        };
        tasks.forEach(t => depth(t.id));
        const groups = new Map<number, Task[]>();
        tasks.forEach(t => { const d = levels.get(t.id)!; groups.set(d, [...(groups.get(d) || []), t]); });
        const maxRows = Math.max(1, ...[...groups.values()].map(g => g.length));
        setNodes(tasks.map(t => {
            const level = levels.get(t.id)!, group = groups.get(level)!, index = group.indexOf(t), member = project.members.find(m => m.id === t.memberId);
            return { id: t.id, type: 'task', position: positions.current[t.id] || { x: level * 300 + 30, y: index * 182 + (maxRows - group.length) * 91 + 30 }, data: { task: t, memberName: member?.name || tr("待分配"), memberRole: member?.role || '', ready: !needsConfirmation(project) && project.status === 'running' && t.status === 'pending' && t.dependencies.every(d => byId.get(d)?.status === 'completed'), open: onSelect } };
        }));
        setEdges(tasks.flatMap(t => t.dependencies.filter(d => byId.has(d)).map(dep => ({ id: `${dep}->${t.id}`, source: dep, target: t.id, type: 'smoothstep', animated: t.status === 'running', style: { stroke: byId.get(dep)?.status === 'completed' ? '#9ab8a5' : '#cbd1d9', strokeWidth: 1.5 } }))));
    }, [project.id, project.version, locale, onSelect, setNodes, setEdges]);
    const savePosition = useCallback((_event: unknown, node: Node) => {
        positions.current[node.id] = node.position;
        try {
            localStorage.setItem(`heliu-layout-${project.id}`, JSON.stringify(positions.current));
        }
        catch { /* View storage is optional. */ }
    }, [project.id]);
    const saveViewport = useCallback((_event: unknown, value: Viewport) => {
        try {
            localStorage.setItem(`heliu-viewport-${project.id}`, JSON.stringify({ ...value, layoutVersion: viewportLayoutVersion, windowWidth: window.innerWidth, windowHeight: window.innerHeight }));
        }
        catch { /* View storage is optional. */ }
    }, [project.id]);
    if (!project.tasks.filter(t => t.status !== 'superseded').length)
        return <div className="graph-empty"><div className="empty-orbit"><Network size={30}/></div><h3>{needsConfirmation(project) ? tr("确认需求后生成模块图") : project.status === 'planning' ? tr("主管正在设计工作流程") : tr("流程将在这里展开")}</h3><p>{needsConfirmation(project) ? tr("先确认项目需求，主管再设计团队与模块。") : tr("角色、模块与依赖关系会在规划完成后自动呈现。")}</p>{project.status === 'planning' && <span className="thinking"><i /><i /><i /></span>}</div>;
    return <ReactFlow key={project.id} ariaLabelConfig={{ 'controls.ariaLabel': tr("视图操作"), 'controls.zoomIn.ariaLabel': tr("放大"), 'controls.zoomOut.ariaLabel': tr("缩小"), 'controls.fitView.ariaLabel': tr("适应画布") }} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={savePosition} onMoveEnd={saveViewport} defaultViewport={viewport} nodesConnectable={false} edgesFocusable={false} zoomOnScroll={false} panOnScroll={false} preventScrolling={false} fitView={!viewport} fitViewOptions={{ padding: 0.18, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5} proOptions={{ hideAttribution: true }}><Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#dce1e7"/><Controls showInteractive={false}/></ReactFlow>;
}
