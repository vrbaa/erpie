import { Component, ElementRef, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

/** Minimal typing for the parts of Google Identity Services used here. */
interface GoogleId {
  accounts: {
    id: {
      initialize(config: { client_id: string; callback: (resp: { credential: string }) => void; ux_mode?: string }): void;
      renderButton(el: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

let gsiPromise: Promise<GoogleId> | null = null;
function loadGsi(): Promise<GoogleId> {
  const existing = (window as any).google as GoogleId | undefined;
  if (existing?.accounts?.id) return Promise.resolve(existing);
  gsiPromise ??= new Promise<GoogleId>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => resolve((window as any).google as GoogleId);
    script.onerror = () => {
      gsiPromise = null;
      script.remove();
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.appendChild(script);
  });
  return gsiPromise;
}

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand"><span class="brand-mark">E</span> Erpie</div>
        <h1>Log in</h1>
        <p class="muted login-sub">Staff schedule and hours for the caffe bar.</p>

        <form (ngSubmit)="submit()" #f="ngForm" novalidate>
          @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" [(ngModel)]="email" required autofocus [disabled]="busy()" />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" [(ngModel)]="password" required [disabled]="busy()" />
          </div>
          <button type="submit" class="primary login-submit" [disabled]="busy() || !email.trim() || !password">
            @if (busy()) { Logging in… } @else { Log in }
          </button>
        </form>

        @if (googleClientId()) {
          <div class="divider"><span>or</span></div>
          <div class="google-slot" #googleBtn></div>
        }
      </div>
    </div>
  `,
  styles: `
    .login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); }
    .login-card {
      width: min(400px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 32px 28px 28px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    .login-brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 600; margin-bottom: 24px; }
    .login-brand .brand-mark { color: #fff; }
    h1 { font-size: 22px; }
    .login-sub { margin: 4px 0 20px; }
    form { display: flex; flex-direction: column; gap: 14px; }
    .field input { padding: 9px 10px; }
    .error { margin-bottom: 0; }
    .login-submit { padding: 10px 12px; font-weight: 600; margin-top: 4px; }
    .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0 16px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .google-slot { display: flex; justify-content: center; min-height: 40px; overflow: hidden; }
    @media (max-width: 480px) { .login-card { padding: 24px 18px 20px; } }
  `,
})
export class LoginPage implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  email = '';
  password = '';
  busy = signal(false);
  error = signal('');
  googleClientId = signal<string | null>(null);

  private googleBtn = viewChild<ElementRef<HTMLElement>>('googleBtn');

  constructor() {
    // render the Google button once its slot exists in the DOM
    effect(() => {
      const el = this.googleBtn()?.nativeElement;
      const clientId = this.googleClientId();
      if (el && clientId) void this.setupGoogle(el, clientId);
    });
  }

  ngOnInit() {
    this.auth.config().subscribe({
      next: (cfg) => {
        this.googleClientId.set(cfg.google_client_id);
      },
      error: () => this.googleClientId.set(null),
    });
  }

  private async setupGoogle(el: HTMLElement, clientId: string) {
    try {
      const google = await loadGsi();
      google.accounts.id.initialize({
        client_id: clientId,
        ux_mode: 'popup',
        callback: (resp) => this.googleLogin(resp.credential),
      });
      const width = Math.min(400, Math.max(200, Math.round(el.getBoundingClientRect().width)));
      google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', width });
    } catch {
      this.googleClientId.set(null);
    }
  }

  private googleLogin(credential: string) {
    this.busy.set(true);
    this.error.set('');
    this.auth.loginWithGoogle(credential).subscribe({
      next: () => this.done(),
      error: (err) => this.fail(err, true),
    });
  }

  submit() {
    if (this.busy() || !this.email.trim() || !this.password) return;
    this.busy.set(true);
    this.error.set('');
    this.auth.login(this.email.trim(), this.password).subscribe({
      next: () => this.done(),
      error: (err) => this.fail(err, false),
    });
  }

  private done() {
    this.busy.set(false);
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    this.router.navigateByUrl(returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/calendar');
  }

  private fail(err: any, google: boolean) {
    this.busy.set(false);
    if (err?.status === 429) this.error.set('Too many attempts, try again later');
    else if (err?.status === 401) this.error.set('Invalid email or password');
    else if (err?.status === 403 && google) this.error.set(errorMessage(err));
    else this.error.set(errorMessage(err));
  }
}
