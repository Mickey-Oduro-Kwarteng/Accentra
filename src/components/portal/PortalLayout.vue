<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PortalSidebar from './PortalSidebar.vue'
import PortalTopbar from './PortalTopbar.vue'
import { useAuth } from '../../composables/useAuth'
import { useOrganization } from '../../composables/useOrganization'
import { useProfile } from '../../composables/useProfile'

// Rendered as the parent of every /portal route, so the sidebar and topbar
// mount once and survive navigation between pages.
const router = useRouter()
const { user, signOut } = useAuth()
const { ensureProfile, resetProfile } = useProfile()
const { resetOrganization } = useOrganization()

const STORAGE_KEY = 'accentra:sidebar-collapsed'

const sidebarOpen = ref(false)
const collapsed = ref(localStorage.getItem(STORAGE_KEY) === 'true')

watch(collapsed, (value) => localStorage.setItem(STORAGE_KEY, String(value)))

const email = computed(() => user.value?.email ?? '')

/**
 * Fetch the profile once the session is known, so the topbar has a name and a
 * photo to show. A failure is swallowed on purpose — the topbar falls back to
 * the email, and a missing profile row is not worth a page-level error over.
 */
watch(
  () => user.value?.id,
  (id) => {
    if (id) ensureProfile(id).catch(() => {})
  },
  { immediate: true },
)

async function onSignOut() {
  await signOut()
  // Both caches are module-level and would otherwise follow the next person who
  // signs in on this tab into their own portal.
  resetProfile()
  resetOrganization()
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-slate-50">
    <PortalSidebar
      :open="sidebarOpen"
      :collapsed="collapsed"
      @close="sidebarOpen = false"
      @toggle-collapsed="collapsed = !collapsed"
    />

    <div class="transition-[padding] duration-300" :class="collapsed ? 'lg:pl-20' : 'lg:pl-72'">
      <PortalTopbar
        :email="email"
        @toggle-sidebar="sidebarOpen = !sidebarOpen"
        @sign-out="onSignOut"
      />

      <main class="px-5 py-8 sm:px-8">
        <RouterView v-slot="{ Component }">
          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 translate-y-1"
            leave-active-class="transition duration-100 ease-in"
            leave-to-class="opacity-0"
            mode="out-in"
          >
            <component :is="Component" />
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>
</template>
