import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ABSENCE_KINDS, Absence, AbsenceKind, ApiService, Employee, errorMessage } from '../../core/api.service';
import { diffDays, formatDate, toIso } from '../../core/dates';
import { AbsenceDialogComponent } from '../../shared/absence-dialog.component';

@Component({
  selector: 'app-absences',
  imports: [FormsModule, AbsenceDialogComponent],
  template: `
    <div class="page-header">
      <h1>Absences</h1>
      <div class="toolbar">
        <select [ngModel]="employeeFilter()" (ngModelChange)="employeeFilter.set($event)">
          <option [ngValue]="null">All employees</option>
          @for (e of employees(); track e.id) { <option [ngValue]="e.id">{{ e.first_name }} {{ e.last_name }}</option> }
        </select>
        <select [ngModel]="kindFilter()" (ngModelChange)="kindFilter.set($event)">
          <option [ngValue]="null">All types</option>
          @for (k of kinds; track k.kind) { <option [ngValue]="k.kind">{{ k.icon }} {{ k.label }}</option> }
        </select>
        <label class="check"><input type="checkbox" [ngModel]="showPast()" (ngModelChange)="showPast.set($event)" /> Show past</label>
        <button class="primary" (click)="openNew()">+ New absence</button>
      </div>
    </div>
    @if (error()) { <div class="error">{{ error() }}</div> }
    @if (info()) { <div class="card" style="padding:8px 12px">{{ info() }}</div> }

    <div class="card" style="padding:0">
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Note</th><th></th></tr></thead>
          <tbody>
            @for (a of filtered(); track a.id) {
              <tr>
                <td><span class="dot" [style.background]="emp(a.employee_id)?.color"></span> {{ empName(a.employee_id) }}</td>
                <td><span class="absence-badge" [attr.data-kind]="a.kind">{{ kindIcon(a.kind) }} {{ kindLabel(a.kind) }}</span></td>
                <td>{{ fmt(a.start_date) }}</td>
                <td>{{ fmt(a.end_date) }}</td>
                <td>{{ length(a) }}</td>
                <td>{{ a.note }}</td>
                <td class="actions">
                  <button class="small" (click)="openEdit(a)">Edit</button>
                  <button class="small danger" (click)="remove(a)">Delete</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="empty">No absences{{ showPast() ? '' : ' today or later' }}.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Days this year ({{ year }})</h2>
      <table class="grid">
        <thead><tr><th>Employee</th>@for (k of kinds; track k.kind) { <th>{{ k.icon }} {{ k.label }}</th> }</tr></thead>
        <tbody>
          @for (row of yearTotals(); track row.e.id) {
            <tr>
              <td>{{ row.e.first_name }} {{ row.e.last_name }}</td>
              @for (k of kinds; track k.kind) { <td>{{ row.days[k.kind] || '' }}</td> }
            </tr>
          }
        </tbody>
      </table>
    </div>

    @if (dialog(); as d) {
      <app-absence-dialog
        [employees]="employees()"
        [absence]="d.absence"
        (saved)="afterSave($event)"
        (deleted)="dialog.set(null); load()"
        (closed)="dialog.set(null)"
      />
    }
  `,
})
export class AbsencesPage {
  private api = inject(ApiService);
  kinds = ABSENCE_KINDS;
  fmt = formatDate;
  year = new Date().getFullYear();
  today = toIso(new Date());

  employees = signal<Employee[]>([]);
  absences = signal<Absence[]>([]);
  employeeFilter = signal<number | null>(null);
  kindFilter = signal<AbsenceKind | null>(null);
  showPast = signal(false);
  error = signal('');
  info = signal('');
  dialog = signal<{ absence: Absence | null } | null>(null);

  filtered = computed(() =>
    this.absences()
      .filter((a) => this.showPast() || a.end_date >= this.today)
      .filter((a) => !this.employeeFilter() || a.employee_id === this.employeeFilter())
      .filter((a) => !this.kindFilter() || a.kind === this.kindFilter())
      .sort((a, b) => a.start_date.localeCompare(b.start_date)),
  );

  /** Calendar days of each absence type per employee, clipped to the current year. */
  yearTotals = computed(() => {
    const from = `${this.year}-01-01`, to = `${this.year}-12-31`;
    const rows = new Map<number, Partial<Record<AbsenceKind, number>>>();
    for (const a of this.absences()) {
      const s = a.start_date > from ? a.start_date : from;
      const e = a.end_date < to ? a.end_date : to;
      if (s > e) continue;
      const r = rows.get(a.employee_id) ?? {};
      r[a.kind] = (r[a.kind] ?? 0) + diffDays(s, e) + 1;
      rows.set(a.employee_id, r);
    }
    return this.employees().filter((e) => rows.has(e.id)).map((e) => ({ e, days: rows.get(e.id)! }));
  });

  constructor() {
    this.load();
  }

  load() {
    forkJoin({ employees: this.api.employees(), absences: this.api.absences() }).subscribe({
      next: ({ employees, absences }) => {
        this.employees.set(employees);
        this.absences.set(absences);
        this.error.set('');
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  emp(id: number) {
    return this.employees().find((e) => e.id === id);
  }
  empName(id: number) {
    const e = this.emp(id);
    return e ? `${e.first_name} ${e.last_name}` : '?';
  }
  kindLabel(k: AbsenceKind) {
    return ABSENCE_KINDS.find((x) => x.kind === k)?.label ?? k;
  }
  kindIcon(k: AbsenceKind) {
    return ABSENCE_KINDS.find((x) => x.kind === k)?.icon ?? '';
  }
  length(a: Absence) {
    return diffDays(a.start_date, a.end_date) + 1;
  }

  openNew() {
    this.dialog.set({ absence: null });
  }
  openEdit(a: Absence) {
    this.dialog.set({ absence: a });
  }

  afterSave(a: Absence) {
    this.dialog.set(null);
    this.info.set(a.removed_shifts ? `Saved. ${a.removed_shifts} shift(s) in that period were removed.` : '');
    this.load();
  }

  remove(a: Absence) {
    if (!confirm(`Delete this absence of ${this.empName(a.employee_id)}?`)) return;
    this.api.deleteAbsence(a.id).subscribe({ next: () => this.load(), error: (e) => this.error.set(errorMessage(e)) });
  }
}
