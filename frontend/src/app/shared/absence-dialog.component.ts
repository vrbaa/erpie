import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ABSENCE_KINDS, Absence, AbsenceInput, ApiService, Employee, errorMessage } from '../core/api.service';
import { diffDays } from '../core/dates';

/** Add / edit / delete one absence (sick leave, vacation, ...). */
@Component({
  selector: 'app-absence-dialog',
  imports: [FormsModule],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="save()" #f="ngForm">
        <div class="modal-head">
          <h2 style="margin:0">{{ absence() ? 'Edit absence' : 'New absence' }}</h2>
          <button type="button" class="icon-btn" (click)="closed.emit()">×</button>
        </div>
        <div class="modal-body">
          @if (error()) { <div class="error">{{ error() }}</div> }
          <div class="form-grid">
            <div class="field full">
              <label>Employee *</label>
              <select name="employee" [(ngModel)]="model.employee_id" required>
                <option [ngValue]="null" disabled>Select employee…</option>
                @for (e of selectable(); track e.id) {
                  <option [ngValue]="e.id">{{ e.first_name }} {{ e.last_name }}</option>
                }
              </select>
            </div>
            <div class="field full">
              <label>Type *</label>
              <div class="kinds">
                @for (k of kinds; track k.kind) {
                  <label class="kind" [class.selected]="model.kind === k.kind" [attr.data-kind]="k.kind">
                    <input type="radio" name="kind" [value]="k.kind" [(ngModel)]="model.kind" /> {{ k.icon }} {{ k.label }}
                  </label>
                }
              </div>
            </div>
            <div class="field"><label>From *</label><input type="date" name="start" [(ngModel)]="model.start_date" (ngModelChange)="syncEnd()" required /></div>
            <div class="field"><label>To * <span class="muted">({{ days() }} {{ days() === 1 ? 'day' : 'days' }})</span></label><input type="date" name="end" [(ngModel)]="model.end_date" [min]="model.start_date" required /></div>
            <div class="field full"><label>Note</label><input name="note" [(ngModel)]="model.note" placeholder="e.g. doctor's note no." /></div>
          </div>
          <p class="muted">Shifts of this employee in the chosen period are removed automatically.</p>
        </div>
        <div class="modal-foot">
          @if (absence()) { <button type="button" class="danger" (click)="remove()">Delete</button> }
          <span style="flex:1"></span>
          <button type="button" (click)="closed.emit()">Cancel</button>
          <button type="submit" class="primary" [disabled]="f.invalid || !model.employee_id || days() < 1">Save</button>
        </div>
      </form>
    </div>
  `,
  styles: `
    .kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .kind { border: 1px solid var(--border); border-radius: var(--radius); padding: 5px 10px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    .kind input { display: none; }
    .kind.selected { border-color: var(--primary); background: #eef4fb; font-weight: 600; }
  `,
})
export class AbsenceDialogComponent implements OnInit {
  private api = inject(ApiService);
  kinds = ABSENCE_KINDS;

  employees = input.required<Employee[]>();
  absence = input<Absence | null>(null);
  presetDate = input<string | null>(null);
  presetEmployeeId = input<number | null>(null);

  saved = output<Absence>();
  deleted = output<void>();
  closed = output<void>();

  error = signal('');
  model: { employee_id: number | null; kind: AbsenceInput['kind']; start_date: string; end_date: string; note: string } = {
    employee_id: null, kind: 'vacation', start_date: '', end_date: '', note: '',
  };

  selectable = computed(() => {
    const a = this.absence();
    return this.employees().filter((e) => e.active || e.id === a?.employee_id);
  });

  days() {
    if (!this.model.start_date || !this.model.end_date) return 0;
    return diffDays(this.model.start_date, this.model.end_date) + 1;
  }

  ngOnInit() {
    const a = this.absence();
    if (a) {
      this.model = { employee_id: a.employee_id, kind: a.kind, start_date: a.start_date, end_date: a.end_date, note: a.note ?? '' };
    } else {
      const d = this.presetDate() ?? '';
      this.model = { employee_id: this.presetEmployeeId(), kind: 'vacation', start_date: d, end_date: d, note: '' };
    }
  }

  syncEnd() {
    if (!this.model.end_date || this.model.end_date < this.model.start_date) this.model.end_date = this.model.start_date;
  }

  save() {
    if (!this.model.employee_id) return;
    const payload: AbsenceInput = {
      employee_id: this.model.employee_id,
      kind: this.model.kind,
      start_date: this.model.start_date,
      end_date: this.model.end_date,
      note: this.model.note.trim() || null,
    };
    const a = this.absence();
    (a ? this.api.updateAbsence(a.id, payload) : this.api.createAbsence(payload)).subscribe({
      next: (saved) => this.saved.emit(saved),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  remove() {
    const a = this.absence();
    if (!a || !confirm('Delete this absence?')) return;
    this.api.deleteAbsence(a.id).subscribe({
      next: () => this.deleted.emit(),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }
}
