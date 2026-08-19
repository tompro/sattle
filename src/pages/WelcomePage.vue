<template>
  <q-page class="column items-center justify-center q-pa-md">
    <div class="text-h3 text-weight-bold text-primary">sattle</div>
    <div class="text-subtitle1 text-grey-5 q-mt-sm q-mb-xl text-center">
      A wallet for lnurlcash bearer notes.
    </div>

    <!-- onboarding placeholder: create/restore flows land in M4 -->
    <q-btn
      unelevated
      color="secondary"
      text-color="primary"
      label="Create wallet"
      class="full-width q-mb-sm onboarding-btn"
      disable
    />
    <q-btn
      outline
      color="primary"
      label="Restore wallet"
      class="full-width onboarding-btn"
      disable
    />
  </q-page>
</template>

<script setup lang="ts"></script>

<style lang="scss" scoped>
.onboarding-btn {
  max-width: 320px;
  border-radius: 8px;
}
</style>
