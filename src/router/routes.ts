import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', component: () => import('@/pages/IndexPage.vue') },
      { path: 'settings', component: () => import('@/pages/SettingsPage.vue') },
      {
        path: 'settings/backup',
        component: () => import('@/pages/BackupPage.vue'),
      },
      {
        path: 'settings/security',
        component: () => import('@/pages/SecurityPage.vue'),
      },
      {
        path: 'settings/mints',
        component: () => import('@/pages/ManageMintsPage.vue'),
      },
      {
        path: 'settings/move',
        component: () => import('@/pages/MoveFundsPage.vue'),
      },
      {
        path: 'settings/nwc',
        component: () => import('@/pages/NwcPage.vue'),
      },
    ],
  },
  {
    path: '/welcome',
    component: () => import('@/layouts/BlankLayout.vue'),
    children: [{ path: '', component: () => import('@/pages/WelcomePage.vue') }],
  },

  // Always leave this as last one,
  // but you can also remove it
  {
    path: '/:catchAll(.*)*',
    component: () => import('@/pages/ErrorNotFound.vue'),
  },
];

export default routes;
