<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="bg-transparent">
      <q-toolbar>
        <q-toolbar-title class="text-weight-bold">sattle</q-toolbar-title>
        <q-btn
          flat
          dense
          round
          icon="settings"
          aria-label="Settings"
          @click="$router.push('/settings')"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts"></script>
