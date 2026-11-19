import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { User } from './api.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private base = '/api/auth';

  user = signal<User | null>(null);
  isAdmin = computed(() => this.user()?.role === 'admin');

  /** Loads the current session; a 401 (or any failure) just means logged out. */
  async loadMe(): Promise<void> {
    try {
      this.user.set(await firstValueFrom(this.http.get<User>(`${this.base}/me`)));
    } catch {
      this.user.set(null);
    }
  }

  config() {
    return this.http.get<{ google_client_id: string | null }>(`${this.base}/config`);
  }

  login(email: string, password: string) {
    return this.http.post<User>(`${this.base}/login`, { email, password }).pipe(tap((u) => this.user.set(u)));
  }

  loginWithGoogle(credential: string) {
    return this.http.post<User>(`${this.base}/google`, { credential }).pipe(tap((u) => this.user.set(u)));
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post<void>(`${this.base}/logout`, {}));
    } catch {
      /* the session is gone either way */
    }
    (window as any).google?.accounts?.id?.disableAutoSelect();
    this.user.set(null);
  }

  changePassword(currentPassword: string | null, newPassword: string) {
    return this.http
      .put<void>(`${this.base}/password`, { current_password: currentPassword, new_password: newPassword })
      .pipe(tap(() => this.user.update((u) => (u ? { ...u, has_password: true } : u))));
  }
}
