import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, ScheduleRule, ScheduleRuleInput, errorMessage } from '../../core/api.service';
import { RuleShape, WEEKDAYS_SHORT, ruleWorkFlags, shiftHours } from '../../core/dates';

type RuleForm = ScheduleRuleInput & { fixedHours: boolean; weeks: boolean[][] };

const WORKERS = 'ABCD';

function patternWeeks(rule: RuleShape): boolean[][] {
  const flags = ruleWorkFlags(rule);
  return Array.from({ length: flags.length / 7 }, (_, w) => flags.slice(w * 7, w * 7 + 7));
}

function dayList(week: boolean[]): string {
  const days = WEEKDAYS_SHORT.filter((_, i) => week[i]);
  return days.length ? days.join(', ') : 'free all week';
}

/** Describes a rule in words. */
export function describeRule(r: RuleShape): string {
  if (r.kind === 'pattern') {
    const weeks = patternWeeks(r);
    const text = weeks.map((w, i) => (weeks.length > 1 ? `Week ${i + 1}: ` : 'Works ') + dayList(w)).join(' · ');
    if (weeks.length < 2) return text;
    const cover = coverage(r);
    const cov = cover.min === cover.max ? `${cover.min}` : `${cover.min}–${cover.max}`;
    return `${text}. With ${weeks.length} workers starting in different weeks: ${cov} working each day.`;
  }
  const free = `${r.off_days} free ${r.off_days === 1 ? 'day' : 'days in a row'}`;
  if (r.shift_days === 0) return `${free}, same weekdays every week (${7 - r.off_days} work, ${r.off_days} free)`;
  const cycle = 7 + r.shift_days;
  return `${free}, moving ${r.shift_days} ${r.shift_days === 1 ? 'day' : 'days'} later each week ` +
    `(repeating: ${cycle - r.off_days} work, ${r.off_days} free)`;
}

/** For pattern rules: how many of the N staggered workers work on each day (min / max over the cycle). */
function coverage(r: RuleShape) {
  const flags = ruleWorkFlags(r);
  const n = flags.length / 7;
  const counts = flags.map((_, p) => Array.from({ length: n }, (_, k) => flags[(p - k * 7 + flags.length) % flags.length]).filter(Boolean).length);
  return { min: Math.min(...counts), max: Math.max(...counts) };
}

interface PreviewCell {
  text: string;
  cls: string;
}

/**
 * Rotation: free days of someone whose first free day is Monday of week 1.
 * Pattern: which worker (A, B, …; worker k starts in week k+1) works each day.
 */
export function rulePreview(r: RuleShape): PreviewCell[][] {
  const flags = ruleWorkFlags(r);
  if (r.kind === 'pattern') {
    const n = flags.length / 7;
    const weeks = Math.max(4, n * 2);
    return Array.from({ length: weeks }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const who = Array.from({ length: n }, (_, k) => k).filter((k) => flags[(((w - k) % n + n) % n) * 7 + d]);
        const text = n === 1 ? (who.length ? 'work' : '') : who.map((k) => WORKERS[k]).join(' ');
        return { text, cls: who.length === 0 ? (n === 1 ? 'free' : 'none') : n === 1 ? 'work' : `w${who.length === 1 ? who[0] : 'm'}` };
      }),
    );
  }
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const free = !flags[(w * 7 + d) % flags.length];
      return { text: free ? 'free' : '', cls: free ? 'free' : '' };
    }),
  );
}

@Component({
  selector: 'app-rules',
  imports: [FormsModule],
  template: `
    <div class="page-header">
      <h1>Schedule rules</h1>
      <button class="primary" (click)="openNew()">+ New rule</button>
    </div>
    @if (error()) { <div class="error">{{ error() }}</div> }
    <p class="muted" style="margin-top:-6px">
      Rules are used by <strong>Schedule → Generate month</strong>. The default rule is preselected there.
      Each employee's place in the rule is remembered, so the next month continues where this one ended.
    </p>

    <div class="rules">
      @for (r of rules(); track r.id) {
        <div class="card rule" [class.default]="r.is_default">
          <div class="rule-head">
            <div>
              <h2 style="margin:0">{{ r.name }} @if (r.is_default) { <span class="badge ok">Default</span> }</h2>
              <div class="muted" style="margin-top:4px">{{ describe(r) }}</div>
              <div class="muted" style="margin-top:2px">
                Shift: {{ r.start_time ? r.start_time + '–' + r.end_time + ' (' + hours(r.start_time, r.end_time!) + ' h)' : "each day's working hours" }}
                · {{ r.stagger ? (r.kind === 'pattern' ? 'employees start in different weeks' : 'free days spread between employees') : 'everyone on the same days' }}
              </div>
              @if (r.note) { <div style="margin-top:4px">{{ r.note }}</div> }
            </div>
            <div class="toolbar">
              @if (!r.is_default) { <button class="small" (click)="makeDefault(r)">Set as default</button> }
              <button class="small" (click)="openEdit(r)">Edit</button>
              <button class="small danger" (click)="remove(r)" [disabled]="rules().length === 1" [title]="rules().length === 1 ? 'At least one rule is needed' : ''">Delete</button>
            </div>
          </div>
          <table class="preview">
            <thead><tr><th></th>@for (wd of weekdaysShort; track wd) { <th>{{ wd }}</th> }</tr></thead>
            <tbody>
              @for (week of preview(r); track $index) {
                <tr>
                  <th>Week {{ $index + 1 }}</th>
                  @for (c of week; track $index) { <td [class]="c.cls">{{ c.text }}</td> }
                </tr>
              }
            </tbody>
          </table>
          @if (r.kind === 'pattern' && weekCount(r) > 1) {
            <p class="muted small">A, B{{ weekCount(r) > 2 ? ', …' : '' }} = workers starting in week 1, 2{{ weekCount(r) > 2 ? ', …' : '' }} of the pattern.</p>
          }
        </div>
      } @empty {
        <div class="card empty">No rules yet.</div>
      }
    </div>

    @if (form(); as f) {
      <div class="backdrop" (click)="form.set(null)">
        <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="save()" #ngForm="ngForm">
          <div class="modal-head">
            <h2 style="margin:0">{{ editingId() ? 'Edit rule' : 'New rule' }}</h2>
            <button type="button" class="icon-btn" (click)="form.set(null)">×</button>
          </div>
          <div class="modal-body">
            @if (formError()) { <div class="error">{{ formError() }}</div> }
            <div class="form-grid">
              <div class="field full"><label>Name *</label><input name="name" [(ngModel)]="f.name" required maxlength="100" /></div>
              <div class="field full">
                <label>Type</label>
                <div class="toolbar">
                  <label class="check"><input type="radio" name="kind" value="pattern" [(ngModel)]="f.kind" /> Fixed weekly pattern (pick the work days)</label>
                  <label class="check"><input type="radio" name="kind" value="rotation" [(ngModel)]="f.kind" /> Rotating free days</label>
                </div>
              </div>

              @if (f.kind === 'pattern') {
                <div class="field full">
                  <label>Work days · pattern repeats every
                    <select name="weeks" [ngModel]="f.weeks.length" (ngModelChange)="setWeeks(f, $event)" style="padding:1px 4px">
                      @for (n of [1, 2, 3, 4]; track n) { <option [ngValue]="n">{{ n }}</option> }
                    </select>
                    {{ f.weeks.length === 1 ? 'week' : 'weeks' }}
                  </label>
                  <table class="preview editor">
                    <thead><tr><th></th>@for (wd of weekdaysShort; track wd) { <th>{{ wd }}</th> }</tr></thead>
                    <tbody>
                      @for (week of f.weeks; track wi; let wi = $index) {
                        <tr>
                          <th>Week {{ wi + 1 }}</th>
                          @for (on of week; track di; let di = $index) {
                            <td [class.work]="on" (click)="toggleDay(f, wi, di)">{{ on ? 'work' : '' }}</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                  @if (f.weeks.length > 1) {
                    <button type="button" class="small" style="margin-top:6px;align-self:flex-start" (click)="mirror(f)"
                            title="Week 2 = the days not worked in week 1 (so two workers alternate, one per day)">Week 2 = opposite of week 1</button>
                  }
                </div>
              } @else {
                <div class="field">
                  <label>Free days in a row</label>
                  <select name="off" [(ngModel)]="f.off_days">
                    @for (n of [1, 2, 3, 4]; track n) { <option [ngValue]="n">{{ n }}</option> }
                  </select>
                </div>
                <div class="field">
                  <label>Each week the free days move</label>
                  <select name="shift" [(ngModel)]="f.shift_days">
                    <option [ngValue]="0">not at all (same weekdays)</option>
                    @for (n of [1, 2, 3, 4, 5, 6]; track n) { <option [ngValue]="n">{{ n }} {{ n === 1 ? 'day' : 'days' }} later</option> }
                  </select>
                </div>
              }

              <div class="field full">
                <label>Shift hours</label>
                <label class="check"><input type="radio" name="fixed" [value]="false" [(ngModel)]="f.fixedHours" /> Each day's working hours (from Workdays)</label>
                <label class="check"><input type="radio" name="fixed" [value]="true" [(ngModel)]="f.fixedHours" /> Fixed hours</label>
              </div>
              @if (f.fixedHours) {
                <div class="field"><label>Start</label><input type="time" name="start" [(ngModel)]="f.start_time" required /></div>
                <div class="field"><label>End</label><input type="time" name="end" [(ngModel)]="f.end_time" required /></div>
              }
              <label class="check full"><input type="checkbox" name="stagger" [(ngModel)]="f.stagger" />
                {{ f.kind === 'pattern' ? 'Start employees in different weeks of the pattern' : 'Spread free days between employees (so the bar is not short-staffed)' }}</label>
              <label class="check full"><input type="checkbox" name="default" [(ngModel)]="f.is_default" [disabled]="editingWasDefault()" /> Default rule</label>
              <div class="field full"><label>Note</label><input name="note" [(ngModel)]="f.note" /></div>
            </div>
            @let shape = formShape(f);
            <p class="muted">{{ describe(shape) }}</p>
            <table class="preview">
              <thead><tr><th></th>@for (wd of weekdaysShort; track wd) { <th>{{ wd }}</th> }</tr></thead>
              <tbody>
                @for (week of preview(shape); track $index) {
                  <tr>
                    <th>Week {{ $index + 1 }}</th>
                    @for (c of week; track $index) { <td [class]="c.cls">{{ c.text }}</td> }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="modal-foot">
            <button type="button" (click)="form.set(null)">Cancel</button>
            <button type="submit" class="primary" [disabled]="ngForm.invalid || !hasWorkDay(f)">Save</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: `
    .rule.default { border-color: var(--primary); }
    .rule-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    table.preview { border-collapse: collapse; font-size: 12px; }
    table.preview th, table.preview td { border: 1px solid var(--border); padding: 3px 8px; text-align: center; min-width: 44px; height: 24px; }
    table.preview th { background: #f8f9fb; color: var(--muted); font-weight: 600; }
    table.preview td.free { background: #e3f4e8; color: #1e7a3d; font-weight: 600; }
    table.preview td.work { background: #dbeafe; color: #1e40af; font-weight: 600; }
    table.preview td.w0 { background: #dbeafe; color: #1e40af; font-weight: 700; }
    table.preview td.w1 { background: #fde68a; color: #92400e; font-weight: 700; }
    table.preview td.w2 { background: #e9d5ff; color: #6b21a8; font-weight: 700; }
    table.preview td.w3 { background: #fecdd3; color: #9f1239; font-weight: 700; }
    table.preview td.wm { background: #e5e7eb; color: #374151; font-weight: 700; }
    table.preview td.none { background: var(--holiday-bg); }
    table.editor td { cursor: pointer; user-select: none; }
    table.editor td:hover { outline: 2px solid var(--primary); outline-offset: -2px; }
    .full { grid-column: 1 / -1; }
    .small { font-size: 12px; }
  `,
})
export class RulesPage {
  private api = inject(ApiService);
  weekdaysShort = WEEKDAYS_SHORT;
  hours = shiftHours;
  describe = describeRule;
  preview = rulePreview;

  rules = signal<ScheduleRule[]>([]);
  error = signal('');
  form = signal<RuleForm | null>(null);
  editingId = signal<number | null>(null);
  editingWasDefault = signal(false);
  formError = signal('');

  constructor() {
    this.load();
  }

  load() {
    this.api.rules().subscribe({
      next: (r) => { this.rules.set(r); this.error.set(''); },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  weekCount(r: RuleShape) {
    return ruleWorkFlags(r).length / 7;
  }

  formShape(f: RuleForm): RuleShape {
    return { kind: f.kind, pattern: this.patternString(f), off_days: f.off_days, shift_days: f.shift_days };
  }
  private patternString(f: RuleForm) {
    return f.weeks.map((w) => w.map((on) => (on ? '1' : '0')).join('')).join(',');
  }
  hasWorkDay(f: RuleForm) {
    return f.kind !== 'pattern' || f.weeks.some((w) => w.some(Boolean));
  }

  toggleDay(f: RuleForm, week: number, day: number) {
    f.weeks[week][day] = !f.weeks[week][day];
  }
  setWeeks(f: RuleForm, n: number) {
    while (f.weeks.length < n) f.weeks.push(Array(7).fill(false));
    f.weeks.length = n;
  }
  mirror(f: RuleForm) {
    f.weeks[1] = f.weeks[0].map((on) => !on);
  }

  openNew() {
    this.editingId.set(null);
    this.editingWasDefault.set(false);
    this.formError.set('');
    this.form.set({
      name: '', kind: 'pattern', pattern: null, off_days: 2, shift_days: 2, stagger: true, start_time: null, end_time: null,
      is_default: false, note: '', fixedHours: false,
      weeks: [[true, false, false, true, false, true, false], [false, true, true, false, true, false, true]],
    });
  }

  openEdit(r: ScheduleRule) {
    const { id, ...rest } = r;
    this.editingId.set(id);
    this.editingWasDefault.set(r.is_default);
    this.formError.set('');
    const weeks = r.kind === 'pattern' ? patternWeeks(r) : [Array(7).fill(true), Array(7).fill(false)];
    this.form.set({ ...rest, note: rest.note ?? '', fixedHours: !!r.start_time, weeks });
  }

  save() {
    const f = this.form();
    if (!f) return;
    const { fixedHours, weeks, ...rest } = f;
    const payload: ScheduleRuleInput = {
      ...rest,
      name: rest.name.trim(),
      pattern: f.kind === 'pattern' ? this.patternString(f) : null,
      start_time: fixedHours ? rest.start_time || null : null,
      end_time: fixedHours ? rest.end_time || null : null,
      note: rest.note?.trim() || null,
    };
    const id = this.editingId();
    (id ? this.api.updateRule(id, payload) : this.api.createRule(payload)).subscribe({
      next: () => { this.form.set(null); this.load(); },
      error: (e) => this.formError.set(errorMessage(e)),
    });
  }

  makeDefault(r: ScheduleRule) {
    const { id, ...rest } = r;
    this.api.updateRule(id, { ...rest, is_default: true }).subscribe({
      next: () => this.load(),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  remove(r: ScheduleRule) {
    if (!confirm(`Delete rule "${r.name}"?`)) return;
    this.api.deleteRule(r.id).subscribe({ next: () => this.load(), error: (e) => this.error.set(errorMessage(e)) });
  }
}
