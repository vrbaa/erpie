/** Date helpers working with local 'YYYY-MM-DD' strings. */

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function toIso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fromIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** 0 = Monday ... 6 = Sunday */
export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function startOfWeek(d: Date): Date {
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -weekdayIndex(d));
}

export function formatDate(iso: string): string {
  const d = fromIso(iso);
  return `${WEEKDAYS_SHORT[weekdayIndex(d)]} ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}.`;
}

/** Shift length in hours; end <= start means past midnight. */
export function shiftHours(start: string, end: string): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let s = toMin(start), e = toMin(end);
  if (e <= s) e += 24 * 60;
  return Math.round(((e - s) / 60) * 100) / 100;
}

/** Whole days from a to b (ISO strings). */
export function diffDays(a: string, b: string): number {
  return Math.round((fromIso(b).getTime() - fromIso(a).getTime()) / 86_400_000);
}

export interface RuleShape {
  kind: 'rotation' | 'pattern';
  pattern: string | null;
  off_days: number;
  shift_days: number;
}

/**
 * One flag per day of the rule's cycle, starting at the employee's anchor date: true = works.
 * Rotation: offDays free, then work, cycle of 7 + shiftDays. Pattern: the weekly flags, Monday first.
 */
export function ruleWorkFlags(rule: RuleShape): boolean[] {
  if (rule.kind === 'pattern' && rule.pattern) return [...rule.pattern.replace(/,/g, '')].map((c) => c === '1');
  return Array.from({ length: 7 + rule.shift_days }, (_, i) => i >= rule.off_days);
}

export function isRuleOff(iso: string, anchor: string, rule: RuleShape): boolean {
  const flags = ruleWorkFlags(rule);
  const n = diffDays(anchor, iso);
  return !flags[((n % flags.length) + flags.length) % flags.length];
}
