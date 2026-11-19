import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Employee, EmployeeInput, errorMessage } from '../../core/api.service';

const PALETTE = ['#4f7cac', '#d1495b', '#2e933c', '#edae49', '#8e5ea2', '#00798c', '#e07a5f', '#3d405b'];

function emptyEmployee(index: number): EmployeeInput {
  return {
    first_name: '', last_name: '', oib: '', position: '', phone: '', email: '',
    employment_start: null, color: PALETTE[index % PALETTE.length], active: true, notes: '',
  };
}

@Component({
  selector: 'app-employees',
  imports: [FormsModule],
  template: `
    <div class="page-header">
      <h1>Employees</h1>
      <div class="toolbar">
        <input type="search" placeholder="Search…" [ngModel]="search()" (ngModelChange)="search.set($event)" />
        <label class="check"><input type="checkbox" [ngModel]="showInactive()" (ngModelChange)="showInactive.set($event)" /> Show inactive</label>
        <button class="primary" (click)="openNew()">+ New employee</button>
      </div>
    </div>

    @if (error()) { <div class="error">{{ error() }}</div> }

    <div class="card" style="padding:0">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr><th></th><th>Name</th><th>Position</th><th>OIB</th><th>Phone</th><th>Email</th><th>Start date</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            @for (e of filtered(); track e.id) {
              <tr>
                <td><span class="dot" [style.background]="e.color"></span></td>
                <td><strong>{{ e.last_name }}</strong> {{ e.first_name }}</td>
                <td>{{ e.position }}</td>
                <td>{{ e.oib }}</td>
                <td>{{ e.phone }}</td>
                <td>{{ e.email }}</td>
                <td>{{ e.employment_start }}</td>
                <td>
                  @if (e.active) { <span class="badge ok">Active</span> } @else { <span class="badge off">Inactive</span> }
                </td>
                <td class="actions">
                  <button class="small" (click)="openEdit(e)">Edit</button>
                  <button class="small danger" (click)="remove(e)">Delete</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="9" class="empty">No employees yet. Click “New employee” to add one.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (form(); as f) {
      <div class="backdrop" (click)="close()">
        <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="save()" #ngForm="ngForm">
          <div class="modal-head">
            <h2 style="margin:0">{{ editingId() ? 'Edit employee' : 'New employee' }}</h2>
            <button type="button" class="icon-btn" (click)="close()">×</button>
          </div>
          <div class="modal-body">
            @if (formError()) { <div class="error">{{ formError() }}</div> }
            <div class="form-grid">
              <div class="field"><label>First name *</label><input name="first_name" [(ngModel)]="f.first_name" required /></div>
              <div class="field"><label>Last name *</label><input name="last_name" [(ngModel)]="f.last_name" required /></div>
              <div class="field"><label>OIB</label><input name="oib" [(ngModel)]="f.oib" maxlength="11" pattern="\\d{11}" placeholder="11 digits" /></div>
              <div class="field"><label>Position</label><input name="position" [(ngModel)]="f.position" placeholder="e.g. Waiter, Barista" /></div>
              <div class="field"><label>Phone</label><input name="phone" [(ngModel)]="f.phone" /></div>
              <div class="field"><label>Email</label><input name="email" type="email" [(ngModel)]="f.email" /></div>
              <div class="field"><label>Employment start</label><input name="employment_start" type="date" [(ngModel)]="f.employment_start" /></div>
              <div class="field"><label>Calendar color</label><input name="color" type="color" [(ngModel)]="f.color" /></div>
              <div class="field full"><label>Notes</label><textarea name="notes" rows="3" [(ngModel)]="f.notes"></textarea></div>
              <label class="check"><input type="checkbox" name="active" [(ngModel)]="f.active" /> Active employee</label>
            </div>
          </div>
          <div class="modal-foot">
            <button type="button" (click)="close()">Cancel</button>
            <button type="submit" class="primary" [disabled]="ngForm.invalid || saving()">Save</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class EmployeesPage {
  private api = inject(ApiService);

  employees = signal<Employee[]>([]);
  search = signal('');
  showInactive = signal(true);
  error = signal('');

  form = signal<EmployeeInput | null>(null);
  editingId = signal<number | null>(null);
  formError = signal('');
  saving = signal(false);

  filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.employees().filter(
      (e) =>
        (this.showInactive() || e.active) &&
        (!q || `${e.first_name} ${e.last_name} ${e.position ?? ''} ${e.oib ?? ''}`.toLowerCase().includes(q)),
    );
  });

  constructor() {
    this.load();
  }

  load() {
    this.api.employees().subscribe({
      next: (list) => { this.employees.set(list); this.error.set(''); },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  openNew() {
    this.editingId.set(null);
    this.formError.set('');
    this.form.set(emptyEmployee(this.employees().length));
  }

  openEdit(e: Employee) {
    const { id, ...rest } = e;
    this.editingId.set(id);
    this.formError.set('');
    this.form.set({ ...rest });
  }

  close() {
    this.form.set(null);
  }

  save() {
    const f = this.form();
    if (!f) return;
    // send empty optional strings as null
    const payload: EmployeeInput = {
      ...f,
      oib: f.oib?.trim() || null,
      position: f.position?.trim() || null,
      phone: f.phone?.trim() || null,
      email: f.email?.trim() || null,
      notes: f.notes?.trim() || null,
      employment_start: f.employment_start || null,
    };
    const id = this.editingId();
    const req = id ? this.api.updateEmployee(id, payload) : this.api.createEmployee(payload);
    this.saving.set(true);
    req.subscribe({
      next: () => { this.saving.set(false); this.close(); this.load(); },
      error: (err) => { this.saving.set(false); this.formError.set(errorMessage(err)); },
    });
  }

  remove(e: Employee) {
    if (!confirm(`Delete ${e.first_name} ${e.last_name}? All their shifts will be deleted too.\n\nTip: to keep history, edit the employee and uncheck "Active" instead.`)) return;
    this.api.deleteEmployee(e.id).subscribe({
      next: () => this.load(),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }
}
