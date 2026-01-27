import OpenAI from 'openai';
import { CHAT_MODEL, UTILITY_MODEL } from '../config/ai.js';

// Communication style prompts
const STYLE_PROMPTS = {
  PROFESSIONAL: 'Use a professional, business-like tone. Be formal and courteous.',
  FRIENDLY: 'Use a warm, friendly tone. Be conversational and approachable while remaining helpful.',
  CASUAL: 'Use a relaxed, casual tone. Be informal and personable, like chatting with a friend.',
  CONCISE: 'Be brief and to-the-point. Give short, direct answers without unnecessary elaboration.'
};

const DEFAULT_SYSTEM_PROMPT = `You are a virtual assistant for a business. Your ONLY purpose is to help visitors with questions about THIS business — its products, services, prices, opening hours, contact details, team, and bookings.

STRICT RULES:

1. STAY ON TOPIC: Only answer questions related to the business described in the CONTEXT below. If the user asks about unrelated topics (politics, general knowledge, personal advice, other businesses, etc.), politely redirect them: "I can only help with questions about [business name]. What would you like to know about our services?"

2. USE ONLY THE CONTEXT: Answer based strictly on the CONTEXT provided from the business website. Do NOT invent, assume, or hallucinate any information. If the answer is not in the context, say so honestly and suggest contacting the business directly.

3. KEEP IT CONCISE: Give clear, direct answers. Format lists nicely when showing products, services, or prices.

4. LANGUAGE: Always respond in the SAME LANGUAGE the user writes in. Match their language naturally.

5. NO SMALL TALK: Keep conversations focused on the business. A brief greeting is fine, but always steer toward how you can help with business-related questions.

6. BOOKING REQUESTS: If someone mentions anything about booking, scheduling, reserving, or making an appointment, you MUST call the show_booking_form tool IMMEDIATELY — even if they haven't provided all details yet. The booking form will collect the missing information. IMPORTANT: You must ALSO provide a short text response alongside the tool call (e.g. confirming you're opening the booking form), in the user's language.

7. DO NOT discuss topics outside the business scope, provide personal opinions, engage in debates, or answer general knowledge questions.`;

// Field labels for booking
const BOOKING_FIELD_LABELS = {
  name: 'Full Name',
  email: 'Email Address',
  phone: 'Phone Number',
  service: 'Service/Product',
  preferredDate: 'Preferred Date',
  preferredTime: 'Preferred Time',
  notes: 'Additional Notes'
};

// Booking tool definition
const BOOKING_TOOL = {
  type: 'function',
  function: {
    name: 'show_booking_form',
    description: 'ALWAYS call this tool when the user expresses ANY intent to book, schedule, reserve, or make an appointment — in any language. Call it immediately, even if details are missing. The form will collect the details. Examples: "I want to book", "schedule appointment", "chcem sa objednat", "rezervovat", "Termin buchen".',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief description of what the user wants to book'
        }
      },
      required: []
    }
  }
};

/**
 * Build system prompt with communication style
 */
function buildSystemPrompt(basePrompt, options = {}) {
  let prompt = basePrompt || DEFAULT_SYSTEM_PROMPT;

  // Add communication style
  if (options.communicationStyle && STYLE_PROMPTS[options.communicationStyle]) {
    prompt += `\n\nCOMMUNICATION STYLE: ${STYLE_PROMPTS[options.communicationStyle]}`;
  }

  // Add language preference
  if (options.language && options.language !== 'auto') {
    const langMap = {
      'sk': 'Slovak',
      'cs': 'Czech',
      'en': 'English',
      'de': 'German',
      'hu': 'Hungarian',
      'pl': 'Polish'
    };
    const langName = langMap[options.language] || options.language;
    prompt += `\n\nLANGUAGE: Always respond in ${langName}, regardless of what language the user writes in.`;
  }

  // Add custom greeting instruction
  if (options.customGreeting) {
    prompt += `\n\nCUSTOM GREETING: When starting a conversation or greeting the user, use this greeting: "${options.customGreeting}"`;
  }

  // Add booking instructions based on configured fields
  if (options.bookingEnabled && options.bookingFields && options.bookingFields.length > 0) {
    const fieldsList = options.bookingFields
      .map(field => `- ${BOOKING_FIELD_LABELS[field] || field}`)
      .join('\n');

    const bookingPrompt = options.bookingPromptMessage ||
      'When a user wants to book an appointment or request a service, call the show_booking_form tool and collect the following information:';

    prompt += `\n\nBOOKING INSTRUCTIONS:\n${bookingPrompt}\n${fieldsList}\n\nOnce you have collected the required information, confirm the details with the user and let them know you'll submit their booking request.`;
  }

  return prompt;
}

/**
 * Build context from clinic data
 */
function buildContext(clinicData, customKnowledge = null) {
  const chunks = [];

  // Always include basic info
  chunks.push(`BUSINESS INFORMATION:
- Name: ${clinicData.clinic_name || 'Not available'}
- Address: ${clinicData.address || 'Not available'}
- Phone: ${clinicData.phone || 'Not available'}
- Email: ${clinicData.email || 'Not available'}
- Opening Hours: ${clinicData.opening_hours || 'Not available'}`);

  if (clinicData.about) {
    chunks.push(`ABOUT:\n${clinicData.about}`);
  }

  if (Array.isArray(clinicData.key_benefits) && clinicData.key_benefits.length > 0) {
    const benefits = clinicData.key_benefits.slice(0, 12).map(b => `- ${b}`).join('\n');
    chunks.push(`KEY BENEFITS:\n${benefits}`);
  }

  if (clinicData.target_audience) {
    chunks.push(`TARGET AUDIENCE:\n${clinicData.target_audience}`);
  }

  if (clinicData.unique_approach) {
    chunks.push(`UNIQUE APPROACH:\n${clinicData.unique_approach}`);
  }

  if (clinicData.testimonials_summary) {
    chunks.push(`TESTIMONIALS:\n${clinicData.testimonials_summary}`);
  }

  if (clinicData.services && clinicData.services.length > 0) {
    const serviceList = clinicData.services
      .slice(0, 150)
      .map(s => `- ${s.name}: ${s.price}`)
      .join('\n');
    chunks.push(`SERVICES & PRICES (${clinicData.services.length > 150 ? 'first 150 of ' + clinicData.services.length : clinicData.services.length} total):\n${serviceList}`);
  }

  if (clinicData.doctors && clinicData.doctors.length > 0) {
    const staffList = clinicData.doctors
      .map(d => `- ${d.name}${d.specialization ? ` (${d.specialization})` : ''}`)
      .join('\n');
    chunks.push(`TEAM:\n${staffList}`);
  }

  if (Array.isArray(clinicData.faq) && clinicData.faq.length > 0) {
    const faqs = clinicData.faq
      .slice(0, 10)
      .map(f => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n');
    chunks.push(`FREQUENTLY ASKED QUESTIONS:\n${faqs}`);
  }

  if (clinicData.raw_content && clinicData.raw_content.length > 100) {
    chunks.push(`ADDITIONAL WEBSITE CONTENT:\n${clinicData.raw_content.slice(0, 3000)}`);
  }

  if (clinicData.additional_info) {
    chunks.push(`ADDITIONAL INFO:\n${clinicData.additional_info}`);
  }

  if (customKnowledge && customKnowledge.trim()) {
    chunks.push(`CUSTOM KNOWLEDGE (from business owner):\n${customKnowledge.trim()}`);
  }

  return chunks.join('\n\n---\n\n');
}

/**
 * Detect user intent (multilingual) using LLM — kept for backward compatibility
 * but no longer called in the main chat flow.
 */
export async function detectIntent(apiKey, query, conversationHistory = []) {
  const client = new OpenAI({ apiKey });

  const prompt = `Classify the user's request (any language). Consider the conversation context. Respond ONLY with JSON:
{
  "price": boolean,
  "service": boolean,
  "contact": boolean,
  "hours": boolean,
  "doctors": boolean,
  "booking": boolean,
  "providingInfo": boolean,
  "language": string
}`;

  try {
    const intentStart = Date.now();
    const contextMessages = conversationHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    const fullQuery = contextMessages ? `Previous context:\n${contextMessages}\n\nCurrent message: ${query}` : query;

    const response = await client.chat.completions.create({
      model: UTILITY_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: fullQuery }
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`[TIMING] detectIntent API call: ${Date.now() - intentStart}ms`);
    console.log(`[DEBUG] Detected intents:`, JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('[ERROR] Intent detection failed:', error.message);
    return {};
  }
}

/**
 * Extract booking information from conversation
 */
export async function extractBookingData(apiKey, conversationHistory) {
  const client = new OpenAI({ apiKey });

  const prompt = `Analyze this conversation and extract any booking/appointment information provided by the user.
Return ONLY JSON with the following fields (use null for fields not provided):
{
  "customerName": string or null,
  "customerEmail": string or null,
  "customerPhone": string or null,
  "service": string or null,
  "preferredDate": string or null,
  "preferredTime": string or null,
  "notes": string or null,
  "isComplete": boolean,
  "missingFields": string[]
}`;

  const messages = conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');

  try {
    const bookingStart = Date.now();
    const response = await client.chat.completions.create({
      model: UTILITY_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: messages }
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`[TIMING] extractBookingData API call: ${Date.now() - bookingStart}ms`);
    return result;
  } catch (error) {
    console.error('[ERROR] Booking extraction failed:', error.message);
    return { isComplete: false, missingFields: ['name', 'phone'] };
  }
}

/**
 * Prepare chat messages — no longer calls detectIntent (that's now handled by tool calling in the main LLM)
 */
export function prepareChatMessages(clinicData, conversationHistory, userMessage, options = {}) {
  const basePrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const customKnowledge = options.customKnowledge || null;

  const systemPrompt = buildSystemPrompt(basePrompt, options);
  const context = buildContext(clinicData, customKnowledge);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `CONTEXT FROM BUSINESS WEBSITE:\n\n${context}` },
    ...conversationHistory.slice(-16),
    { role: 'user', content: userMessage }
  ];

  return { messages, systemPrompt, context };
}

/**
 * Generate chat response (non-streaming, kept for backward compat)
 */
export async function generateChatResponse(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const client = new OpenAI({ apiKey });

  const prepared = options.prepared || prepareChatMessages(
    clinicData,
    conversationHistory,
    userMessage,
    options
  );

  const { messages } = prepared;
  const tools = options.bookingEnabled ? [BOOKING_TOOL] : undefined;

  try {
    const response = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: 800,
      temperature: 0.5,
      ...(tools ? { tools, tool_choice: 'auto' } : {})
    });

    const choice = response.choices[0].message;
    const toolCall = choice.tool_calls?.[0];

    return {
      success: true,
      message: choice.content || '',
      bookingToolCalled: toolCall?.function?.name === 'show_booking_form'
    };
  } catch (error) {
    console.error('[ERROR] OpenAI error:', error.message);

    if (error.code === 'invalid_api_key') {
      return { success: false, error: 'Invalid API key' };
    }
    if (error.code === 'insufficient_quota') {
      return { success: false, error: 'API quota exceeded' };
    }

    return { success: false, error: 'Failed to generate response' };
  }
}

/**
 * Generate streaming chat response with integrated tool calling.
 * Single API call handles both the response and booking detection.
 * @yields {{ type: 'content', content: string } | { type: 'tool_call', name: string }}
 */
export async function* generateChatResponseStream(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const client = new OpenAI({ apiKey });

  const prepared = options.prepared || prepareChatMessages(
    clinicData,
    conversationHistory,
    userMessage,
    options
  );

  const { messages, systemPrompt, context } = prepared;
  const tools = options.bookingEnabled ? [BOOKING_TOOL] : undefined;

  // Debug: log what we're sending to the LLM
  console.log('\n========== LLM REQUEST ==========');
  console.log('MODEL:', CHAT_MODEL);
  console.log('TOOLS:', tools ? 'show_booking_form' : 'none');
  console.log('SYSTEM PROMPT:', systemPrompt.slice(0, 500) + '...');
  console.log('\nCONTEXT (first 2000 chars):', context.slice(0, 2000));
  console.log('\nUSER MESSAGE:', userMessage);
  console.log('==================================\n');

  try {
    const llmStart = Date.now();
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: 800,
      temperature: 0.5,
      stream: true,
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {})
    });

    let tokenCount = 0;
    let toolCallDetected = false;
    let toolCallName = '';
    let toolCallArgs = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // Handle content chunks
      if (delta?.content) {
        tokenCount++;
        yield { type: 'content', content: delta.content };
      }

      // Handle tool call chunks (streamed incrementally)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            toolCallName = tc.function.name;
          }
          if (tc.function?.arguments) {
            toolCallArgs += tc.function.arguments;
          }
        }
        if (!toolCallDetected && toolCallName) {
          toolCallDetected = true;
        }
      }
    }

    // Emit tool call after stream completes
    if (toolCallDetected && toolCallName === 'show_booking_form') {
      console.log(`[DEBUG] Booking tool called by LLM`);
      yield { type: 'tool_call', name: 'show_booking_form' };
    }

    console.log(`[TIMING] LLM streaming complete: ${Date.now() - llmStart}ms, ~${tokenCount} chunks, toolCall=${toolCallDetected}`);
  } catch (error) {
    console.error('[ERROR] OpenAI streaming error:', error.message);

    if (error.code === 'invalid_api_key') {
      throw new Error('Invalid API key');
    }
    if (error.code === 'insufficient_quota') {
      throw new Error('API quota exceeded');
    }
    throw new Error('Failed to generate response');
  }
}

/**
 * Generate welcome message
 */
export function generateWelcomeMessage(clinicData) {
  const name = clinicData.clinic_name || 'this website';
  const parts = [`Hey! I'm here to help you with ${name}.`];

  const available = [];
  if (clinicData.services?.length > 0) available.push('products and services');
  if (clinicData.doctors?.length > 0) available.push('our team');
  if (clinicData.opening_hours) available.push('hours');
  if (clinicData.phone || clinicData.email) available.push('contact info');

  if (available.length > 0) {
    parts.push(`Ask me about ${available.join(', ')} - or anything else!`);
  } else {
    parts.push('What can I help you with?');
  }

  return parts.join(' ');
}
