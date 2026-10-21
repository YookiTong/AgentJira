import type { BackendEvent, BackendHealth, ThreadSummary } from '../../shared/types.ts';
export interface SessionOptions { cwd: string; instructions: string; readOnly: boolean; model?: string }
export interface TurnOptions { sessionId: string; prompt: string; outputSchema: unknown; model?: string; signal: AbortSignal; onEvent: (event: BackendEvent) => void }
export interface AgentBackend {
  id: string;
  capabilities: { execution: boolean; history: boolean; resume: boolean };
  health(): Promise<BackendHealth>;
  createSession(options: SessionOptions): Promise<string>;
  runTurn(options: TurnOptions): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  listThreads?(cursor?: string, search?: string): Promise<{ data: ThreadSummary[]; nextCursor?: string }>;
  readThread?(id: string): Promise<{ id: string; title: string; transcript: string }>;
  inspect?(sessionId: string): Promise<{ state: 'active' | 'idle' | 'unknown'; completed: boolean }>;
  close(): Promise<void>;
}
