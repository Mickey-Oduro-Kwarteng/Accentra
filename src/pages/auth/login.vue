<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthLayout from '../../components/auth/AuthLayout.vue'
import FormField from '../../components/ui/FormField.vue'
import { useAuth } from '../../composables/useAuth'

const router = useRouter()
const route = useRoute()
const { signInWithPassword } = useAuth()

const email = ref('')
const password = ref('')
const remember = ref(true)
const submitting = ref(false)
const formError = ref('')

const points = [
  'Bank-grade encryption on every transaction',
  'Real-time ledgers your whole team can trust',
  'One-click exports for VAT, payroll and audits',
]

async function onSubmit() {
  formError.value = ''
  submitting.value = true
  try {
    const { error } = await signInWithPassword(email.value, password.value)
    if (error) {
      formError.value = error.message
      return
    }
    // Honour ?redirect= when the guard bounced them here from a private page.
    const redirect = route.query.redirect
    router.push(typeof redirect === 'string' ? redirect : '/portal/dashboard')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout
    eyebrow="Welcome back"
    headline="Your books, balanced before the coffee goes cold."
    subhead="Sign in to pick up exactly where you left off — reconciliations, invoices and reports, all in one ledger."
    :points="points"
  >
    <header class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight text-ink">Sign in</h1>
      <p class="mt-2 text-[15px] text-slate-500">
        New to Accentra?
        <RouterLink
          to="/signup"
          class="font-medium text-brand-600 underline-offset-4 hover:underline"
        >
          Create an account
        </RouterLink>
      </p>
    </header>

    <form class="space-y-5" novalidate @submit.prevent="onSubmit">
      <p
        v-if="formError"
        class="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        role="alert"
      >
        <svg viewBox="0 0 24 24" class="mt-0.5 size-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5M12 16.2h.01" stroke-linecap="round" />
        </svg>
        {{ formError }}
      </p>

      <FormField
        v-model="email"
        label="Email address"
        type="email"
        placeholder="you@company.com"
        autocomplete="email"
        required
      />

      <div>
        <FormField
          v-model="password"
          label="Password"
          type="password"
          placeholder="••••••••"
          autocomplete="current-password"
          required
        />
        <div class="mt-3 flex items-center justify-between">
          <label class="flex cursor-pointer items-center gap-2.5 text-sm text-slate-600">
            <input
              v-model="remember"
              type="checkbox"
              class="size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Keep me signed in
          </label>
          <a
            href="#"
            class="text-sm font-medium text-brand-600 underline-offset-4 hover:underline"
          >
            Forgot password?
          </a>
        </div>
      </div>

      <button
        type="submit"
        :disabled="submitting"
        class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          v-if="submitting"
          class="size-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity=".25" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
        </svg>
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <p class="mt-8 flex items-center justify-center gap-2 text-xs text-slate-400">
      <svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
        <path d="M8 10.5V8a4 4 0 1 1 8 0v2.5" />
      </svg>
      Secured with 256-bit TLS · SOC 2 Type II
    </p>
  </AuthLayout>
</template>
