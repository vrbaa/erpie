import { Component, computed, inject, input, output, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ABSENCE_SHORT, Absence, ApiService, DayInfo, Employee, Shift, ShiftInput, absenceIcon, errorMessage } from '../core/api.service';
import { formatDate, shiftHours } from '../core/dates';

/** Dialog listing all shifts of one day, with add / edit / delete. */
@Component({
  selector: 'app-day-dialog',
  imports: [FormsModule],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="modal" (click)="$event.stopPropagation()">
        <div class="modal-head">
          <div>
            <h2 style="margin:0">{{ fmt(day().date) }}</h2>
            <div class="muted" style="margin-top:4px">
              @if (day().closed) { <span class="badge off">Closed</span> }
              @else { Working hours {{ day().open_time }} – {{ day().close_time }} }
              @if (day().is_holiday) { <span class="badge holiday">Holiday</span> }
              @if (day().special && !day().is_holiday && !day().closed) { <span class="badge special">Special</span> }
              @if (day().note) { · {{ day().note }} }
            </div>
          </div>
          <button type="button" class="icon-btn" (click)="closed.emit()">×</button>
        </div>
        <div class="modal-body">
          @if (error()) { <div class="error">{{ error() }}</div> }

          @if (absences().length) {
            <div class="absent-list">
              <strong>Absent:</strong>
              @for (a of absences(); track a.id) {
                <button type="button" class="small absence-badge" [attr.data-kind]="a.kind" (click)="editAbsence.emit(a)" title="Edit absence">
                  {{ icon(a.kind) }} {{ empName(a.employee_id) }} · {{ short[a.kind] }}
                </button>
              }
            </div>
          }

          <table class="grid" style="margin-bottom:16px">
            <thead><tr><th>Employee</th><th>Shift</th><th>Hours</th><th>Note</th><th></th></tr></thead>
            <tbody>
              @for (s of dayShifts(); track s.id) {
                <tr [class.editing]="editId() === s.id">
                  <td><span class="dot" [style.background]="emp(s.employee_id)?.color"></span> {{ empName(s.employee_id) }}</td>
                  <td>{{ s.start_time }} – {{ s.end_time }}</td>
                  <td>{{ s.hours }}</td>
                  <td>{{ s.note }}</td>
                  <td class="actions">
                    <button class="small" (click)="edit(s)">Edit</button>
                    <button class="small danger" (click)="remove(s)">Delete</button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="empty">Nobody scheduled.</td></tr>
              }
            </tbody>
            @if (dayShifts().length) {
              <tfoot><tr><td colspan="2"><strong>Total</strong></td><td><strong>{{ total() }}</strong></td><td colspan="2"></td></tr></tfoot>
            }
          </table>

          <form class="card" style="margin:0;background:#f8f9fb" (ngSubmit)="save()" #f="ngForm">
            <h2>{{ editId() ? 'Edit shift' : 'Add employee to this day' }}</h2>
            <div class="form-grid">
              <div class="field full">
                <label>Employee *</label>
                <select name="employee" [(ngModel)]="model.employee_id" required>
                  <option [ngValue]="null" disabled>Select employee…</option>
                  @for (e of selectableEmployees(); track e.id) {
                    <option [ngValue]="e.id" [disabled]="!!absenceOf(e.id)">{{ e.first_name }} {{ e.last_name }}{{ e.position ? ' · ' + e.position : '' }}{{ absenceOf(e.id) ? ' (' + short[absenceOf(e.id)!.kind] + ')' : isScheduled(e.id) ? ' (already scheduled)' : '' }}</option>
                  }
                </select>
              </div>
              <div class="field"><label>Start *</label><input type="time" name="start" [(ngModel)]="model.start_time" required /></div>
              <div class="field"><label>End * <span class="muted">({{ hours(model.start_time, model.end_time) }} h)</span></label><input type="time" name="end" [(ngModel)]="model.end_time" required /></div>
              <div class="field full"><label>Note</label><input name="note" [(ngModel)]="model.note" /></div>
            </div>
            <div class="toolbar" style="margin-top:12px">
              <button type="button" (click)="useDayHours()">Use full day hours</button>
              <button type="button" (click)="addAbsence.emit(model.employee_id)" title="Sick leave, vacation, …">+ Absence…</button>
              <span style="flex:1"></span>
              @if (editId()) { <button type="button" (click)="resetForm()">Cancel edit</button> }
              <button type="submit" class="primary" [disabled]="f.invalid || !model.employee_id">{{ editId() ? 'Save shift' : 'Add shift' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `,
  styles: `
    tr.editing td { background: #eef4fb; }
    .absent-list { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
  `,
})
export class DayDialogComponent implements OnInit {
  private api = inject(ApiService);
  fmt = formatDate;
  hours = shiftHours;

  day = input.required<DayInfo>();
  shifts = input.required<Shift[]>(); // shifts of this day
  employees = input.required<Employee[]>();
  editShiftId = input<number | null>(null);
  presetEmployeeId = input<number | null>(null);
  absences = input<Absence[]>([]); // absences on this day

  changed = output<void>();
  addAbsence = output<number | null>(); // preset employee id
  editAbsence = output<Absence>();
  closed = output<void>();

  error = signal('');
  editId = signal<number | null>(null);
  localShifts = signal<Shift[] | null>(null);
  model: { employee_id: number | null; start_time: string; end_time: string; note: string } = {
    employee_id: null, start_time: '', end_time: '', note: '',
  };

  dayShifts = computed(() => this.localShifts() ?? this.shifts());
  total = computed(() => Math.round(this.dayShifts().reduce((a, s) => a + s.hours, 0) * 100) / 100);
  selectableEmployees = computed(() => this.employees().filter((e) => e.active || this.dayShifts().some((s) => s.employee_id === e.id)));

  ngOnInit() {
    this.resetForm();
    const id = this.editShiftId();
    const s = id ? this.shifts().find((x) => x.id === id) : undefined;
    if (s) this.edit(s);
    else if (this.presetEmployeeId()) this.model.employee_id = this.presetEmployeeId();
  }

  short = ABSENCE_SHORT;
  icon = absenceIcon;

  absenceOf(id: number) {
    return this.absences().find((a) => a.employee_id === id);
  }

  emp(id: number) {
    return this.employees().find((e) => e.id === id);
  }
  empName(id: number) {
    const e = this.emp(id);
    return e ? `${e.first_name} ${e.last_name}` : '?';
  }
  isScheduled(id: number) {
    return this.dayShifts().some((s) => s.employee_id === id && s.id !== this.editId());
  }

  useDayHours() {
    this.model.start_time = this.day().open_time;
    this.model.end_time = this.day().close_time;
  }

  resetForm() {
    this.editId.set(null);
    this.model = { employee_id: null, start_time: this.day().open_time, end_time: this.day().close_time, note: '' };
  }

  edit(s: Shift) {
    this.editId.set(s.id);
    this.model = { employee_id: s.employee_id, start_time: s.start_time, end_time: s.end_time, note: s.note ?? '' };
  }

  save() {
    if (!this.model.employee_id) return;
    const payload: ShiftInput = {
      employee_id: this.model.employee_id,
      date: this.day().date,
      start_time: this.model.start_time,
      end_time: this.model.end_time,
      note: this.model.note.trim() || null,
    };
    const id = this.editId();
    (id ? this.api.updateShift(id, payload) : this.api.createShift(payload)).subscribe({
      next: (saved) => {
        const list = this.dayShifts().filter((s) => s.id !== saved.id);
        this.localShifts.set([...list, saved].sort((a, b) => a.start_time.localeCompare(b.start_time)));
        this.error.set('');
        this.resetForm();
        this.changed.emit();
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  remove(s: Shift) {
    if (!confirm(`Remove ${this.empName(s.employee_id)} (${s.start_time}–${s.end_time}) from this day?`)) return;
    this.api.deleteShift(s.id).subscribe({
      next: () => {
        this.localShifts.set(this.dayShifts().filter((x) => x.id !== s.id));
        if (this.editId() === s.id) this.resetForm();
        this.changed.emit();
      },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }
}
