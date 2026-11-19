import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

interface UserForm {
  email: string;
  name: string;
  role: 'admin' | 'user';
  active: boolean;
  password: string;
}

@Component({
  selector: 'app-users',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-header">
      <h1>Users</h1>
      <div class="toolbar"><button class="primary" (click)="openNew()">+ New user</button></div>
    </div>

    @if (error()) { <div class="error">{{ error() }}</div> }

    <div class="card" style="padding:0">
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Sign-in</th><th>Last login</th><th></th></tr>
          </thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr>
                <td><strong>{{ u.name }}</strong> @if (u.id === auth.user()?.id) { <span class="muted" style="margin-left:4px">(you)</span> }</td>
                <td>{{ u.email }}</td>
                <td>@if (u.role === 'admin') { <span class="badge special">Admin</span> } @else { User }</td>
                <td>@if (u.active) { <span class="badge ok">Active</span> } @else { <span class="badge off">Inactive</span> }</td>
                <td>
                  @if (u.has_password) { <span class="badge off">Password</span> }
                  @if (u.has_google) { <span class="badge off">Google</span> }
                  @if (!u.has_password && !u.has_google) { <span class="muted">-</span> }
                </td>
                <td>{{ u.last_login_at ? (u.last_login_at | date: 'yyyy-MM-dd HH:mm') : 'Never' }}</td>
                <td class="actions">
                  <button class="small" (click)="openEdit(u)">Edit</button>
                  <button class="small danger" (click)="remove(u)">Delete</button>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="empty">No users.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (form(); as f) {
      <div class="backdrop" (click)="close()">
        <form class="modal" (click)="$event.stopPropagation()" (ngSubmit)="save()" #ngForm="ngForm">
          <div class="modal-head">
            <h2 style="margin:0">{{ editingId() ? 'Edit user' : 'New user' }}</h2>
            <button type="button" class="icon-btn" (click)="close()">×</button>
          </div>
          <div class="modal-body">
            @if (formError()) { <div class="error">{{ formError() }}</div> }
            <div class="form-grid">
              <div class="field"><label>Name *</label><input name="name" [(ngModel)]="f.name" required /></div>
              <div class="field"><label>Email *</label><input name="email" type="email" [(ngModel)]="f.email" required [disabled]="!!editingId()" /></div>
              <div class="field">
                <label>Role</label>
                <select name="role" [(ngModel)]="f.role">
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div class="field">
                <label>{{ editingId() ? 'New password' : 'Password' }}</label>
                <input name="password" type="password" autocomplete="new-password" [(ngModel)]="f.password" minlength="8"
                  [placeholder]="editingId() ? 'Leave empty to keep' : 'Optional - Google sign-in only if empty'" />
              </div>
              @if (editingId()) {
                <label class="check"><input type="checkbox" name="active" [(ngModel)]="f.active" /> Active (can log in)</label>
              }
            </div>
            <p class="muted">Passwords need at least 8 characters. Setting a password signs the user out everywhere.</p>
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
export class UsersPage {
  private api = inject(ApiService);
  auth = inject(AuthService);

  users = signal<User[]>([]);
  error = signal('');

  form = signal<UserForm | null>(null);
  editingId = signal<number | null>(null);
  formError = signal('');
  saving = signal(false);

  constructor() {
    this.load();
  }

  load() {
    this.api.users().subscribe({
      next: (list) => { this.users.set(list); this.error.set(''); },
      error: (err) => this.error.set(errorMessage(err)),
    });
  }

  openNew() {
    this.editingId.set(null);
    this.formError.set('');
    this.form.set({ email: '', name: '', role: 'user', active: true, password: '' });
  }

  openEdit(u: User) {
    this.editingId.set(u.id);
    this.formError.set('');
    this.form.set({ email: u.email, name: u.name, role: u.role, active: u.active, password: '' });
  }

  close() {
    this.form.set(null);
  }

  save() {
    const f = this.form();
    if (!f) return;
    const id = this.editingId();
    const password = f.password || null;
    const req = id
      ? this.api.updateUser(id, { name: f.name.trim(), role: f.role, active: f.active, password })
      : this.api.createUser({ email: f.email.trim(), name: f.name.trim(), role: f.role, password });
    this.saving.set(true);
    req.subscribe({
      next: () => {
        this.saving.set(false);
        this.close();
        this.load();
        if (id && id === this.auth.user()?.id) void this.auth.loadMe();
      },
      error: (err) => { this.saving.set(false); this.formError.set(errorMessage(err)); },
    });
  }

  remove(u: User) {
    if (!confirm(`Delete user ${u.name} (${u.email})? They will no longer be able to log in.`)) return;
    this.api.deleteUser(u.id).subscribe({
      next: () => this.load(),
      error: (err) => this.error.set(errorMessage(err)),
    });
  }
}
