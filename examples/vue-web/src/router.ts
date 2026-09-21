// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import HomeView from './views/HomeView.vue';

// History mode, NOT hash mode. installNavigationCrumbs patches
// history.pushState/replaceState and listens for popstate; a hash-only router
// changes neither pathname nor search and emits no crumbs at all. The
// router-crumbs spec pins both halves of that.
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/specimens', name: 'specimens', component: () => import('./views/SpecimensView.vue') },
  {
    path: '/specimens/:id',
    name: 'specimen',
    component: () => import('./views/SpecimenDetailView.vue'),
  },
  { path: '/log', name: 'log', component: () => import('./views/LogView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
];

export const router = createRouter({ history: createWebHistory(), routes });
