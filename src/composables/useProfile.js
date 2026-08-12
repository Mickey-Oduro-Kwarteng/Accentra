import { readonly, ref } from 'vue'
import { getProfile } from '../services/settingsService'

/**
 * The signed-in user's own profile row.
 *
 * Module-level state, like useAuth and useOrganization, because the settings
 * form and the topbar avatar are the same record shown twice. Saving in one
 * place has to be visible in the other on the same tick — the topbar mounts
 * once for the whole portal and never remounts, so nothing else would make it
 * notice.
 */
const profile = ref(null)
const loading = ref(false)
const error = ref(null)

let loadedFor = null
let pending = null

async function load(userId) {
  loading.value = true
  error.value = null

  try {
    profile.value = await getProfile(userId)
    loadedFor = userId
    return profile.value
  } catch (caught) {
    error.value = caught
    // Drop the cache so a retry actually retries.
    loadedFor = null
    throw caught
  } finally {
    loading.value = false
    pending = null
  }
}

export function useProfile() {
  /** Fetches once per user; later calls resolve from the cache. */
  function ensureProfile(userId) {
    if (!userId) return Promise.resolve(null)
    if (loadedFor === userId && profile.value) return Promise.resolve(profile.value)
    if (!pending) pending = load(userId)
    return pending
  }

  /** Refetch after a write that this module did not make itself. */
  function refreshProfile(userId) {
    if (!userId) return Promise.resolve(null)
    pending = load(userId)
    return pending
  }

  /**
   * Merge a saved patch into the shared copy. The row that came back from the
   * update is already the truth, so the topbar should not have to wait for a
   * second round trip to show it.
   */
  function setProfile(patch) {
    profile.value = { ...(profile.value ?? {}), ...patch }
  }

  /** Call on sign-out — the next user must not inherit this one's photo. */
  function resetProfile() {
    profile.value = null
    error.value = null
    loadedFor = null
    pending = null
  }

  return {
    profile: readonly(profile),
    loading: readonly(loading),
    error: readonly(error),
    ensureProfile,
    refreshProfile,
    setProfile,
    resetProfile,
  }
}
