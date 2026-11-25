import { HttpResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import {
  ABSENCE_SHORT, Absence, ApiService, DayInfo, Employee, GenerateResult, Shift, absenceIcon, errorMessage,
} from '../../core/api.service';
import { AbsenceDialogComponent } from '../../shared/absence-dialog.component';
import { DayDialogComponent } from '../../shared/day-dialog.component';
import { GenerateDialogComponent } from '../../shared/generate-dialog.component';
import { MONTHS, WEEKDAYS_SHORT, addDays, fromIso, startOfWeek, toIso } from '../../core/dates';

type View = 'month' | 'week';

interface DialogState {
  date: string;
  editShiftId: number | null;
  presetEmployeeId: number | null;
}

interface AbsenceDialogState {
  absence: Absence | null;
  date: string | null;
  employeeId: number | null;
}

@Component({
  selector: 'app-calendar',
  imports: [DayDialogComponent, AbsenceDialogComponent, GenerateDialogComponent],
  templateUrl: './calendar.page.html',
  styleUrl: './calendar.page.css',
})
export class CalendarPage {
  private api = inject(ApiService);
  weekdaysShort = WEEKDAYS_SHORT;

  view = signal<View>((localStorage.getItem('erpie.view') as View) || 'month');
  anchor = signal(new Date());
  employees = signal<Employee[]>([]);
  days = signal<DayInfo[]>([]);
  shifts = signal<Shift[]>([]);
  error = signal('');
  loading = signal(false);
  exporting = signal(false);
  downloading = signal(false);
  dialog = signal<DialogState | null>(null);
  absenceDialog = signal<AbsenceDialogState | null>(null);
  generateOpen = signal(false);
  absences = signal<Absence[]>([]);
  notice = signal('');
  todayIso = toIso(new Date());
  absenceIcon = absenceIcon;
  absenceShort = ABSENCE_SHORT;

  /** drag & drop: the shift being dragged and the cell under the cursor ("iso" or "iso|employeeId") */
  dragShift = signal<Shift | null>(null);
  dropTarget = signal<string | null>(null);

  /** first and last visible date */
  range = computed(() => {
    const a = this.anchor();
    if (this.view() === 'week') {
      const s = startOfWeek(a);
      return { start: s, end: addDays(s, 6) };
    }
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    const start = startOfWeek(first);
    const end = addDays(startOfWeek(last), 6);
    return { start, end };
  });

  title = computed(() => {
    const a = this.anchor();
    if (this.view() === 'month') return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
    const { start, end } = this.range();
    const f = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.`;
    return `${f(start)} – ${f(end)}${end.getFullYear()}`;
  });

  exportLabel = computed(() => {
    const a = this.anchor();
    return `${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  });

  dayMap = computed(() => new Map(this.days().map((d) => [d.date, d])));
  employeeMap = computed(() => new Map(this.employees().map((e) => [e.id, e])));

  shiftsByDate = computed(() => {
    const m = new Map<string, Shift[]>();
    for (const s of this.shifts()) {
      const list = m.get(s.date) ?? [];
      list.push(s);
      m.set(s.date, list);
    }
    return m;
  });

  /** Month view: weeks of 7 ISO dates */
  weeks = computed(() => {
    const { start, end } = this.range();
    const weeks: string[][] = [];
    for (let d = start; d <= end; d = addDays(d, 7)) {
      weeks.push(Array.from({ length: 7 }, (_, i) => toIso(addDays(d, i))));
    }
    return weeks;
  });

  /** Week view: the 7 ISO dates */
  weekDates = computed(() => {
    const { start } = this.range();
    return Array.from({ length: 7 }, (_, i) => toIso(addDays(start, i)));
  });

  /** Employees shown as rows in week view: active ones plus anyone with a shift in the range */
  rowEmployees = computed(() => {
    const withShifts = new Set(this.shifts().map((s) => s.employee_id));
    return this.employees().filter((e) => e.active || withShifts.has(e.id));
  });

  /** Hours per employee in the current month (month view) or week (week view) */
  totals = computed(() => {
    const a = this.anchor();
    const inScope = (iso: string) => this.view() === 'week' || fromIso(iso).getMonth() === a.getMonth();
    const m = new Map<number, { hours: number; days: Set<string> }>();
    for (const s of this.shifts()) {
      if (!inScope(s.date)) continue;
      const t = m.get(s.employee_id) ?? { hours: 0, days: new Set<string>() };
      t.hours += s.hours;
      t.days.add(s.date);
      m.set(s.employee_id, t);
    }
    return m;
  });

  summaryRows = computed(() =>
    this.rowEmployees()
      .map((e) => ({
        e,
        hours: round(this.totals().get(e.id)?.hours ?? 0),
        days: this.totals().get(e.id)?.days.size ?? 0,
        absent: this.absenceTotals().get(e.id) ?? 0,
      }))
      .filter((r) => r.e.active || r.hours > 0),
  );

  /** absences per ISO date in the visible range */
  absencesByDate = computed(() => {
    const m = new Map<string, Absence[]>();
    const { start, end } = this.range();
    for (const a of this.absences()) {
      let d = fromIso(a.start_date) < start ? start : fromIso(a.start_date);
      const last = fromIso(a.end_date) > end ? end : fromIso(a.end_date);
      for (; d <= last; d = addDays(d, 1)) {
        const iso = toIso(d);
        m.set(iso, [...(m.get(iso) ?? []), a]);
      }
    }
    return m;
  });

  /** absence days per employee in the current month (month view) or week (week view) */
  absenceTotals = computed(() => {
    const a = this.anchor();
    const m = new Map<number, number>();
    for (const [iso, list] of this.absencesByDate()) {
      if (this.view() === 'month' && fromIso(iso).getMonth() !== a.getMonth()) continue;
      for (const ab of list) m.set(ab.employee_id, (m.get(ab.employee_id) ?? 0) + 1);
    }
    return m;
  });

  dialogDay = computed(() => {
    const d = this.dialog();
    return d ? this.dayMap().get(d.date) : undefined;
  });

  constructor() {
    this.api.employees().subscribe({ next: (e) => this.employees.set(e), error: (err) => this.error.set(errorMessage(err)) });
    effect(() => {
      const { start, end } = this.range();
      this.load(toIso(start), toIso(end));
    });
    effect(() => localStorage.setItem('erpie.view', this.view()));
  }

  load(start = toIso(this.range().start), end = toIso(this.range().end)) {
    this.loading.set(true);
    forkJoin({
      days: this.api.days(start, end),
      shifts: this.api.shifts(start, end),
      absences: this.api.absences(start, end),
    }).subscribe({
      next: ({ days, shifts, absences }) => {
        this.days.set(days);
        this.shifts.set(shifts);
        this.absences.set(absences);
        this.error.set('');
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  // ------------------------------------------------ navigation
  setView(v: View) {
    this.view.set(v);
  }
  today() {
    this.anchor.set(new Date());
  }
  move(dir: 1 | -1) {
    const a = this.anchor();
    if (this.view() === 'week') this.anchor.set(addDays(a, 7 * dir));
    else this.anchor.set(new Date(a.getFullYear(), a.getMonth() + dir, 1));
  }
  openWeek(iso: string) {
    this.anchor.set(fromIso(iso));
    this.view.set('week');
  }

  // ------------------------------------------------ helpers for template
  dayNum(iso: string) {
    return fromIso(iso).getDate();
  }
  isOtherMonth(iso: string) {
    return this.view() === 'month' && fromIso(iso).getMonth() !== this.anchor().getMonth();
  }
  isWeekend(iso: string) {
    const wd = fromIso(iso).getDay();
    return wd === 0 || wd === 6;
  }
  empName(id: number, short = false) {
    const e = this.employeeMap().get(id);
    if (!e) return '?';
    return short ? `${e.first_name} ${e.last_name.charAt(0)}.` : `${e.first_name} ${e.last_name}`;
  }
  empColor(id: number) {
    return this.employeeMap().get(id)?.color ?? '#999';
  }
  shiftsFor(iso: string) {
    return this.shiftsByDate().get(iso) ?? [];
  }
  cellShifts(iso: string, employeeId: number) {
    return this.shiftsFor(iso).filter((s) => s.employee_id === employeeId);
  }
  dayTotal(iso: string) {
    return round(this.shiftsFor(iso).reduce((a, s) => a + s.hours, 0));
  }
  absencesFor(iso: string) {
    return this.absencesByDate().get(iso) ?? [];
  }
  cellAbsence(iso: string, employeeId: number) {
    return this.absencesFor(iso).find((a) => a.employee_id === employeeId);
  }
  weekTotal(employeeId: number) {
    return round(this.totals().get(employeeId)?.hours ?? 0);
  }

  // ------------------------------------------------ actions
  openDay(iso: string, editShiftId: number | null = null, presetEmployeeId: number | null = null) {
    this.dialog.set({ date: iso, editShiftId, presetEmployeeId });
  }

  openAbsence(absence: Absence | null, date: string | null = null, employeeId: number | null = null) {
    this.dialog.set(null);
    this.absenceDialog.set({ absence, date, employeeId });
  }

  absenceSaved(a: Absence) {
    this.absenceDialog.set(null);
    this.flash(a.removed_shifts ? `Absence saved. ${a.removed_shifts} shift(s) in that period were removed.` : 'Absence saved.');
    this.load();
  }

  generated(res: GenerateResult) {
    this.generateOpen.set(false);
    const parts = [`${res.created} shift(s) created`];
    if (res.deleted) parts.push(`${res.deleted} old shift(s) replaced`);
    if (res.skipped_absent) parts.push(`${res.skipped_absent} day(s) skipped because of absences`);
    this.flash(`Schedule generated: ${parts.join(', ')}.`);
    this.load();
  }

  private flash(msg: string) {
    this.notice.set(msg);
    setTimeout(() => this.notice() === msg && this.notice.set(''), 6000);
  }

  // ------------------------------------------------ drag & drop
  dragStart(ev: DragEvent, s: Shift) {
    ev.stopPropagation();
    this.dragShift.set(s);
    ev.dataTransfer?.setData('text/plain', String(s.id)); // required by Firefox
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove';
  }

  dragEnd() {
    this.dragShift.set(null);
    this.dropTarget.set(null);
  }

  dragOver(ev: DragEvent, iso: string, employeeId: number | null = null) {
    if (!this.dragShift()) return;
    ev.preventDefault(); // allow drop
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = isCopy(ev) ? 'copy' : 'move';
    this.dropTarget.set(employeeId ? `${iso}|${employeeId}` : iso);
  }

  dragLeave(ev: DragEvent) {
    const to = ev.relatedTarget as Node | null;
    if (!to || !(ev.currentTarget as Node).contains(to)) this.dropTarget.set(null);
  }

  /** Move (or with Ctrl held: copy) the dragged shift to another day and optionally another employee. */
  drop(ev: DragEvent, iso: string, employeeId: number | null = null) {
    ev.preventDefault();
    const s = this.dragShift();
    this.dragEnd();
    if (!s) return;
    const copy = isCopy(ev);
    const empId = employeeId ?? s.employee_id;
    if (!copy && iso === s.date && empId === s.employee_id) return;

    const from = this.dayMap().get(s.date);
    const to = this.dayMap().get(iso);
    const name = this.empName(empId);
    if (to?.closed && !confirm(`The bar is closed on ${iso}. Put ${name} there anyway?`)) return;
    if (this.cellShifts(iso, empId).some((x) => x.id !== s.id) &&
        !confirm(`${name} already has a shift on that day. Add another one?`)) return;

    // a shift that covered the full working day takes the target day's working hours
    const fullDay = from && s.start_time === from.open_time && s.end_time === from.close_time;
    const useTarget = fullDay && to && !to.closed;
    const payload = {
      employee_id: empId,
      date: iso,
      start_time: useTarget ? to.open_time : s.start_time,
      end_time: useTarget ? to.close_time : s.end_time,
      note: s.note,
    };
    (copy ? this.api.createShift(payload) : this.api.updateShift(s.id, payload)).subscribe({
      next: (saved) => {
        const rest = copy ? this.shifts() : this.shifts().filter((x) => x.id !== s.id);
        this.shifts.set([...rest, saved].sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)));
        this.error.set('');
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  /** Week view: click on an empty cell adds a shift with the day's working hours right away. */
  quickAdd(iso: string, emp: Employee) {
    const absent = this.cellAbsence(iso, emp.id);
    if (absent) {
      this.openAbsence(absent);
      return;
    }
    const day = this.dayMap().get(iso);
    if (!day || day.closed || !emp.active) {
      this.openDay(iso, null, emp.id);
      return;
    }
    this.api
      .createShift({ employee_id: emp.id, date: iso, start_time: day.open_time, end_time: day.close_time, note: null })
      .subscribe({
        next: (s) => this.shifts.set([...this.shifts(), s]),
        error: (err) => this.error.set(errorMessage(err)),
      });
  }

  print() {
    window.print();
  }

  downloadPdf() {
    this.downloading.set(true);
    this.api.exportSchedule(this.view(), toIso(this.anchor())).subscribe({
      next: (res) => {
        saveFile(res, 'schedule.pdf');
        this.downloading.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.downloading.set(false);
      },
    });
  }

  exportExcel() {
    const a = this.anchor();
    this.exporting.set(true);
    this.api.exportMonth(a.getFullYear(), a.getMonth() + 1).subscribe({
      next: (res) => {
        saveFile(res, 'sihterica.xlsx');
        this.exporting.set(false);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.exporting.set(false);
      },
    });
  }
}

/** Save a downloaded blob under the server-provided file name. */
function saveFile(res: HttpResponse<Blob>, fallback: string) {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallback;
  const url = URL.createObjectURL(res.body!);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function isCopy(ev: DragEvent) {
  return ev.ctrlKey || ev.metaKey || ev.altKey;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
