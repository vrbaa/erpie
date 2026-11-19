import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, SpecialDay, SpecialDayInput, WeekdayHours, errorMessage } from '../../core/api.service';
import { WEEKDAYS, formatDate, shiftHours, toIso } from '../../core/dates';

@Component({
  selector: 'app-workdays',
  imports: [FormsModule],
  template: `
    <div class="page-header"><h1>Workdays</h1></div>
    @if (error()) { <div class="error">{{ error() }}</div> }

    <div class="layout">
      <div class="card">
        <h2>Regular working hours</h2>
        <p class="muted">Default opening hours for each day of the week. A closing time earlier than the opening time (e.g. 00:00) means the bar closes after midnight.</p>
        <table class="grid">
          <thead><tr><th>Day</th><th>Open</th><th>Close</th><th>Hours</th><th>Closed</th></tr></thead>
          <tbody>
            @for (w of weekly(); track w.weekday) {
              <tr>
                <td><strong>{{ weekdays[w.weekday] }}</strong></td>
                <td><input type="time" [(ngModel)]="w.open_time" [disabled]="w.closed" /></td>
                <td><input type="time" [(ngModel)]="w.close_time" [disabled]="w.closed" /></td>
                <td class="muted">{{ w.closed ? '–' : hours(w.open_time, w.close_time) + ' h' }}</td>
                <td><input type="checkbox" [(ngModel)]="w.closed" /></td>
              </tr>
            }
          </tbody>
        </table>
        <div class="toolbar" style="margin-top:12px">
          <button (click)="applyMondayToAll()">Copy Monday to all days</button>
          <span style="flex:1"></span>
          @if (weeklySaved()) { <span class="badge ok">Saved</span> }
          <button class="primary" (click)="saveWeekly()">Save working hours</button>
        </div>
      </div>

      <div class="card">
        <h2>Business info</h2>
        <p class="muted">Shown as “Poslodavac” on the exported timesheet.</p>
        <div class="toolbar">
          <input style="flex:1" [(ngModel)]="companyName" placeholder="Company name" />
        </div>
        <p class="muted">Hours per absence day (vacation, sick leave, …) written to the timesheet. Not counted on closed days and public holidays.</p>
        <div class="toolbar">
          <input type="number" min="0" max="24" step="0.5" style="width:90px" [(ngModel)]="absenceHours" /> h / day
          <span style="flex:1"></span>
          @if (settingsSaved()) { <span class="badge ok">Saved</span> }
          <button class="primary" (click)="saveSettings()">Save</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="page-header" style="margin-bottom:8px">
        <h2 style="margin:0">Special days</h2>
        <div class="toolbar">
          <label class="check"><input type="checkbox" [(ngModel)]="showPast" (ngModelChange)="loadSpecial()" /> Show past</label>
          <button class="primary" (click)="openNew()">+ Add special day</button>
        </div>
      </div>
      <p class="muted">Different hours for a specific date — special occasions (e.g. 10:00–00:00), public holidays, or days when the bar is closed.</p>
      <table class="grid">
        <thead><tr><th>Date</th><th>Hours</th><th>Type</th><th>Note</th><th></th></tr></thead>
        <tbody>
          @for (s of specialDays(); track s.id) {
            <tr>
              <td><strong>{{ fmt(s.date) }}</strong></td>
              <td>{{ s.closed ? 'Closed' : s.open_time + ' – ' + s.close_time + ' (' + hours(s.open_time, s.close_time) + ' h)' }}</td>
              <td>
                @if (s.closed) { <span class="badge off">Closed</span> }
                @if (s.is_holiday) { <span class="badge holiday">Holiday</span> }
                @if (!s.closed && !s.is_holiday) { <span class="badge special">Special</span> }
              </td>
              <td>{{ s.note }}</td>
              <td class="actions">
                <button class="small" (click)="openEdit(s)">Edit</button>
                <button class="small danger" (click)="removeSpecial(s)">Delete</button>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="empty">No special days.</td></tr>
          }
        </tbody>
      </table>
    </div>

    @if (form(); as f) {
      <div class="backdrop" (click)="form.set(null)">
        <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="saveSpecial()" #ngForm="ngForm">
          <div class="modal-head">
            <h2 style="margin:0">{{ editingId() ? 'Edit special day' : 'New special day' }}</h2>
            <button type="button" class="icon-btn" (click)="form.set(null)">×</button>
          </div>
          <div class="modal-body">
            @if (formError()) { <div class="error">{{ formError() }}</div> }
            <div class="form-grid">
              <div class="field full"><label>Date *</label><input type="date" name="date" [(ngModel)]="f.date" required /></div>
              <div class="field"><label>Open</label><input type="time" name="open" [(ngModel)]="f.open_time" [disabled]="f.closed" required /></div>
              <div class="field"><label>Close</label><input type="time" name="close" [(ngModel)]="f.close_time" [disabled]="f.closed" required /></div>
              <label class="check"><input type="checkbox" name="closed" [(ngModel)]="f.closed" /> Bar is closed this day</label>
              <label class="check"><input type="checkbox" name="holiday" [(ngModel)]="f.is_holiday" /> Public holiday (blagdan)</label>
              <div class="field full"><label>Note</label><input name="note" [(ngModel)]="f.note" placeholder="e.g. Concert, New Year's Eve" /></div>
            </div>
          </div>
          <div class="modal-foot">
            <button type="button" (click)="form.set(null)">Cancel</button>
            <button type="submit" class="primary" [disabled]="ngForm.invalid">Save</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: `
    .layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .layout .card { margin-bottom: 0; }
    .layout + .card { margin-top: 16px; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class WorkdaysPage {
  private api = inject(ApiService);
  weekdays = WEEKDAYS;
  fmt = formatDate;
  hours = shiftHours;

  error = signal('');
  weekly = signal<WeekdayHours[]>([]);
  weeklySaved = signal(false);
  specialDays = signal<SpecialDay[]>([]);
  showPast = false;
  companyName = '';
  absenceHours = 8;
  settingsSaved = signal(false);

  form = signal<SpecialDayInput | null>(null);
  editingId = signal<number | null>(null);
  formError = signal('');

  constructor() {
    this.api.weekly().subscribe({ next: (w) => this.weekly.set(w), error: (e) => this.error.set(errorMessage(e)) });
    this.api.settings().subscribe((s) => {
      this.companyName = s.company_name;
      this.absenceHours = s.absence_hours;
    });
    this.loadSpecial();
  }

  loadSpecial() {
    const start = this.showPast ? undefined : toIso(new Date());
    this.api.specialDays(start).subscribe({
      next: (s) => this.specialDays.set(s),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  applyMondayToAll() {
    const mon = this.weekly()[0];
    if (!mon) return;
    this.weekly.set(this.weekly().map((w) => ({ ...w, open_time: mon.open_time, close_time: mon.close_time, closed: mon.closed })));
  }

  saveWeekly() {
    this.api.saveWeekly(this.weekly()).subscribe({
      next: (w) => { this.weekly.set(w); this.flash(this.weeklySaved); },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  saveSettings() {
    this.api.saveSettings({ company_name: this.companyName.trim(), absence_hours: Number(this.absenceHours) || 0 }).subscribe({
      next: () => this.flash(this.settingsSaved),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  openNew() {
    this.editingId.set(null);
    this.formError.set('');
    this.form.set({ date: toIso(new Date()), open_time: '10:00', close_time: '00:00', closed: false, is_holiday: false, note: '' });
  }

  openEdit(s: SpecialDay) {
    const { id, ...rest } = s;
    this.editingId.set(id);
    this.formError.set('');
    this.form.set({ ...rest });
  }

  saveSpecial() {
    const f = this.form();
    if (!f) return;
    const payload = { ...f, note: f.note?.trim() || null };
    const id = this.editingId();
    (id ? this.api.updateSpecialDay(id, payload) : this.api.createSpecialDay(payload)).subscribe({
      next: () => { this.form.set(null); this.loadSpecial(); },
      error: (e) => this.formError.set(errorMessage(e)),
    });
  }

  removeSpecial(s: SpecialDay) {
    if (!confirm(`Remove special hours for ${formatDate(s.date)}? The regular hours will apply again.`)) return;
    this.api.deleteSpecialDay(s.id).subscribe({ next: () => this.loadSpecial(), error: (e) => this.error.set(errorMessage(e)) });
  }

  private flash(sig: ReturnType<typeof signal<boolean>>) {
    sig.set(true);
    setTimeout(() => sig.set(false), 2000);
  }
}
