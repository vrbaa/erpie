import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  Absence, ApiService, DayInfo, Employee, GenerateResult, ScheduleRule, absenceIcon, errorMessage,
} from '../core/api.service';
import { MONTHS, WEEKDAYS_SHORT, addDays, diffDays, fromIso, isRuleOff, ruleWorkFlags, startOfWeek, toIso, weekdayIndex } from '../core/dates';
import { describeRule } from '../pages/rules/rules.page';

interface Row {
  employee: Employee;
  include: boolean;
  firstOff: string;
  stored: boolean;
}

type CellKind = 'work' | 'free' | 'closed' | 'absent' | 'before';

/** Generate a month schedule from a rule, with a per-employee preview of free days. */
@Component({
  selector: 'app-generate-dialog',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="modal wide" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <h2 style="margin:0">Generate schedule · {{ monthName() }}</h2>
          <button type="button" class="icon-btn" (click)="closed.emit()">×</button>
        </div>
        <div class="modal-body">
          @if (error()) { <div class="error">{{ error() }}</div> }

          <div class="toolbar" style="margin-bottom:8px">
            <label class="muted"><strong>Rule</strong></label>
            <select [ngModel]="ruleId()" (ngModelChange)="selectRule($event)" style="min-width:320px">
              @for (r of rules(); track r.id) {
                <option [ngValue]="r.id">{{ r.name }}{{ r.is_default ? ' (default)' : '' }}</option>
              }
            </select>
            <a routerLink="/rules" (click)="closed.emit()">Manage rules</a>
          </div>
          @if (rule(); as r) {
            <p class="muted" style="margin:0 0 12px">
              {{ describe(r) }} · Shifts: {{ r.start_time ? r.start_time + '–' + r.end_time : "each day's working hours" }}.
              Closed days and absences are skipped.
            </p>
          }

          <div class="table-wrap">
            <table class="strip">
              <thead>
                <tr>
                  <th class="name-col"><label class="check"><input type="checkbox" [checked]="allIncluded()" (change)="toggleAll($any($event.target).checked)" /> Employee</label></th>
                  <th class="date-col">{{ isPattern() ? 'Starts in' : 'First free day' }}</th>
                  @for (d of monthDates(); track d) {
                    <th class="day" [class.wkend]="isWeekend(d)" [class.week-start]="isMonday(d)">{{ dayLetter(d) }}<br />{{ dayNum(d) }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.employee.id) {
                  <tr [class.excluded]="!row.include">
                    <td class="name-col">
                      <label class="check">
                        <input type="checkbox" [ngModel]="row.include" (ngModelChange)="patch(row, { include: $event })" />
                        <span class="dot" [style.background]="row.employee.color"></span>
                        {{ row.employee.first_name }} {{ row.employee.last_name }}
                      </label>
                    </td>
                    <td class="date-col">
                      @if (isPattern()) {
                        @if (patternWeeks() > 1) {
                          <select [ngModel]="startWeek(row)" (ngModelChange)="setStartWeek(row, $event)"
                                  [title]="'Pattern week used in the first week of ' + monthName()">
                            @for (w of weekOptions(); track w) { <option [ngValue]="w">week {{ w }}</option> }
                          </select>
                        } @else { <span class="muted">every week</span> }
                      } @else {
                        <input type="date" [ngModel]="row.firstOff" (ngModelChange)="$event && patch(row, { firstOff: $event, stored: false })"
                               [title]="row.stored ? 'Continues from the previous month' : 'Suggested'" />
                      }
                      @if (row.stored) { <span class="muted" title="Continues the rotation from earlier months">↻</span> }
                    </td>
                    @for (d of monthDates(); track d) {
                      @let k = cell(row, d);
                      <td class="day {{ k }}" [class.week-start]="isMonday(d)" [style.background]="k === 'work' && row.include ? row.employee.color : null"
                          [title]="cellTitle(row, d, k)" (click)="row.include && !isPattern() && k !== 'closed' && setFirstOff(row, d)">
                        {{ k === 'free' ? 'F' : k === 'absent' ? absentIcon(row, d) : '' }}
                      </td>
                    }
                  </tr>
                } @empty {
                  <tr><td colspan="40" class="empty">No active employees.</td></tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <td class="name-col" colspan="2"><strong>Working</strong></td>
                  @for (d of monthDates(); track d) {
                    @let n = coverage().get(d);
                    <td class="day" [class.low]="n === 0 && !isClosed(d)" [class.week-start]="isMonday(d)">{{ isClosed(d) ? '–' : n }}</td>
                  }
                </tr>
              </tfoot>
            </table>
          </div>
          <p class="muted small">
            <span class="legend free">F</span> free day · <span class="legend closed"></span> bar closed ·
            @if (!isPattern()) { click a day in a row to make that the employee's first free day. }
            @else { pick for each employee which week of the pattern the month starts with. }
          </p>

          <label class="check"><input type="checkbox" [(ngModel)]="replace" /> Replace existing shifts of the selected employees in {{ monthName() }}</label>
          @if (!replace) { <p class="muted small" style="margin:4px 0 0 22px">Days where an employee already has a shift are left as they are.</p> }
        </div>
        <div class="modal-foot">
          <button type="button" (click)="closed.emit()">Cancel</button>
          <button type="button" class="primary" (click)="generate()" [disabled]="busy() || !included().length || !rule()">
            {{ busy() ? 'Generating…' : 'Generate for ' + included().length + ' ' + (included().length === 1 ? 'employee' : 'employees') }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .modal.wide { width: min(1280px, 100%); }
    table.strip { border-collapse: collapse; font-size: 11px; }
    table.strip th, table.strip td { border: 1px solid var(--border); padding: 0; text-align: center; }
    table.strip th { background: #f8f9fb; color: var(--muted); font-weight: 600; }
    .name-col { text-align: left !important; padding: 3px 8px !important; white-space: nowrap; font-size: 13px; min-width: 170px; }
    .date-col { padding: 2px 6px !important; white-space: nowrap; }
    .date-col input { padding: 2px 4px; font-size: 12px; }
    th.day, td.day { width: 24px; min-width: 24px; height: 26px; }
    th.day.wkend { color: var(--text); }
    .week-start { border-left: 2px solid #9aa5b1 !important; }
    td.day { cursor: pointer; }
    td.day.work { opacity: 0.85; }
    td.day.free { background: #e3f4e8; color: #1e7a3d; font-weight: 700; }
    td.day.closed { background: repeating-linear-gradient(45deg, #eceef1, #eceef1 3px, #fff 3px, #fff 6px); cursor: default; }
    td.day.absent { background: #fff4dc; }
    td.day.before { background: #f3f4f6; }
    td.day.low { background: var(--holiday-bg); color: var(--holiday); font-weight: 700; }
    tr.excluded td:not(.name-col) { opacity: 0.35; }
    tr.excluded td.day.work { background: transparent !important; }
    tfoot td { background: #f8f9fb; font-weight: 600; }
    .legend { display: inline-block; width: 16px; height: 14px; text-align: center; border: 1px solid var(--border); vertical-align: middle; font-size: 10px; }
    .legend.free { background: #e3f4e8; color: #1e7a3d; font-weight: 700; }
    .legend.closed { background: repeating-linear-gradient(45deg, #eceef1, #eceef1 3px, #fff 3px, #fff 6px); }
    .small { font-size: 12px; }
  `,
})
export class GenerateDialogComponent implements OnInit {
  private api = inject(ApiService);
  describe = describeRule;

  year = input.required<number>();
  month = input.required<number>(); // 1-12
  employees = input.required<Employee[]>();

  days = signal<DayInfo[]>([]);
  absences = signal<Absence[]>([]);

  generated = output<GenerateResult>();
  closed = output<void>();

  rules = signal<ScheduleRule[]>([]);
  ruleId = signal<number | null>(null);
  rows = signal<Row[]>([]);
  error = signal('');
  busy = signal(false);
  replace = true;

  rule = computed(() => this.rules().find((r) => r.id === this.ruleId()) ?? null);
  monthName = computed(() => `${MONTHS[this.month() - 1]} ${this.year()}`);
  monthDates = computed(() => {
    const first = new Date(this.year(), this.month() - 1, 1);
    const n = new Date(this.year(), this.month(), 0).getDate();
    return Array.from({ length: n }, (_, i) => toIso(addDays(first, i)));
  });
  dayMap = computed(() => new Map(this.days().map((d) => [d.date, d])));
  included = computed(() => this.rows().filter((r) => r.include));
  allIncluded = computed(() => this.rows().length > 0 && this.rows().every((r) => r.include));

  coverage = computed(() => {
    const m = new Map<string, number>();
    for (const d of this.monthDates()) {
      m.set(d, this.included().filter((r) => this.cell(r, d) === 'work').length);
    }
    return m;
  });

  ngOnInit() {
    const dates = this.monthDates();
    const [start, end] = [dates[0], dates[dates.length - 1]];
    forkJoin({ rules: this.api.rules(), days: this.api.days(start, end), absences: this.api.absences(start, end) }).subscribe({
      next: ({ rules, days, absences }) => {
        this.days.set(days);
        this.absences.set(absences);
        this.rules.set(rules);
        const def = rules.find((r) => r.is_default) ?? rules[0];
        if (def) this.selectRule(def.id);
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  selectRule(id: number) {
    this.ruleId.set(id);
    const active = this.employees().filter((e) => e.active);
    const included = new Map(this.rows().map((r) => [r.employee.id, r.include]));
    this.api.rotations(this.year(), this.month(), id, active.map((e) => e.id)).subscribe({
      next: (rot) => {
        const byId = new Map(rot.map((r) => [r.employee_id, r]));
        this.rows.set(active.map((e) => ({
          employee: e,
          include: included.get(e.id) ?? true,
          firstOff: byId.get(e.id)?.first_off_date ?? toIso(new Date(this.year(), this.month() - 1, 1)),
          stored: byId.get(e.id)?.stored ?? false,
        })));
        this.error.set('');
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  patch(row: Row, changes: Partial<Row>) {
    this.rows.update((rows) => rows.map((r) => (r === row ? { ...r, ...changes } : r)));
  }
  toggleAll(on: boolean) {
    this.rows.update((rows) => rows.map((r) => ({ ...r, include: on })));
  }
  isPattern = computed(() => this.rule()?.kind === 'pattern');
  patternWeeks = computed(() => (this.rule() ? ruleWorkFlags(this.rule()!).length / 7 : 1));
  weekOptions = computed(() => Array.from({ length: this.patternWeeks() }, (_, i) => i + 1));
  /** Monday of the week containing the 1st: weekly patterns are anchored to it */
  baseMonday = computed(() => toIso(startOfWeek(new Date(this.year(), this.month() - 1, 1))));

  /** Which pattern week (1-based) the first week of the month is for this employee. */
  startWeek(row: Row) {
    const n = this.patternWeeks();
    const weeks = Math.floor(diffDays(row.firstOff, this.baseMonday()) / 7);
    return (((weeks % n) + n) % n) + 1;
  }
  setStartWeek(row: Row, week: number) {
    this.patch(row, { firstOff: toIso(addDays(fromIso(this.baseMonday()), -(week - 1) * 7)), stored: false });
  }

  setFirstOff(row: Row, iso: string) {
    this.patch(row, { firstOff: iso, stored: false });
  }

  absenceOn(row: Row, iso: string) {
    return this.absences().find((a) => a.employee_id === row.employee.id && a.start_date <= iso && iso <= a.end_date);
  }
  isClosed(iso: string) {
    return !!this.dayMap().get(iso)?.closed;
  }

  cell(row: Row, iso: string): CellKind {
    const rule = this.rule();
    if (this.isClosed(iso)) return 'closed';
    if (this.absenceOn(row, iso)) return 'absent';
    if (row.employee.employment_start && iso < row.employee.employment_start) return 'before';
    if (rule && isRuleOff(iso, row.firstOff, rule)) return 'free';
    return 'work';
  }

  cellTitle(row: Row, iso: string, k: CellKind) {
    const label = { work: 'works', free: 'free day', closed: 'bar closed', absent: 'absent', before: 'before employment start' }[k];
    return `${row.employee.first_name} · ${fromIso(iso).getDate()}.${this.month()}. · ${label}`;
  }
  absentIcon(row: Row, iso: string) {
    const a = this.absenceOn(row, iso);
    return a ? absenceIcon(a.kind) : '';
  }
  dayNum(iso: string) {
    return fromIso(iso).getDate();
  }
  dayLetter(iso: string) {
    return WEEKDAYS_SHORT[weekdayIndex(fromIso(iso))].charAt(0);
  }
  isWeekend(iso: string) {
    return weekdayIndex(fromIso(iso)) >= 5;
  }
  isMonday(iso: string) {
    return weekdayIndex(fromIso(iso)) === 0;
  }

  generate() {
    const rows = this.included();
    if (!rows.length) return;
    const existingNote = this.replace ? `\n\nExisting shifts of these employees in ${this.monthName()} will be replaced.` : '';
    if (!confirm(`Generate the ${this.monthName()} schedule for ${rows.length} employee(s)?${existingNote}`)) return;
    this.busy.set(true);
    this.api
      .generate({
        year: this.year(),
        month: this.month(),
        rule_id: this.ruleId(),
        replace: this.replace,
        assignments: rows.map((r) => ({ employee_id: r.employee.id, first_off_date: r.firstOff })),
      })
      .subscribe({
        next: (res) => { this.busy.set(false); this.generated.emit(res); },
        error: (e) => { this.busy.set(false); this.error.set(errorMessage(e)); },
      });
  }
}
