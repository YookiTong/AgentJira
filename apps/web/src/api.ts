import { getLocale, t } from './i18n';
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch('/api' + path, { ...options, headers: { 'Accept-Language': getLocale(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
  catch { throw new Error(t('无法连接本地服务，请检查服务是否运行。')); }
  let value: any;
  try { value = await response.json(); } catch { throw new Error(t('服务器返回了无法读取的响应。')); }
  if (!response.ok) throw new Error(value.error || t('请求失败 ({p0})', { p0: response.status }));
  return value as T;
}
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export function download(name: string, value: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function fileBase64(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error(t('附件不能超过 10 MB')));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(t('读取文件失败，请重试。'))); reader.readAsDataURL(file); });
}
export function time(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(getLocale(), { ...(today ? {} : { month: 'short' as const, day: 'numeric' as const }), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
