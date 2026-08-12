import { readonly, ref } from 'vue'
import { supabase } from '../lib/supabaseClient'

// Module-level state so every component shares one session, and the
// onAuthStateChange listener is registered exactly once.
const session = ref(null)
const user = ref(null)
// True until the initial session has been read out of storage, so views can
// avoid flashing the login screen at an already-signed-in user on reload.
const loading = ref(true)

let initialized = false

function setSession(next) {
  session.value = next
  user.value = next?.user ?? null
}

function init() {
  if (initialized) return
  initialized = true

  supabase.auth
    .getSession()
    .then(({ data }) => setSession(data.session))
    .finally(() => {
      loading.value = false
    })

  // Keep this callback synchronous. Awaiting other supabase.auth calls inside
  // it can deadlock the client's internal lock.
  supabase.auth.onAuthStateChange((_event, nextSession) => {
    setSession(nextSession)
    loading.value = false
  })
}

export function useAuth() {
  init()

  async function signUp(email, password) {
    return await supabase.auth.signUp({ email: email.trim(), password })
  }

  async function signInWithPassword(email, password) {
    return await supabase.auth.signInWithPassword({ email: email.trim(), password })
  }

  async function signOut() {
    return await supabase.auth.signOut()
  }

  return {
    session: readonly(session),
    user: readonly(user),
    loading: readonly(loading),
    signUp,
    signInWithPassword,
    signOut,
  }
}
