import { mkdir, realpath, stat, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Artifact, Project, Task, TaskResult } from '../shared/types.ts';
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  return (await exec('git', ['-c', 'user.name=Heliu Agent', '-c', 'user.email=heliu@localhost', ...args], { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
export function inside(root: string, file: string) { const rel = relative(root, file); return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); }
export async function verifiedFile(root: string, file: string) {
  const actualRoot = await realpath(root), actual = await realpath(resolve(root, file));
  if (!inside(actualRoot, actual)) throw new Error('产出文件必须位于任务工作目录内');
  const info = await stat(actual); if (!info.isFile()) throw new Error('交付物必须是文件');
  return { path: actual, size: info.size };
}
export class Workspaces {
  constructor(public root: string) {}
  async project(id: string) { const path = join(this.root, 'projects', id); await mkdir(join(path, 'supervisor'), { recursive: true }); return path; }
  async setupGit(p: Project) {
    if (p.template !== 'development') return {};
    let repoPath = p.repoPath;
    if (!repoPath && p.contextPath) {
      try { repoPath = await git(p.contextPath, ['rev-parse', '--show-toplevel']); } catch { /* A reference folder need not be a Git repository. */ }
    }
    if (!repoPath) {
      repoPath = join(p.workspace, 'source'); await mkdir(repoPath, { recursive: true });
      try { await access(join(repoPath, '.git')); } catch { await git(repoPath, ['init', '-b', 'main']); await git(repoPath, ['commit', '--allow-empty', '-m', 'Initialize project workspace']); }
    }
    if (p.integrationPath) return { repoPath, integrationPath: p.integrationPath, integrationBranch: p.integrationBranch };
    await git(repoPath, ['rev-parse', '--verify', 'HEAD']);
    if (await git(repoPath, ['status', '--porcelain'])) throw new Error('代码目录有未提交修改。请先提交或保存，再继续项目；任务工作区从当前提交创建。');
    const integrationBranch = `codex/heliu-${p.id.slice(0, 8)}`, integrationPath = join(p.workspace, 'integration');
    try { await access(join(integrationPath, '.git')); }
    catch { await git(repoPath, ['worktree', 'add', '-b', integrationBranch, integrationPath, 'HEAD']); }
    return { repoPath, integrationPath, integrationBranch };
  }
  async task(p: Project, task: Task): Promise<{ path: string; mergeNote: string }> {
    if (p.template !== 'development' || !p.integrationPath || !p.repoPath) {
      const path = join(p.workspace, 'tasks', task.id); await mkdir(path, { recursive: true }); return { path, mergeNote: '' };
    }
    const path = task.kind === 'join' ? p.integrationPath : join(p.workspace, 'tasks', task.id);
    if (task.kind !== 'join') {
      try { await access(join(path, '.git')); }
      catch { await git(p.repoPath, ['worktree', 'add', '-b', `codex/heliu-${p.id.slice(0, 8)}-${task.id}`, path, p.integrationBranch!]); }
    }
    const notes: string[] = [];
    for (const dep of task.dependencies) {
      const commit = p.tasks.find(t => t.id === dep)?.commit;
      if (commit) {
        try { await git(path, ['merge', '--no-edit', commit]); }
        catch (e) {
          const conflicted = await git(path, ['diff', '--name-only', '--diff-filter=U']);
          if (!conflicted && !(await git(path, ['status', '--porcelain']))) throw e;
          notes.push(`需要处理保留的工作区修改或合并冲突（上游 ${dep}）：${conflicted || '存在未提交的修改'}。保留有效工作，完成后 git add 并提交，再依次合并所有上游提交。`);
          break;
        }
      }
    }
    return { path, mergeNote: notes.join('\n') };
  }
  async commit(p: Project, task: Task, path: string) {
    if (p.template !== 'development' || !p.repoPath) return undefined;
    if (await git(path, ['diff', '--name-only', '--diff-filter=U'])) throw new Error('任务仍有未解决的 Git 合并冲突');
    let merge = false; try { await git(path, ['rev-parse', '--verify', 'MERGE_HEAD']); merge = true; } catch {}
    if ((await git(path, ['status', '--porcelain'])) || merge) {
      await git(path, ['add', '-A']); await git(path, ['commit', '-m', `Heliu: ${task.title}`]);
    }
    return git(path, ['rev-parse', 'HEAD']);
  }
  async capture(p: Project, task: Task, runId: string, path: string, result: TaskResult): Promise<Artifact[]> {
    if (!result.artifacts.length) throw new Error('任务没有提供可验收的实际产出文件');
    const dest = join(p.workspace, 'artifacts', runId); await mkdir(dest, { recursive: true });
    const records: Artifact[] = [];
    for (const [index, file] of result.artifacts.entries()) {
      const source = await verifiedFile(path, file.path);
      if (source.size > 50 * 1024 * 1024) throw new Error('单个产出文件超过 50 MB');
      const target = join(dest, `${index}-${basename(source.path)}`); await copyFile(source.path, target);
      records.push({ id: randomUUID(), projectId: p.id, taskId: task.id, runId, name: file.label || basename(source.path), path: target, bytes: source.size, sha256: createHash('sha256').update(await readFile(target)).digest('hex'), createdAt: new Date().toISOString(), kind: 'output' });
    }
    return records;
  }
  async input(p: Project, name: string, content: Buffer): Promise<Artifact> {
    if (content.byteLength > 10 * 1024 * 1024) throw new Error('附件不能超过 10 MB');
    const id = randomUUID(), dir = join(p.workspace, 'inputs'); await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}-${basename(name).replace(/[^\p{L}\p{N}._-]/gu, '_')}`); await writeFile(file, content);
    return { id, projectId: p.id, name: basename(name), path: file, bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex'), createdAt: new Date().toISOString(), kind: 'input' };
  }
}
