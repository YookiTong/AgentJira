import english from './messages.en.json';

export type Locale = 'zh-CN' | 'en';
export const normalizeLocale = (value?: string | null): Locale => /^en(?:[-_,;]|$)/i.test(value || '') ? 'en' : 'zh-CN';
export type TranslationValues = Record<string, string | number | undefined>;
export const englishMessages: Readonly<Record<string, string>> = english;

export function translate(locale: Locale, key: string, values: TranslationValues = {}): string {
  const template = locale === 'en' ? englishMessages[key] ?? key : key;
  return template.replace(/\{(\w+)\}/g, (token, name) => values[name] === undefined ? token : String(values[name]));
}

// Only use this for application-generated messages, never to rewrite user content.
export function translateServiceText(locale: Locale, message: string): string {
  if (locale !== 'en') return message;
  if (englishMessages[message] !== undefined) return englishMessages[message];
  for (const [key, translation] of Object.entries(englishMessages)) {
    if (!/\{p\d+\}/.test(key)) continue;
    const names: string[] = [];
    const pattern = key.split(/(\{p\d+\})/).map(part => {
      if (/^\{p\d+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    const matched = new RegExp(`^${pattern}$`).exec(message);
    if (matched) return translation.replace(/\{(p\d+)\}/g, (token, name) => matched[names.indexOf(name) + 1] ?? token);
  }
  return message;
}
