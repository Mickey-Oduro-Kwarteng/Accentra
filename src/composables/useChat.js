import { ref } from 'vue';
import { supabase } from '@/lib/supabaseClient'; // your existing client

export function useChat() {
  const messages = ref([]);
  const sessionId = ref(null);
  const loading = ref(false);

  async function sendMessage(text) {
    messages.value.push({ role: 'user', content: text });
    loading.value = true;

    const { data: { session } } = await supabase.auth.getSession();

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          sessionId: sessionId.value,
          message: text,
        }),
      }
    );

    const data = await res.json();
    sessionId.value = data.sessionId;
    messages.value.push({ role: 'assistant', content: data.reply });
    loading.value = false;
  }

  return { messages, sendMessage, loading };
}