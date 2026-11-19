import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-account',
  imports: [FormsModule],
  template: `
    <div class="page-header"><h1>Account</h1></div>

    <div class="card account-card">
      <div class="who">
        <strong>{{ auth.user()?.name }}</strong>
        <span class="muted">{{ auth.user()?.email }}</span>
      </div>
      <h2>{{ auth.user()?.has_password ? 'Change password' : 'Set a password' }}</h2>

      <form (ngSubmit)="save()" #f="ngForm">
        @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
        @if (done()) { <div class="notice">Password updated.</div> }
        @if (auth.user()?.has_password) {
          <div class="field">
            <label for="current">Current password</label>
            <input id="current" name="current" type="password" autocomplete="current-password" [(ngModel)]="current" required />
          </div>
        }
        <div class="field">
          <label for="next">New password (at least 8 characters)</label>
          <input id="next" name="next" type="password" autocomplete="new-password" [(ngModel)]="next" minlength="8" required />
        </div>
        <div class="field">
          <label for="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autocomplete="new-password" [(ngModel)]="confirm" required />
        </div>
        <div><button type="submit" class="primary" [disabled]="busy() || f.invalid">{{ busy() ? 'Saving…' : 'Save password' }}</button></div>
      </form>
    </div>
  `,
  styles: `
    .account-card { max-width: 420px; }
    .who { display: flex; flex-direction: column; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
    form { display: flex; flex-direction: column; gap: 14px; }
    .error, .notice { margin-bottom: 0; }
  `,
})
export class AccountPage {
  auth = inject(AuthService);

  current = '';
  next = '';
  confirm = '';
  busy = signal(false);
  error = signal('');
  done = signal(false);

  save() {
    this.done.set(false);
    if (this.next !== this.confirm) {
      this.error.set('The new passwords do not match');
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const current = this.auth.user()?.has_password ? this.current : null;
    this.auth.changePassword(current, this.next).subscribe({
      next: () => {
        this.busy.set(false);
        this.done.set(true);
        this.current = this.next = this.confirm = '';
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
