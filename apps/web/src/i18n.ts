import { useSyncExternalStore } from 'react';
import { normalizeLocale, translate, type Locale, type TranslationValues } from '../../../shared/i18n';

function initialLocale(): Locale {
  const parameter = new URLSearchParams(location.search).get('lang');
  if (parameter) return normalizeLocale(parameter);
  try { return normalizeLocale(localStorage.getItem('agent-jira-language')); } catch { return 'zh-CN'; }
}
let locale = initialLocale();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getLocale = () => locale;
export const useLocale = () => useSyncExternalStore(subscribe, getLocale, () => 'zh-CN' as Locale);
export function setLocale(next: Locale) {
  locale = normalizeLocale(next);
  try { localStorage.setItem('agent-jira-language', locale); } catch { /* The current session still works without storage. */ }
  listeners.forEach(listener => listener());
}
export const t = (key: string, values?: TranslationValues) => translate(locale, key, values);
export const unitLabel = (count: number, unit: 'files' | 'modules') =>
  locale === 'en' ? (count === 1 ? unit.slice(0, -1) : unit) : t(unit === 'files' ? '份交付' : '个模块');
export const countLabel = (count: number, unit: 'files' | 'modules') =>
  `${count}${locale === 'en' ? ' ' : ''}${unitLabel(count, unit)}`;
export const projectUrl = (id: string | null) => {
  const query = new URLSearchParams({ lang: locale });
  if (id) query.set('project', id);
  return `/?${query}`;
};
