<template>
  <q-page class="q-pa-md">
    <div class="row items-center q-mb-md">
      <q-btn
        flat
        dense
        round
        color="primary"
        icon="arrow_back"
        aria-label="Back"
        @click="router.push('/settings')"
      />
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Move funds</div>
    </div>

    <q-card class="sattle-card q-pa-md">
      <!-- step 1: form -->
      <template v-if="step === 'form'">
        <div class="text-body2 text-grey-4 q-mb-md">
          Move sats from one mint to another. The mints talk to each other over Lightning - you just
          pick where from, where to, and how much.
        </div>

        <template v-if="sourceOptions.length">
          <q-select
            v-model="sourceServer"
            :options="sourceOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            dark
            outlined
            color="primary"
            label="From mint"
            class="q-mb-md"
          />

          <q-select
            v-model="targetChoice"
            :options="targetOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            dark
            outlined
            color="primary"
            label="To mint"
            class="q-mb-md"
          />

          <q-input
            v-if="targetChoice === CUSTOM_TARGET"
            v-model="customTarget"
            dark
            outlined
            color="primary"
            label="Target mint address"
            placeholder="mint@example.com, @example.com or lnurl1…"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="q-mb-md"
          />

          <div class="row items-end q-gutter-sm" :class="targetFeeText ? 'q-mb-xs' : 'q-mb-md'">
            <q-input
              v-model.number="amountSats"
              type="number"
              min="1"
              step="1"
              dark
              outlined
              color="primary"
              label="Amount"
              suffix="sats"
              class="col"
            />
            <q-btn
              flat
              dense
              no-caps
              color="primary"
              label="Max"
              :disable="!sourceServer"
              @click="setMax"
            />
          </div>
          <div v-if="targetFeeText" class="text-caption text-grey-5 q-mb-md">
            {{ targetFeeText }}
          </div>

          <q-banner v-if="inlineError" dense class="bg-negative text-white rounded-borders q-mb-md">
            {{ inlineError }}
          </q-banner>

          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Continue"
            class="full-width"
            :disable="!formFilled"
            @click="proceed"
          />
        </template>

        <div v-else class="text-grey-5">
          Nothing to move yet - receive some sats first, then come back.
        </div>
      </template>

      <!-- step 2: confirm -->
      <template v-else-if="step === 'confirm'">
        <q-list dense>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">Amount</q-item-label>
              <q-item-label class="text-h6 text-primary">{{ amountSats }} sats</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">From</q-item-label>
              <q-item-label class="text-grey-3">{{ sourceServer }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">To</q-item-label>
              <q-item-label class="text-grey-3" style="word-break: break-all">
                {{ targetInput }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
        <div class="text-caption text-grey-5 q-mt-md">
          The target mint may keep a small fee - you'll see exactly what it charged once the move
          completes.
        </div>
        <div class="row justify-end q-gutter-sm q-mt-lg">
          <q-btn flat no-caps label="Back" color="grey-5" @click="step = 'form'" />
          <q-btn unelevated color="primary" text-color="dark" label="Move now" @click="move" />
        </div>
      </template>

      <!-- step 3: in flight -->
      <template v-else-if="step === 'working'">
        <div class="column items-center">
          <q-spinner-dots size="48px" color="primary" class="q-my-md" />
          <div class="text-body1 text-primary">{{ stage }}</div>
          <div class="text-caption text-grey-5 q-mt-sm text-center">
            Confirming a move can take up to a couple of minutes - please keep this open.
          </div>
          <q-linear-progress indeterminate color="primary" class="q-mt-lg full-width" />
        </div>
      </template>

      <!-- step 4: outcome -->
      <template v-else-if="result">
        <div class="column items-center text-center">
          <template v-if="result.outcome === 'settled'">
            <q-icon name="check_circle" color="positive" size="64px" class="q-my-md" />
            <div class="text-h6 text-primary">
              Moved {{ result.requestedSats.toLocaleString() }} sats
            </div>
            <div class="text-caption text-grey-5 q-mt-sm">
              {{ result.sourceServer }} &rarr; {{ result.targetServer }}
            </div>
            <div class="text-caption text-grey-5 q-mt-sm">
              <template v-if="result.feeSats > 0">
                Mint fee paid: {{ result.feeSats.toLocaleString() }} sats
              </template>
              <template v-else>No fees were charged.</template>
            </div>
          </template>

          <template v-else-if="result.outcome === 'failed-funds-returned'">
            <q-icon name="warning" color="warning" size="64px" class="q-my-md" />
            <div class="text-h6 text-warning">Move failed</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              Nothing moved - the funds are back in your wallet at {{ result.sourceServer }}.
            </div>
          </template>

          <template v-else-if="result.outcome === 'unknown-still-pending'">
            <q-icon name="schedule" color="info" size="64px" class="q-my-md" />
            <div class="text-h6 text-info">Move still in flight</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The payment to {{ result.targetServer }} hasn't confirmed either way. The note on the
              source mint is locked - check later to see whether the move completed.
            </div>
            <div v-if="result.claimNoteValueSats" class="text-caption text-grey-5 q-mt-sm">
              If it settles, a note worth {{ result.claimNoteValueSats.toLocaleString() }} sats is
              waiting to be claimed at {{ result.targetServer }} - refreshing your wallet will pick
              it up.
            </div>
          </template>

          <template v-else-if="result.outcome === 'settled-claim-failed'">
            <q-icon name="error_outline" color="warning" size="64px" class="q-my-md" />
            <div class="text-h6 text-warning">Sats arrived, claim incomplete</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The {{ result.requestedSats.toLocaleString() }} sats reached
              {{ result.targetServer }}, but the wallet couldn't finish claiming the note.
              <template v-if="result.claimNoteValueSats">
                The note (worth {{ result.claimNoteValueSats.toLocaleString() }} sats) is saved
                unverified - refresh your wallet later to finish claiming it.
              </template>
              <template v-else> Refresh your wallet later to finish claiming it. </template>
            </div>
          </template>

          <template v-else>
            <q-icon name="error_outline" color="negative" size="64px" class="q-my-md" />
            <div class="text-h6 text-negative">Note already spent</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The note for this move was already spent at the mint - nothing was moved.
            </div>
          </template>

          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Done"
            class="q-mt-lg full-width"
            @click="router.push('/settings')"
          />
        </div>
      </template>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { useMoveFundsPage } from '@/composables/useMoveFundsPage';

const {
  CUSTOM_TARGET,
  amountSats,
  customTarget,
  formFilled,
  inlineError,
  move,
  proceed,
  result,
  router,
  setMax,
  sourceOptions,
  sourceServer,
  stage,
  step,
  targetChoice,
  targetFeeText,
  targetInput,
  targetOptions,
} = useMoveFundsPage();
</script>
