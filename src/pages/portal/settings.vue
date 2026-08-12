<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import ConfirmDialog from '../../components/modals/ConfirmDialog.vue'
import UploadAvatarModal from '../../components/modals/UploadAvatarModal.vue'
import AsyncState from '../../components/portal/AsyncState.vue'
import PageHeader from '../../components/portal/PageHeader.vue'
import SettingsSkeleton from '../../components/skeletons/SettingsSkeleton.vue'
import FormField from '../../components/ui/FormField.vue'
import { useAuth } from '../../composables/useAuth'
import { useOrganization } from '../../composables/useOrganization'
import { usePortalData } from '../../composables/usePortalData'
import { useProfile } from '../../composables/useProfile'
import {
  getSettingsPageData,
  removeAvatar,
  updateCompanySettings,
  updateNotificationPreference,
  updateProfile,
} from '../../services/settingsService'
import { initials } from '../../utils/format'
import { notificationPrefs, settingsTabs } from '../../utils/samplesData'

const { user } = useAuth()
const { ensureOrganization } = useOrganization()
// The topbar renders from this same record, so every write below has to reach
// it — otherwise the photo changes here and nowhere else until a reload.
const { profile: sharedProfile, refreshProfile, setProfile } = useProfile()

const activeTab = ref('profile')
const email = computed(() => user.value?.email ?? '')
const avatarUrl = computed(() => sharedProfile.value?.avatarUrl ?? '')

const { data, loading, error, refresh } = usePortalData((orgId) =>
  getSettingsPageData(orgId, user.value.id),
)

// Editable copies. Seeded from the fetch rather than bound to it directly, so
// an in-progress edit is not clobbered by a background refresh.
const profile = reactive({ fullName: '', jobTitle: '', phone: '' })
const company = reactive({ name: '', registration: '', vat: '', address: '' })
const prefs = reactive({})

watch(data, (loaded) => {
  if (!loaded) return
  // Only the three editable fields — the avatar is not on this form, and
  // copying it in would let a stale URL ride along on the next save.
  profile.fullName = loaded.profile.fullName
  profile.jobTitle = loaded.profile.jobTitle
  profile.phone = loaded.profile.phone
  setProfile(loaded.profile)
  Object.assign(company, loaded.company.form)
  // Default to off for any key with no row yet.
  notificationPrefs.forEach((pref) => {
    prefs[pref.key] = loaded.notifications[pref.key] ?? { email: false, push: false }
  })
})

const saving = ref(false)
const saveError = ref(null)
const savedMessage = ref('')

const showUploadAvatar = ref(false)
const showRemoveAvatar = ref(false)

/**
 * Confirmation is worth seeing and not worth keeping. Left on screen it becomes
 * furniture, and the next save has nothing new to show. The timer is cleared
 * first so a second save restarts the four seconds rather than inheriting what
 * was left of the first.
 */
const SAVED_MESSAGE_MS = 4000
let savedTimer = null

function flashSaved(message) {
  saveError.value = null
  savedMessage.value = message
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    savedMessage.value = ''
  }, SAVED_MESSAGE_MS)
}

onBeforeUnmount(() => clearTimeout(savedTimer))

/**
 * Refetch the profile, not the whole page: the upload wrote the new URL itself,
 * so neither this page nor the topbar is holding it. Nothing else on the page
 * reads that row, and the form fields the page did fetch have not changed.
 */
function onAvatarChanged(message) {
  flashSaved(message)
  refreshProfile(user.value.id).catch((caught) => {
    saveError.value = caught
  })
}

async function saveProfile() {
  saving.value = true
  saveError.value = null
  try {
    await updateProfile(user.value.id, profile)
    setProfile({
      fullName: profile.fullName,
      jobTitle: profile.jobTitle,
      phone: profile.phone,
    })
    flashSaved('Profile saved')
  } catch (caught) {
    saveError.value = caught
  } finally {
    saving.value = false
  }
}

async function saveCompany() {
  saving.value = true
  saveError.value = null
  try {
    const orgId = await ensureOrganization()
    await updateCompanySettings(orgId, company)
    flashSaved('Company details saved')
  } catch (caught) {
    saveError.value = caught
  } finally {
    saving.value = false
  }
}

/**
 * Toggles write through immediately — there is no save button on this tab, so
 * the switch itself is the commit. On failure the switch reverts, so the UI
 * never claims a preference that did not persist.
 */
async function toggleChannel(key, channel) {
  const next = { ...prefs[key], [channel]: !prefs[key]?.[channel] }
  prefs[key] = next
  saveError.value = null
  try {
    const orgId = await ensureOrganization()
    await updateNotificationPreference(user.value.id, orgId, key, next)
  } catch (caught) {
    prefs[key] = { ...next, [channel]: !next[channel] }
    saveError.value = caught
  }
}
</script>

<template>
  <div>
    <PageHeader title="Settings" subtitle="Your account and your company details." />

    <AsyncState
      class="mt-7 block"
      :loading="loading"
      :error="error"
      @retry="refresh"
    >
      <template #skeleton><SettingsSkeleton /></template>

      <div class="grid gap-6 lg:grid-cols-[220px_1fr]">
        <!-- Section nav -->
        <nav class="lg:sticky lg:top-24 lg:self-start">
          <ul class="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            <li v-for="tab in settingsTabs" :key="tab.key" class="shrink-0 lg:shrink">
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition"
                :class="
                  activeTab === tab.key
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-ink'
                "
                :aria-current="activeTab === tab.key ? 'page' : undefined"
                @click="activeTab = tab.key"
              >
                <component
                  :is="tab.icon"
                  class="size-[18px] shrink-0"
                  :class="activeTab === tab.key ? 'text-brand-600' : 'text-slate-400'"
                />
                {{ tab.label }}
              </button>
            </li>
          </ul>
        </nav>

        <div>
          <p
            v-if="saveError"
            class="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {{ saveError.message }}
          </p>
          <p
            v-else-if="savedMessage"
            class="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
            role="status"
          >
            {{ savedMessage }}
          </p>

          <!-- Profile -->
          <section v-if="activeTab === 'profile'" class="space-y-6">
            <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 class="text-base font-semibold text-ink">Your profile</h2>
              <p class="mt-1 text-sm text-slate-500">
                This is how you appear to the rest of the team.
              </p>

              <div class="mt-6 flex flex-wrap items-center gap-5 border-b border-slate-100 pb-6">
                <img
                  v-if="avatarUrl"
                  :src="avatarUrl"
                  alt="Your profile photo"
                  class="size-16 rounded-2xl object-cover"
                />
                <span
                  v-else
                  class="grid size-16 place-items-center rounded-2xl bg-linear-to-br from-brand-500 to-brand-700 text-lg font-semibold text-white"
                >
                  {{ initials(profile.fullName || email) }}
                </span>
                <div class="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    class="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-slate-50"
                    @click="showUploadAvatar = true"
                  >
                    Upload photo
                  </button>
                  <button
                    type="button"
                    :disabled="!avatarUrl"
                    class="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                    @click="showRemoveAvatar = true"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <UploadAvatarModal
                v-model:open="showUploadAvatar"
                @uploaded="onAvatarChanged('Photo updated')"
              />

              <ConfirmDialog
                v-model:open="showRemoveAvatar"
                title="Remove your photo?"
                message="Your initials will be shown instead."
                confirm-label="Remove photo"
                tone="danger"
                :action="() => removeAvatar(user.id)"
                @confirmed="onAvatarChanged('Photo removed')"
              />

              <form class="mt-6 grid gap-5 sm:grid-cols-2" @submit.prevent="saveProfile">
                <FormField v-model="profile.fullName" label="Full name" autocomplete="name" />
                <FormField
                  v-model="profile.jobTitle"
                  label="Job title"
                  autocomplete="organization-title"
                />
                <FormField
                  :model-value="email"
                  label="Email address"
                  type="email"
                  hint="Change this from your account security settings."
                  autocomplete="email"
                />
                <FormField v-model="profile.phone" label="Phone" type="tel" autocomplete="tel" />
              </form>
            </div>

            <div class="flex justify-end gap-2.5">
              <button
                type="button"
                class="rounded-xl px-5 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100"
                @click="refresh"
              >
                Cancel
              </button>
              <button
                type="button"
                :disabled="saving"
                class="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                @click="saveProfile"
              >
                {{ saving ? 'Saving…' : 'Save changes' }}
              </button>
            </div>
          </section>

          <!-- Company -->
          <section v-else-if="activeTab === 'company'" class="space-y-6">
            <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 class="text-base font-semibold text-ink">Company details</h2>
              <p class="mt-1 text-sm text-slate-500">
                These appear on every invoice and filing-ready export.
              </p>

              <form class="mt-6 grid gap-5 sm:grid-cols-2" @submit.prevent="saveCompany">
                <FormField v-model="company.name" label="Legal name" autocomplete="organization" />
                <FormField v-model="company.registration" label="Registration number" />
                <FormField v-model="company.vat" label="VAT number" />
                <FormField
                  v-model="company.address"
                  label="Registered address"
                  autocomplete="street-address"
                />
              </form>
            </div>

            <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 class="text-base font-semibold text-ink">Financial year</h2>
              <p class="mt-1 text-sm text-slate-500">
                Determines how periods are grouped in every report.
              </p>
              <dl class="mt-5 grid gap-5 sm:grid-cols-3">
                <div v-for="entry in data?.company?.financialYear ?? []" :key="entry.label">
                  <dt class="text-xs text-slate-500">{{ entry.label }}</dt>
                  <dd class="mt-1 text-sm font-semibold text-ink">{{ entry.value }}</dd>
                </div>
              </dl>
            </div>

            <div class="flex justify-end">
              <button
                type="button"
                :disabled="saving"
                class="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/20 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                @click="saveCompany"
              >
                {{ saving ? 'Saving…' : 'Save changes' }}
              </button>
            </div>
          </section>

          <!-- Notifications -->
          <section v-else-if="activeTab === 'notifications'">
            <div class="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <header class="border-b border-slate-100 px-6 py-5">
                <h2 class="text-base font-semibold text-ink">Notifications</h2>
                <p class="mt-1 text-sm text-slate-500">
                  Choose what reaches you by email and what pushes to your devices.
                  Changes save as you toggle.
                </p>
              </header>

              <ul>
                <li
                  v-for="pref in notificationPrefs"
                  :key="pref.key"
                  class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-50 px-6 py-5 last:border-0"
                >
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-ink">{{ pref.label }}</p>
                    <p class="mt-0.5 text-sm text-slate-500">{{ pref.body }}</p>
                  </div>

                  <div class="flex items-center gap-6">
                    <label
                      v-for="channel in ['email', 'push']"
                      :key="channel"
                      class="flex cursor-pointer items-center gap-2.5"
                    >
                      <span class="text-xs font-medium text-slate-500 capitalize">{{ channel }}</span>
                      <!-- Checkbox-backed switch: the input stays keyboard and
                           screen-reader accessible, the span is the visual. -->
                      <span class="relative inline-flex">
                        <input
                          type="checkbox"
                          class="peer sr-only"
                          :checked="prefs[pref.key]?.[channel] ?? false"
                          :aria-label="`${pref.label} — ${channel}`"
                          @change="toggleChannel(pref.key, channel)"
                        />
                        <span
                          class="block h-6 w-11 rounded-full bg-slate-200 transition peer-checked:bg-brand-600 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-100"
                        ></span>
                        <span
                          class="pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition peer-checked:translate-x-5"
                        ></span>
                      </span>
                    </label>
                  </div>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </div>
    </AsyncState>
  </div>
</template>
