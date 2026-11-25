import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface Employee {
  id: number;
  first_name: string;
  last_name: string;
  oib: string | null;
  position: string | null;
  phone: string | null;
  email: string | null;
  employment_start: string | null;
  color: string;
  active: boolean;
  notes: string | null;
}
export type EmployeeInput = Omit<Employee, 'id'>;

export interface WeekdayHours {
  weekday: number; // 0 = Monday
  open_time: string;
  close_time: string;
  closed: boolean;
}

export interface SpecialDay {
  id: number;
  date: string;
  open_time: string;
  close_time: string;
  closed: boolean;
  is_holiday: boolean;
  note: string | null;
}
export type SpecialDayInput = Omit<SpecialDay, 'id'>;

export interface DayInfo {
  date: string;
  open_time: string;
  close_time: string;
  closed: boolean;
  is_holiday: boolean;
  special: boolean;
  note: string | null;
}

export interface Shift {
  id: number;
  employee_id: number;
  date: string;
  start_time: string;
  end_time: string;
  note: string | null;
  hours: number;
}
export type ShiftInput = Omit<Shift, 'id' | 'hours'>;

export interface Settings {
  company_name: string;
  absence_hours: number;
}

export interface ScheduleRule {
  id: number;
  name: string;
  kind: 'rotation' | 'pattern';
  pattern: string | null; // 'pattern' kind: weeks of 7 flags Mon..Sun ('1' = works), comma separated
  off_days: number; // free days in a row
  shift_days: number; // how many days the free block moves each week (0 = same days every week)
  stagger: boolean; // spread employees' free days apart
  start_time: string | null; // null = use each day's working hours
  end_time: string | null;
  is_default: boolean;
  note: string | null;
}
export type ScheduleRuleInput = Omit<ScheduleRule, 'id'>;

export interface Rotation {
  employee_id: number;
  first_off_date: string;
  stored: boolean;
}

export interface GenerateRequest {
  year: number;
  month: number;
  rule_id: number | null;
  assignments: { employee_id: number; first_off_date: string }[];
  replace: boolean;
}
export interface GenerateResult {
  created: number;
  deleted: number;
  skipped_absent: number;
}

export type AbsenceKind = 'vacation' | 'sick' | 'paid_leave' | 'unpaid_leave' | 'other';
export const ABSENCE_KINDS: { kind: AbsenceKind; label: string; icon: string }[] = [
  { kind: 'vacation', label: 'Vacation (Godišnji odmor)', icon: '🏖' },
  { kind: 'sick', label: 'Sick leave (Bolovanje)', icon: '🤒' },
  { kind: 'paid_leave', label: 'Paid leave (Plaćeni dopust)', icon: '📄' },
  { kind: 'unpaid_leave', label: 'Unpaid leave (Neplaćeni dopust)', icon: '⏸' },
  { kind: 'other', label: 'Other absence', icon: '•' },
];
export const ABSENCE_SHORT: Record<AbsenceKind, string> = {
  vacation: 'Godišnji', sick: 'Bolovanje', paid_leave: 'Plaćeni dopust', unpaid_leave: 'Neplaćeni', other: 'Odsutan',
};
export function absenceIcon(kind: AbsenceKind) {
  return ABSENCE_KINDS.find((k) => k.kind === kind)?.icon ?? '•';
}

export interface Absence {
  id: number;
  employee_id: number;
  kind: AbsenceKind;
  start_date: string;
  end_date: string;
  note: string | null;
  removed_shifts?: number;
}
export type AbsenceInput = Omit<Absence, 'id' | 'removed_shifts'>;

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'user';
  active: boolean;
  has_password: boolean;
  has_google: boolean;
  last_login_at: string | null;
}
export interface UserCreate {
  email: string;
  name: string;
  role: 'admin' | 'user';
  password: string | null;
}
export interface UserUpdate {
  name: string;
  role: 'admin' | 'user';
  active: boolean;
  password: string | null;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = '/api';

  // employees
  employees(activeOnly = false): Observable<Employee[]> {
    return this.http.get<Employee[]>(`${this.base}/employees`, { params: { active_only: activeOnly } });
  }
  createEmployee(e: EmployeeInput) {
    return this.http.post<Employee>(`${this.base}/employees`, e);
  }
  updateEmployee(id: number, e: EmployeeInput) {
    return this.http.put<Employee>(`${this.base}/employees/${id}`, e);
  }
  deleteEmployee(id: number) {
    return this.http.delete<void>(`${this.base}/employees/${id}`);
  }

  // workdays
  weekly() {
    return this.http.get<WeekdayHours[]>(`${this.base}/workdays/weekly`);
  }
  saveWeekly(rows: WeekdayHours[]) {
    return this.http.put<WeekdayHours[]>(`${this.base}/workdays/weekly`, rows);
  }
  specialDays(start?: string, end?: string) {
    let params = new HttpParams();
    if (start) params = params.set('start', start);
    if (end) params = params.set('end', end);
    return this.http.get<SpecialDay[]>(`${this.base}/workdays/special`, { params });
  }
  createSpecialDay(s: SpecialDayInput) {
    return this.http.post<SpecialDay>(`${this.base}/workdays/special`, s);
  }
  updateSpecialDay(id: number, s: SpecialDayInput) {
    return this.http.put<SpecialDay>(`${this.base}/workdays/special/${id}`, s);
  }
  deleteSpecialDay(id: number) {
    return this.http.delete<void>(`${this.base}/workdays/special/${id}`);
  }
  days(start: string, end: string) {
    return this.http.get<DayInfo[]>(`${this.base}/workdays/days`, { params: { start, end } });
  }

  // shifts
  shifts(start: string, end: string) {
    return this.http.get<Shift[]>(`${this.base}/shifts`, { params: { start, end } });
  }
  createShift(s: ShiftInput) {
    return this.http.post<Shift>(`${this.base}/shifts`, s);
  }
  updateShift(id: number, s: ShiftInput) {
    return this.http.put<Shift>(`${this.base}/shifts/${id}`, s);
  }
  deleteShift(id: number) {
    return this.http.delete<void>(`${this.base}/shifts/${id}`);
  }

  // settings
  settings() {
    return this.http.get<Settings>(`${this.base}/settings`);
  }
  saveSettings(s: Settings) {
    return this.http.put<Settings>(`${this.base}/settings`, s);
  }

  // schedule rules
  rules() {
    return this.http.get<ScheduleRule[]>(`${this.base}/rules`);
  }
  createRule(r: ScheduleRuleInput) {
    return this.http.post<ScheduleRule>(`${this.base}/rules`, r);
  }
  updateRule(id: number, r: ScheduleRuleInput) {
    return this.http.put<ScheduleRule>(`${this.base}/rules/${id}`, r);
  }
  deleteRule(id: number) {
    return this.http.delete<void>(`${this.base}/rules/${id}`);
  }

  // schedule generation
  rotations(year: number, month: number, ruleId: number | null, employeeIds: number[]) {
    let params = new HttpParams().set('year', year).set('month', month);
    if (ruleId) params = params.set('rule_id', ruleId);
    for (const id of employeeIds) params = params.append('employee_ids', id);
    return this.http.get<Rotation[]>(`${this.base}/schedule/rotations`, { params });
  }
  generate(req: GenerateRequest) {
    return this.http.post<GenerateResult>(`${this.base}/schedule/generate`, req);
  }

  // absences
  absences(start?: string, end?: string) {
    let params = new HttpParams();
    if (start) params = params.set('start', start);
    if (end) params = params.set('end', end);
    return this.http.get<Absence[]>(`${this.base}/absences`, { params });
  }
  createAbsence(a: AbsenceInput) {
    return this.http.post<Absence>(`${this.base}/absences`, a);
  }
  updateAbsence(id: number, a: AbsenceInput) {
    return this.http.put<Absence>(`${this.base}/absences/${id}`, a);
  }
  deleteAbsence(id: number) {
    return this.http.delete<void>(`${this.base}/absences/${id}`);
  }

  // users (admin)
  users() {
    return this.http.get<User[]>(`${this.base}/users`);
  }
  createUser(u: UserCreate) {
    return this.http.post<User>(`${this.base}/users`, u);
  }
  updateUser(id: number, u: UserUpdate) {
    return this.http.put<User>(`${this.base}/users/${id}`, u);
  }
  deleteUser(id: number) {
    return this.http.delete<void>(`${this.base}/users/${id}`);
  }

  // export
  exportSchedule(view: 'month' | 'week', day: string) {
    return this.http.get(`${this.base}/export/schedule`, {
      params: { view, day },
      responseType: 'blob',
      observe: 'response',
    });
  }

  exportMonth(year: number, month: number) {
    return this.http.get(`${this.base}/export/month`, {
      params: { year, month },
      responseType: 'blob',
      observe: 'response',
    });
  }
}

/** Extracts a readable message from an HttpErrorResponse. */
export function errorMessage(err: any): string {
  const detail = err?.error?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d: any) => `${d.loc?.slice(-1)[0]}: ${d.msg}`).join(', ');
  if (err?.status === 0) return 'Cannot reach the server. Is the backend running on port 8000?';
  return err?.message ?? 'Unknown error';
}
