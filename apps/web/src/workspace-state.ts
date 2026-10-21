export const views = [
  { id: 'requirements', label: '需求', description: '明确目标与交付标准，确认后开始规划。' }, { id: 'plan', label: '实验计划', description: '查看执行方法、团队分工与模块依赖。' }, { id: 'flow', label: '模块图', description: '沿着依赖关系，跟进并行任务与结果汇合。' },
  { id: 'board', label: '任务看板', description: '从准备到交付，所有模块共用一份执行状态。' }, { id: 'roles', label: '角色看板', description: '每种角色一列，清楚看到谁在做什么。' }, { id: 'artifacts', label: '交付物', description: '已验收的成果与项目参考材料。' }, { id: 'overview', label: '项目动态', description: '查看项目总结、版本变化与执行记录。' },
] as const;
export type View = typeof views[number]['id'];
export interface WorkspaceState { activeId: string | null; views: Record<string, View>; drafts: Record<string, string> }
export type WorkspaceAction =
  | { type: 'open'; id: string | null }
  | { type: 'view'; id: string; view: View } | { type: 'draft'; id: string; text: string }
  | { type: 'reconcile'; ids: string[] };
export const emptyWorkspace = (): WorkspaceState => ({ activeId: null, views: {}, drafts: {} });
export function restoreWorkspace(raw: string | null, urlId: string | null): WorkspaceState {
  let state = emptyWorkspace();
  try {
    const parsed = JSON.parse(raw || '{}');
    // Read old tab-based caches without changing project-specific pages or drafts.
    for (const [id, view] of Object.entries(parsed.views || {})) if (views.some(v => v.id === view)) state.views[id] = view as View;
    for (const [id, draft] of Object.entries(parsed.drafts || {})) if (typeof draft === 'string') state.drafts[id] = draft;
  } catch { /* A damaged UI cache never changes server projects. */ }
  if (urlId) state = workspaceReducer(state, { type: 'open', id: urlId });
  return state;
}
export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'open': return { ...state, activeId: action.id };
    case 'view': return { ...state, views: { ...state.views, [action.id]: action.view } };
    case 'draft': return { ...state, drafts: { ...state.drafts, [action.id]: action.text } };
    case 'reconcile': {
      return { ...state, activeId: state.activeId && action.ids.includes(state.activeId) ? state.activeId : null };
    }
  }
}
