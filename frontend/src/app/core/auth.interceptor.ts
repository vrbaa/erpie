import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const EXEMPT = ['/api/auth/me', '/api/auth/login', '/api/auth/google'];

/** Any 401 from the API means the session ended: go back to the login page. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err) => {
      const path = req.url.split('?')[0];
      if (err instanceof HttpErrorResponse && err.status === 401 && path.startsWith('/api/') && !EXEMPT.includes(path)) {
        auth.user.set(null);
        if (!router.url.startsWith('/login')) {
          router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
        }
      }
      return throwError(() => err);
    }),
  );
};
