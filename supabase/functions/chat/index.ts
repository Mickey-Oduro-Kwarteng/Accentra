import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.27.0';

// ============================================
// CORS HEADERS — adjust origin for production
// ============================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // lock this down to your domain in production
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================
// CLIENTS
// ============================================
const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY')!,
});

const MODEL = 'claude-sonnet-4-5-20250929'; // update to whichever model you have access to
const MAX_HISTORY_MESSAGES = 20;

// ============================================
// SYSTEM PROMPT — customize this for your use case
// ============================================
const SYSTEM_PROMPT = `You are a helpful customer support assistant for [Your Company Name].

Guidelines:
- Be friendly, concise, and professional.
- If you don't know the answer, say so honestly instead of guessing.
- If a user needs to check an order status, use the provided tool.
- Keep responses under 150 words unless the user asks for more detail.
- If a request is outside your scope (e.g. legal, medical, or requires a human), say you'll connect them with a team member.`;

// ============================================
// EXAMPLE TOOL — connect this to your real Supabase tables
// ============================================
const tools = [
  {
    name: 'check_order_status',
    description:
      'Look up the status of a customer order by order ID. Use this whenever a user asks about their order, shipment, or delivery status.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID, e.g. "ORD-12345"',
        },
      },
      required: ['order_id'],
    },
  },
];

// Replace this with a real query against your own `orders` table
async function checkOrderStatus(supabase: any, orderId: string) {
  const { data, error } = await supabase
    .from('orders') // <-- your real orders table
    .select('status, eta')
    .eq('order_id', orderId)
    .single();

  if (error || !data) {
    return { error: `No order found with ID ${orderId}` };
  }
  return data;
}

async function executeTool(supabase: any, toolName: string, toolInput: any) {
  switch (toolName) {
    case 'check_order_status':
      return await checkOrderStatus(supabase, toolInput.order_id);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ============================================
// MAIN HANDLER
// ============================================
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Create a Supabase client scoped to the requesting user's auth token
    // (this respects your Row Level Security policies automatically)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    const { sessionId, message } = await req.json();

    if (!message || typeof message !== 'string' || message.length > 4000) {
      return new Response(JSON.stringify({ error: 'Invalid message' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get the current user (null if anonymous / no auth header)
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Create a session if none was provided
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const { data: newSession, error: sessionError } = await supabase
        .from('chat_sessions')
        .insert({ user_id: user?.id ?? null })
        .select('id')
        .single();

      if (sessionError) throw sessionError;
      currentSessionId = newSession.id;
    }

    // Save the user's message
    await supabase.from('chat_messages').insert({
      session_id: currentSessionId,
      role: 'user',
      content: { text: message },
    });

    // Fetch recent conversation history from Supabase
    const { data: historyRows, error: historyError } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', currentSessionId)
      .order('created_at', { ascending: true })
      .limit(MAX_HISTORY_MESSAGES);

    if (historyError) throw historyError;

    // Convert DB rows into Claude's message format
    const messages = historyRows.map((row: any) => ({
      role: row.role,
      content: row.content.text ?? row.content, // supports plain text or tool-use blocks
    }));

    let response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });

    // Handle tool use loop
    while (response.stop_reason === 'tool_use') {
      const toolUseBlock = response.content.find(
        (block: any) => block.type === 'tool_use'
      );
      if (!toolUseBlock) break;

      const toolResult = await executeTool(
        supabase,
        toolUseBlock.name,
        toolUseBlock.input
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: JSON.stringify(toolResult),
          },
        ],
      });

      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
        tools,
      });
    }

    const textBlock = response.content.find((block: any) => block.type === 'text');
    const replyText = textBlock
      ? textBlock.text
      : "I'm sorry, I couldn't generate a response.";

    // Save the assistant's reply
    await supabase.from('chat_messages').insert({
      session_id: currentSessionId,
      role: 'assistant',
      content: { text: replyText },
    });

    return new Response(
      JSON.stringify({ reply: replyText, sessionId: currentSessionId }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Chat function error:', error);
    return new Response(
      JSON.stringify({
        error: 'Something went wrong processing your message. Please try again.',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});