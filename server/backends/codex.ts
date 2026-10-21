import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, SessionOptions, TurnOptions } from './backend.ts';
import type { BackendHealth } from '../../shared/types.ts';
import type { Store } from '../store.ts';
const exec = promisify(execFile);
const aborted = () => Object.assign(new Error('运行已中断'), { name: 'AbortError' });
interface LiveTurn { turnId?: string; sessionId: string; text: string; final: string; onEvent: TurnOptions['onEvent']; resolve: (s: string) => void; reject: (e: Error) => void; aborted: boolean }
export class CodexBackend implements AgentBackend {
  id = 'codex'; capabilities = { execution: true, history: true, resume: true };
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private requests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private live = new Map<string, LiveTurn>();
  private loaded = new Set<string>();
  private sequence = 0;
  private version = '';
  constructor(private store: Store) {}
  private async binary() {
    const configured = this.store.settings().codexPath || process.env.CODEX_BIN;
    const candidates = configured ? [configured] : ['codex', join(homedir(), '.codex/plugins/.plugin-appserver/codex-cli/bin/codex'), '/Applications/ChatGPT.app/Contents/Resources/codex'];
    for (const path of candidates) {
      try { const r = await exec(path, ['--version'], { timeout: 7000 }); this.version = r.stdout.trim(); return path; } catch { /* Try the next installed distribution. */ }
    }
    throw new Error('找不到可用的 Codex。请在设置中填写 Codex 可执行文件路径。');
  }
  private async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const path = await this.binary();
      const child = spawn(path, ['app-server', '--listen', 'stdio://'], { stdio: 'pipe', env: process.env });
      this.child = child;
      child.stderr.on('data', () => {});
      child.on('error', e => { if (this.child === child) this.disconnected(e); });
      child.on('exit', () => { if (this.child === child) this.disconnected(new Error('Codex 连接已结束，请检查连接后继续。')); });
      createInterface({ input: child.stdout }).on('line', line => {
        try { this.receive(JSON.parse(line)); } catch { /* Non-protocol diagnostics are not user output. */ }
      });
      await this.rpc('initialize', { clientInfo: { name: 'heliu_workbench', title: '合流项目工作台', version: '0.1.0' }, capabilities: { experimentalApi: false } });
      this.send({ method: 'initialized' });
    })().catch(e => { this.starting = undefined; this.child?.kill(); throw e; });
    return this.starting;
  }
  private disconnected(error: Error) {
    this.starting = undefined; this.loaded.clear();
    for (const req of this.requests.values()) { clearTimeout(req.timer); req.reject(error); }
    this.requests.clear();
    for (const turn of this.live.values()) turn.reject(error);
    this.live.clear();
  }
  private send(message: unknown) {
    if (!this.child?.stdin.writable) throw new Error('Codex 尚未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private rpc(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`Codex ${method} 请求超时`)); }, 45000);
      this.requests.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.requests.delete(id); reject(e); }
    });
  }
  private receive(message: any) {
    if (message.id !== undefined && !message.method) {
      const req = this.requests.get(message.id); if (!req) return;
      clearTimeout(req.timer); this.requests.delete(message.id);
      if (message.error) req.reject(new Error(message.error.message || 'Codex 请求失败')); else req.resolve(message.result);
      return;
    }
    const p = message.params || {};
    const turn = this.live.get(p.threadId);
    if (message.id !== undefined && message.method) {
      turn?.onEvent({ type: 'status', text: '执行器请求额外权限或信息，当前请求未获自动授权。' });
      if (/commandExecution\/requestApproval|fileChange\/requestApproval/.test(message.method)) this.send({ id: message.id, result: { decision: 'decline' } });
      else this.send({ id: message.id, error: { code: -32000, message: '此能力需要用户输入。请停止相关操作并在最终结果 needsInput 字段说明。' } });
      return;
    }
    if (!turn) return;
    if (p.turnId && turn.turnId && p.turnId !== turn.turnId) return;
    if (message.method === 'turn/started') {
      turn.turnId = p.turn.id;
      const saved = this.store.session(turn.sessionId, this.id);
      this.store.saveSession(turn.sessionId, this.id, { ...saved, lastTurnId: p.turn.id });
    }
    if (message.method === 'item/agentMessage/delta') {
      turn.text += p.delta || ''; turn.onEvent({ type: 'text', text: p.delta || '' });
    }
    if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(p.item?.type)) {
      turn.onEvent({ type: 'tool', text: p.item.command || p.item.tool || p.item.type });
    }
    if (message.method === 'item/completed' && p.item?.type === 'commandExecution') {
      turn.onEvent({ type: 'tool', text: `退出码 ${p.item.exitCode ?? '?'}\n${(p.item.aggregatedOutput || '').slice(-16000)}` });
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      turn.final = p.item.text || turn.final;
    }
    if (message.method === 'turn/completed') {
      if (turn.turnId && p.turn.id !== turn.turnId) return;
      const finalItem = p.turn.items?.filter((i: any) => i.type === 'agentMessage').at(-1);
      const saved = this.store.session(turn.sessionId, this.id);
      this.store.saveSession(turn.sessionId, this.id, { ...saved, lastTurnId: p.turn.id, lastStatus: p.turn.status, uncertain: false });
      if (turn.aborted || p.turn.status === 'interrupted') turn.reject(aborted());
      else if (p.turn.status !== 'completed') turn.reject(new Error(p.turn.error?.message || `Codex 执行失败：${p.turn.status}`));
      else turn.resolve(finalItem?.text || turn.final || turn.text);
    }
  }
  async health(): Promise<BackendHealth> {
    try {
      await this.start();
      const [account, models] = await Promise.all([this.rpc('account/read', {}), this.rpc('model/list', {})]);
      const authenticated = !!account.account || account.requiresOpenaiAuth === false;
      return { id: this.id, connected: true, authenticated, version: this.version, message: authenticated ? 'Codex 已连接，可以开始工作' : '请先在终端运行 codex login', models: (models.data || []).map((m: any) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, isDefault: m.isDefault })) };
    } catch (e) { return { id: this.id, connected: false, authenticated: false, version: this.version, message: (e as Error).message, models: [] }; }
  }
  async createSession(options: SessionOptions) {
    await this.start();
    const result = await this.rpc('thread/start', {
      cwd: options.cwd, ...(options.model ? { model: options.model } : {}),
      developerInstructions: options.instructions, approvalPolicy: 'never',
      sandbox: options.readOnly ? 'read-only' : 'workspace-write',
      serviceName: 'heliu',
    });
    const id = randomUUID();
    this.store.saveSession(id, this.id, { threadId: result.thread.id, options }); this.loaded.add(result.thread.id);
    return id;
  }
  async resume(sessionId: string) {
    await this.start(); const saved = this.store.session(sessionId, this.id);
    if (saved.uncertain) {
      const state = await this.inspect(sessionId);
      if (state.state !== 'idle') throw new Error('上次运行状态尚未确认，请稍后检查连接，避免重复执行。');
    }
    if (!this.loaded.has(saved.threadId)) {
      await this.rpc('thread/resume', { threadId: saved.threadId, excludeTurns: true }); this.loaded.add(saved.threadId);
    }
  }
  async runTurn(options: TurnOptions) {
    if (options.signal.aborted) throw aborted();
    await this.resume(options.sessionId);
    if (options.signal.aborted) throw aborted();
    const saved = this.store.session(options.sessionId, this.id), threadId = saved.threadId;
    if (this.live.has(threadId)) throw new Error('同一会话已有运行中的任务');
    let resolve!: (v: string) => void, reject!: (e: Error) => void;
    const done = new Promise<string>((r, j) => { resolve = r; reject = j; });
    // Attach a rejection handler before the start RPC, because the server may emit completion first.
    void done.catch(() => {});
    const turn: LiveTurn = { sessionId: options.sessionId, text: '', final: '', onEvent: options.onEvent, resolve, reject, aborted: false };
    this.live.set(threadId, turn);
    let abortTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      turn.aborted = true;
      void this.interrupt(options.sessionId).catch(() => {});
      abortTimer = setTimeout(() => {
        const latest = this.store.session(options.sessionId, this.id);
        this.store.saveSession(options.sessionId, this.id, { ...latest, uncertain: true }); reject(aborted());
      }, 15000);
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 20 * 60 * 1000);
    try {
      const result = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text: options.prompt }], outputSchema: options.outputSchema, ...(options.model ? { model: options.model } : {}) });
      turn.turnId = result.turn.id;
      if (turn.aborted) void this.interrupt(options.sessionId).catch(() => {});
      return await done;
    } finally {
      clearTimeout(timeout); clearTimeout(abortTimer); options.signal.removeEventListener('abort', cancel); this.live.delete(threadId);
    }
  }
  async interrupt(sessionId: string) {
    const saved = this.store.session(sessionId, this.id), turn = this.live.get(saved.threadId);
    if (turn?.turnId) await this.rpc('turn/interrupt', { threadId: saved.threadId, turnId: turn.turnId });
  }
  async inspect(sessionId: string): Promise<{ state: 'active' | 'idle' | 'unknown'; completed: boolean }> {
    try {
      await this.start(); const saved = this.store.session(sessionId, this.id);
      const result = await this.rpc('thread/read', { threadId: saved.threadId });
      const status = result.thread.status?.type;
      return { state: status === 'active' ? 'active' : ['idle', 'notLoaded'].includes(status) ? 'idle' : 'unknown', completed: saved.lastStatus === 'completed' };
    } catch { return { state: 'unknown', completed: false }; }
  }
  async listThreads(cursor?: string, search?: string) {
    await this.start();
    const r = await this.rpc('thread/list', { limit: 30, sortKey: 'updated_at', useStateDbOnly: true, ...(cursor ? { cursor } : {}), ...(search ? { searchTerm: search } : {}) });
    return { data: (r.data || []).map((t: any) => ({ id: t.id, title: t.name || t.preview || '未命名聊天', cwd: t.cwd, updatedAt: t.updatedAt })), nextCursor: r.nextCursor || undefined };
  }
  async readThread(id: string) {
    await this.start(); const meta = await this.rpc('thread/read', { threadId: id });
    const chunks: string[] = []; let cursor: string | undefined; let count = 0;
    do {
      const page = await this.rpc('thread/turns/list', { threadId: id, limit: 30, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
      for (const turn of page.data || []) {
        const text = (turn.items || []).filter((i: any) => ['userMessage', 'agentMessage'].includes(i.type)).map((i: any) => `${i.type === 'userMessage' ? '用户' : '助手'}：${i.text || (i.content || []).map((c: any) => c.text || '').join('\n')}`).join('\n');
        chunks.unshift(text); count += text.length;
      }
      cursor = page.nextCursor || undefined;
    } while (cursor && count < 60000);
    return { id, title: meta.thread.name || meta.thread.preview || '导入聊天', transcript: (cursor ? '[较早历史已省略；以下为最近对话]\n' : '') + chunks.join('\n\n').slice(-80000) };
  }
  async close() {
    const child = this.child; this.child = undefined;
    this.disconnected(new Error('执行服务已停止'));
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
}
