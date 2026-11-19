import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (auth.user(); as user) {
      <div class="shell">
        <aside class="sidebar">
          <div class="brand"><span class="brand-mark">E</span> Erpie</div>
          <nav>
            <a routerLink="/calendar" routerLinkActive="active">📅 Schedule</a>
            <a routerLink="/employees" routerLinkActive="active">👥 Employees</a>
            <a routerLink="/absences" routerLinkActive="active">🏖 Absences</a>
            <a routerLink="/rules" routerLinkActive="active">📐 Schedule rules</a>
            <a routerLink="/workdays" routerLinkActive="active">🕑 Workdays</a>
            @if (auth.isAdmin()) {
              <a routerLink="/users" routerLinkActive="active">👤 Users</a>
            }
          </nav>
          <div class="sidebar-foot">
            <div class="user-name" [title]="user.email">{{ user.name }}</div>
            <div class="user-links">
              <a routerLink="/account" routerLinkActive="active">Change password</a>
              <button type="button" class="link-btn" (click)="logout()">Log out</button>
            </div>
            <div class="foot-note">Caffe bar · staff &amp; hours</div>
          </div>
        </aside>
        <main class="content">
          <router-outlet />
        </main>
      </div>
    } @else {
      <router-outlet />
    }
  `,
})
export class App {
  auth = inject(AuthService);
  private router = inject(Router);

  async logout() {
    await this.auth.logout();
    this.router.navigate(['/login']);
  }
}
