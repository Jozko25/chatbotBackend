import OpenAI from 'openai';
import { CHAT_MODEL, UTILITY_MODEL } from '../config/ai.js';

// Communication style prompts
const STYLE_PROMPTS = {
  PROFESSIONAL: 'Use a professional, business-like tone. Be formal and courteous.',
  FRIENDLY: 'Use a warm, friendly tone. Be conversational and approachable while remaining helpful.',
  CASUAL: 'Use a relaxed, casual tone. Be informal and personable, like chatting with a friend.',
  CONCISE: 'Be brief and to-the-point. Give short, direct answers without unnecessary elaboration.'
};

const DEFAULT_SYSTEM_PROMPT = `You are a friendly, helpful virtual assistant for a business. You're here to chat with visitors and help them find information about products, services, prices, and contact details.

HOW TO INTERACT:

1. Be conversational and natural. If someone says "hey" or "how are you", respond like a normal person would. You can engage in brief small talk, but gently guide the conversation toward how you can help them.

2. Use the CONTEXT below (from the business website) to answer questions about the business. When answering business questions, stick to the facts from the context.

3. If someone asks about something not in the context, be honest and suggest they contact the business directly. Don't make things up.

4. Keep your answers clear and concise. Format lists nicely when showing products, services, or prices.

5. LANGUAGE: Always respond in the SAME LANGUAGE the user writes in. Match their language naturally - if they write in Slovak, respond in Slovak. If English, respond in English, etc.

6. When helping users choose between options, use the available information to make helpful recommendations based on what they're looking for.

7. BOOKING REQUESTS: If someone wants to book or schedule something:
   - Ask for their name, phone number, email (optional), what service they want, and their preferred date/time
   - Once you have the essentials (name and phone at minimum), confirm everything and let them know you'll submit their request
   - Suggest relevant services from the context

Remember: Be helpful, be human, and guide conversations toward how you can assist with the business. You don't need to be a robot - friendly and natural wins.`;

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
      'When a user wants to book an appointment or request a service, collect the following information:';
    
    prompt += `\n\nBOOKING INSTRUCTIONS:\n${bookingPrompt}\n${fieldsList}\n\nOnce you have collected the required information, confirm the details with the user and let them know you'll submit their booking request.`;
  }
  
  return prompt;
}

/**
 * Build context from clinic data - let the AI decide what's relevant
 * @param {object} clinicData - The clinic/business data
 * @param {string} query - User's query
 * @param {object} detectedIntents - Detected intents from LLM
 * @param {string} customKnowledge - Optional custom knowledge to append
 */
function buildContext(clinicData, query, detectedIntents = {}, customKnowledge = null) {
  const chunks = [];

  // Always include basic info
  chunks.push(`BUSINESS INFORMATION:
- Name: ${clinicData.clinic_name || 'Not available'}
- Address: ${clinicData.address || 'Not available'}
- Phone: ${clinicData.phone || 'Not available'}
- Email: ${clinicData.email || 'Not available'}
- Opening Hours: ${clinicData.opening_hours || 'Not available'}`);

  // Include business description and positioning
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

  // Include all services/products with prices
  if (clinicData.services && clinicData.services.length > 0) {
    const serviceList = clinicData.services
      .slice(0, 150) // Cap to avoid token limits
      .map(s => `- ${s.name}: ${s.price}`)
      .join('\n');
    chunks.push(`SERVICES & PRICES (${clinicData.services.length > 150 ? 'first 150 of ' + clinicData.services.length : clinicData.services.length} total):\n${serviceList}`);
  }

  // Include team/staff
  if (clinicData.doctors && clinicData.doctors.length > 0) {
    const staffList = clinicData.doctors
      .map(d => `- ${d.name}${d.specialization ? ` (${d.specialization})` : ''}`)
      .join('\n');
    chunks.push(`TEAM:\n${staffList}`);
  }

  // Include FAQ
  if (Array.isArray(clinicData.faq) && clinicData.faq.length > 0) {
    const faqs = clinicData.faq
      .slice(0, 10)
      .map(f => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n');
    chunks.push(`FREQUENTLY ASKED QUESTIONS:\n${faqs}`);
  }

  // Include raw content excerpt
  if (clinicData.raw_content && clinicData.raw_content.length > 100) {
    chunks.push(`ADDITIONAL WEBSITE CONTENT:\n${clinicData.raw_content.slice(0, 3000)}`);
  }

  if (clinicData.additional_info) {
    chunks.push(`ADDITIONAL INFO:\n${clinicData.additional_info}`);
  }

  // Add custom knowledge if provided
  if (customKnowledge && customKnowledge.trim()) {
    chunks.push(`CUSTOM KNOWLEDGE (from business owner):\n${customKnowledge.trim()}`);
  }

  return chunks.join('\n\n---\n\n');
}

/**
 * Detect user intent (multilingual) using LLM to avoid language-specific heuristics
 */
export async function detectIntent(apiKey, query, conversationHistory = []) {
  const client = new OpenAI({ apiKey });

  const prompt = `Classify the user's request (any language). Consider the conversation context. Respond ONLY with JSON:
{
  "price": boolean,      // asking about price or cost
  "service": boolean,    // asking about services/treatments/offers
  "contact": boolean,    // asking about location, address, phone, contact, branches
  "hours": boolean,      // asking about opening hours/schedule
  "doctors": boolean,    // asking about staff, doctors, team
  "booking": boolean,    // wants to book/schedule/make an appointment/reservation
  "providingInfo": boolean, // user is providing personal info (name, phone, email, date preference)
  "language": string        // ISO 639-1 when possible (e.g., sk, cs, en, de, hu, pl) or "unknown"
}`;

  try {
    // Include last few messages for context
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

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.warn('Intent detection failed, falling back to heuristics:', error.message);
    return {};
  }
}

/**
 * Extract booking information from conversation
 * @param {string} apiKey - OpenAI API key
 * @param {array} conversationHistory - Full conversation history
 * @returns {object} - Extracted booking data
 */
export async function extractBookingData(apiKey, conversationHistory) {
  const client = new OpenAI({ apiKey });

  const prompt = `Analyze this conversation and extract any booking/appointment information provided by the user.
Return ONLY JSON with the following fields (use null for fields not provided):
{
  "customerName": string or null,
  "customerEmail": string or null,
  "customerPhone": string or null,
  "service": string or null,       // what service they want
  "preferredDate": string or null, // date they mentioned
  "preferredTime": string or null, // time they mentioned
  "notes": string or null,         // any additional notes/requests
  "isComplete": boolean,           // true if we have at least name AND (phone OR email)
  "missingFields": string[]        // list of important missing fields
}`;

  const messages = conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');

  try {
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

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('Booking extraction failed:', error.message);
    return { isComplete: false, missingFields: ['name', 'phone'] };
  }
}

/**
 * Generate chat response
 * @param {string} apiKey - OpenAI API key
 * @param {object} clinicData - The clinic/business data
 * @param {array} conversationHistory - Previous messages
 * @param {string} userMessage - Current user message
 * @param {object} options - Optional settings (systemPrompt, customKnowledge, communicationStyle, language)
 */
export async function prepareChatMessages(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const basePrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const customKnowledge = options.customKnowledge || null;

  const intents = await detectIntent(apiKey, userMessage, conversationHistory);
  const resolvedLanguage = options.language === 'auto' ? intents.language : options.language;
  const effectiveLanguage = resolvedLanguage && resolvedLanguage !== 'unknown'
    ? resolvedLanguage
    : options.language;
  const systemPrompt = buildSystemPrompt(basePrompt, { ...options, language: effectiveLanguage });
  const context = buildContext(clinicData, userMessage, intents, customKnowledge);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `CONTEXT FROM BUSINESS WEBSITE:\n\n${context}` },
    ...conversationHistory.slice(-16),
    { role: 'user', content: userMessage }
  ];

  return { messages, intents, systemPrompt, context };
}

export async function generateChatResponse(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const client = new OpenAI({ apiKey });

  const prepared = options.prepared || await prepareChatMessages(
    apiKey,
    clinicData,
    conversationHistory,
    userMessage,
    options
  );

  const { messages, intents } = prepared;

  try {
    const response = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: 800,
      temperature: 0.5
    });

    return {
      success: true,
      message: response.choices[0].message.content,
      intents
    };
  } catch (error) {
    console.error('OpenAI error:', error.message);

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
 * Generate streaming chat response
 * @param {string} apiKey - OpenAI API key
 * @param {object} clinicData - The clinic/business data
 * @param {array} conversationHistory - Previous messages
 * @param {string} userMessage - Current user message
 * @param {object} options - Optional settings (systemPrompt, customKnowledge, communicationStyle, language)
 * @yields {string} Text chunks as they arrive
 */
export async function* generateChatResponseStream(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const client = new OpenAI({ apiKey });

  const prepared = options.prepared || await prepareChatMessages(
    apiKey,
    clinicData,
    conversationHistory,
    userMessage,
    options
  );

  const { messages, intents, systemPrompt, context } = prepared;

  // Debug: log what we're sending to the LLM
  console.log('\n========== LLM REQUEST ==========');
  console.log('SYSTEM PROMPT:', systemPrompt.slice(0, 500) + '...');
  console.log('\nCONTEXT (first 2000 chars):', context.slice(0, 2000));
  console.log('\nUSER MESSAGE:', userMessage);
  console.log('INTENTS:', JSON.stringify(intents));
  console.log('==================================\n');

  try {
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_tokens: 800,
      temperature: 0.5,
      stream: true
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch (error) {
    console.error('OpenAI streaming error:', error.message);

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
