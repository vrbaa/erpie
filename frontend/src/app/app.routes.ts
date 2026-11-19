import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'calendar' },
  {
    path: 'calendar',
    canActivate: [authGuard],
    title: 'Schedule · Erpie',
    loadComponent: () => import('./pages/calendar/calendar.page').then((m) => m.CalendarPage),
  },
  {
    path: 'employees',
    canActivate: [authGuard],
    title: 'Employees · Erpie',
    loadComponent: () => import('./pages/employees/employees.page').then((m) => m.EmployeesPage),
  },
  {
    path: 'workdays',
    canActivate: [authGuard],
    title: 'Workdays · Erpie',
    loadComponent: () => import('./pages/workdays/workdays.page').then((m) => m.WorkdaysPage),
  },
  {
    path: 'absences',
    canActivate: [authGuard],
    title: 'Absences · Erpie',
    loadComponent: () => import('./pages/absences/absences.page').then((m) => m.AbsencesPage),
  },
  {
    path: 'rules',
    canActivate: [authGuard],
    title: 'Schedule rules · Erpie',
    loadComponent: () => import('./pages/rules/rules.page').then((m) => m.RulesPage),
  },
  {
    path: 'login',
    title: 'Log in · Erpie',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'users',
    title: 'Users · Erpie',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./pages/users/users.page').then((m) => m.UsersPage),
  },
  {
    path: 'account',
    title: 'Account · Erpie',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/account/account.page').then((m) => m.AccountPage),
  },
  { path: '**', redirectTo: 'calendar' },
];
