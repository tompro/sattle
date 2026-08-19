<template>
  <q-layout view="hHh lpR fFf">
    <q-header class="app-header">
      <q-toolbar class="header-toolbar row items-center justify-center">
        <img :src="sattleWallet" alt="sattle wallet" class="brand-logo" />
        <img :src="sattleText" alt="sattle" class="brand-wordmark" />
        <q-btn
          flat
          dense
          round
          color="primary"
          icon="menu"
          aria-label="Settings"
          class="menu-btn"
          @click="$router.push('/settings')"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <!-- mobile-first app: on wide screens keep the whole UI in a
           centered phone-width column so the flex proportions and
           420px-capped rows stay coherent -->
      <div class="app-shell">
        <router-view />
      </div>
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import sattleWallet from '@/assets/sattle-wallet.png';
import sattleText from '@/assets/sattle-text.png';
</script>

<style lang="scss" scoped>
.app-header {
  // same fixed gradient as the body (see app.scss): fully opaque, but
  // visually indistinguishable from the page background, so scrolled
  // content slides underneath without a visible header bar or border
  background: linear-gradient(160deg, #001616 0%, #002222 55%, #001a1a 100%);
  background-attachment: fixed;
}

.header-toolbar {
  position: relative;
  min-height: 56px;
  padding-top: 6px;
  padding-bottom: 4px;
}

.brand-logo {
  height: 36px;
  width: auto;
}

.brand-wordmark {
  height: 22px;
  width: auto;
  margin-left: 10px;
}

.menu-btn {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
}

.app-shell {
  max-width: 500px;
  margin: 0 auto;
}
</style>
