<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Bell, ChevronDown, LogOut, Menu, Settings } from 'lucide-vue-next'
import NotificationPanel from './NotificationPanel.vue'
import { useNotifications } from '../../composables/useNotifications'
import { useProfile } from '../../composables/useProfile'

const props = defineProps({
  email: { type: String, default: '' },
})
const emit = defineEmits(['toggle-sidebar', 'sign-out'])

const menuOpen = ref(false)
const menuRoot = ref(null)

const bellOpen = ref(false)
const bellRoot = ref(null)

const { unreadCount, refresh, ensureLoaded } = useNotifications()
const { profile } = useProfile()

// The email is the fallback, not the source: it is all we have before the
// profile row arrives, and all we have if someone never filled their name in.
const handle = computed(() => props.email.split('@')[0] || 'there')
const nameFromEmail = computed(() =>
  handle.value
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' '),
)

const displayName = computed(
  () => profile.value?.fullName?.trim() || nameFromEmail.value,
)
const avatarUrl = computed(() => profile.value?.avatarUrl || '')

const initials = computed(
  () =>
    displayName.value
      .split(' ')
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || 'A',
)

function onDocumentClick(event) {
  if (menuRoot.value && !menuRoot.value.contains(event.target)) menuOpen.value = false
  if (bellRoot.value && !bellRoot.value.contains(event.target)) bellOpen.value = false
}

function onEscape(event) {
  if (event.key !== 'Escape') return
  menuOpen.value = false
  bellOpen.value = false
}

/** Opening the bell refetches — the feed is derived, so it goes stale quietly. */
function toggleBell() {
  bellOpen.value = !bellOpen.value
  menuOpen.value = false
  if (bellOpen.value) refresh()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onEscape)
  // The badge has to be right before anyone clicks it, so the first fetch does
  // not wait for the panel to open.
  ensureLoaded()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onEscape)
})
</script>

<template>
  <header
    class="sticky top-0 z-30 flex h-18 items-center gap-4 border-b border-slate-200 bg-white/85 px-5 backdrop-blur-xl sm:px-8"
  >
    <button
      type="button"
      class="grid size-10 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-ink lg:hidden"
      aria-label="Open navigation"
      @click="emit('toggle-sidebar')"
    >
      <Menu class="size-5" />
    </button>

    <div class="ml-auto flex items-center gap-2">
      <div ref="bellRoot" class="relative">
        <button
          type="button"
          class="relative grid size-10 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-ink"
          :class="bellOpen ? 'bg-slate-100 text-ink' : ''"
          :aria-label="
            unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'
          "
          :aria-expanded="bellOpen"
          @click="toggleBell"
        >
          <Bell class="size-5" />
          <span
            v-if="unreadCount"
            class="absolute top-1.5 right-1.5 grid min-w-4.5 place-items-center rounded-full bg-brand-600 px-1 text-[10px] leading-4.5 font-semibold text-white ring-2 ring-white"
          >
            {{ unreadCount > 9 ? '9+' : unreadCount }}
          </span>
        </button>

        <NotificationPanel v-model:open="bellOpen" />
      </div>

      <div ref="menuRoot" class="relative">
        <button
          type="button"
          class="flex items-center gap-2.5 rounded-xl py-1.5 pr-2 pl-1.5 transition hover:bg-slate-100"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          @click="menuOpen = !menuOpen; bellOpen = false"
        >
          <img
            v-if="avatarUrl"
            :src="avatarUrl"
            alt=""
            class="size-9 shrink-0 rounded-lg object-cover"
          />
          <span
            v-else
            class="grid size-9 place-items-center rounded-lg bg-linear-to-br from-brand-500 to-brand-700 text-xs font-semibold text-white"
          >
            {{ initials }}
          </span>
          <span class="hidden text-left sm:block">
            <span class="block text-sm font-medium text-ink">{{ displayName }}</span>
            <span class="block max-w-40 truncate text-xs text-slate-400">{{ email }}</span>
          </span>
          <ChevronDown class="size-4 text-slate-400 transition" :class="menuOpen ? 'rotate-180' : ''" />
        </button>

        <div
          v-show="menuOpen"
          role="menu"
          class="absolute right-0 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card"
        >
          <div class="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
            <img
              v-if="avatarUrl"
              :src="avatarUrl"
              alt=""
              class="size-9 shrink-0 rounded-lg object-cover"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-ink">{{ displayName }}</p>
              <p class="truncate text-xs text-slate-400">{{ email }}</p>
            </div>
          </div>
          <RouterLink
            to="/portal/settings"
            role="menuitem"
            class="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50"
            @click="menuOpen = false"
          >
            <Settings class="size-4 text-slate-400" />
            Account settings
          </RouterLink>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2.5 border-t border-slate-100 px-4 py-2.5 text-sm text-red-600 transition hover:bg-red-50"
            @click="menuOpen = false; emit('sign-out')"
          >
            <LogOut class="size-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  </header>
</template>
