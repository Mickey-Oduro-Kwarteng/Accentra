<script setup>
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { X } from 'lucide-vue-next'

// Module-level: shared by every dialog, because they share one page behind them.
let openDialogs = 0

/**
 * The dialog every modal in this folder is built on.
 *
 * Handles the parts that are easy to get subtly wrong — focus capture and
 * restore, Esc, backdrop clicks, and locking the page behind it — so each form
 * only has to worry about its own fields.
 *
 * `busy` blocks every dismissal route while a save is in flight; closing
 * mid-insert would leave the user unsure whether the row landed.
 */
const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  size: { type: String, default: 'md' }, // sm | md | lg | xl
  busy: { type: Boolean, default: false },
})

const open = defineModel('open', { type: Boolean, default: false })

const WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
}

const id = useId()
const panel = ref(null)
let lastFocused = null

/**
 * How many dialogs are open, across every instance.
 *
 * Dialogs nest — a row's actions list opens an edit form on top of itself — and
 * they all share one body. A flag would let the inner one closing unlock the
 * page behind the outer one, leaving the backdrop scrolling. `locked` is
 * per-instance so the count only ever moves on a real change, which keeps an
 * unmount of a dialog that was never opened from decrementing someone else's.
 */
let locked = false

function lockScroll(next) {
  if (next === locked) return
  locked = next
  openDialogs = Math.max(0, openDialogs + (next ? 1 : -1))
  document.body.style.overflow = openDialogs > 0 ? 'hidden' : ''
}

function close() {
  if (props.busy) return
  open.value = false
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }

  // Focus trap. Tab out of either end of the panel and you land back inside it.
  if (event.key !== 'Tab' || !panel.value) return

  const focusable = panel.value.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  if (!focusable.length) return

  const first = focusable[0]
  const last = focusable[focusable.length - 1]

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(open, async (isOpen) => {
  lockScroll(isOpen)

  if (isOpen) {
    lastFocused = document.activeElement
    await nextTick()
    // The first field, not the close button — the user came here to type.
    const target = panel.value?.querySelector(
      'input:not([type="hidden"]), select, textarea',
    )
    ;(target ?? panel.value)?.focus()
  } else {
    lastFocused?.focus?.()
    lastFocused = null
  }
})

onBeforeUnmount(() => lockScroll(false))
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 backdrop-blur-[2px]"
        @keydown="onKeydown"
        @mousedown.self="close"
      >
        <!-- `.self` on both: a click that lands on the backdrop or on the
             padding around the panel dismisses, one inside the panel does not. -->
        <div
          class="flex min-h-full items-end justify-center p-0 sm:items-center sm:p-6"
          @mousedown.self="close"
        >
          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
            leave-active-class="transition duration-150 ease-in"
            leave-to-class="translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95"
            appear
          >
            <div
              v-if="open"
              ref="panel"
              role="dialog"
              aria-modal="true"
              :aria-labelledby="`${id}-title`"
              tabindex="-1"
              class="w-full rounded-t-2xl bg-white shadow-2xl outline-none sm:rounded-2xl"
              :class="WIDTHS[size] ?? WIDTHS.md"
            >
              <header
                class="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5"
              >
                <div class="min-w-0">
                  <h2 :id="`${id}-title`" class="text-base font-semibold text-ink">
                    {{ title }}
                  </h2>
                  <p v-if="subtitle" class="mt-1 text-sm text-slate-500">{{ subtitle }}</p>
                </div>
                <button
                  type="button"
                  :disabled="busy"
                  class="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-ink disabled:opacity-40"
                  aria-label="Close"
                  @click="close"
                >
                  <X class="size-4.5" />
                </button>
              </header>

              <div class="max-h-[70vh] overflow-y-auto px-6 py-5">
                <slot />
              </div>

              <footer
                v-if="$slots.footer"
                class="flex flex-wrap items-center justify-end gap-2.5 rounded-b-2xl border-t border-slate-100 bg-slate-50/60 px-6 py-4"
              >
                <slot name="footer" :close="close" />
              </footer>
            </div>
          </Transition>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
