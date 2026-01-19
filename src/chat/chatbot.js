import OpenAI from 'openai';

// Communication style prompts
const STYLE_PROMPTS = {
  PROFESSIONAL: 'Use a professional, business-like tone. Be formal and courteous.',
  FRIENDLY: 'Use a warm, friendly tone. Be conversational and approachable while remaining helpful.',
  CASUAL: 'Use a relaxed, casual tone. Be informal and personable, like chatting with a friend.',
  CONCISE: 'Be brief and to-the-point. Give short, direct answers without unnecessary elaboration.'
};

const DEFAULT_SYSTEM_PROMPT = `You are a helpful virtual assistant for a business website. Your role is to help visitors find information about products, services, prices, opening hours, and contact details.

STRICT RULES YOU MUST FOLLOW:

1. ONLY answer using information from the CONTEXT provided below. This context comes directly from the business website.

2. If information is NOT in the context, say you don't have that information and suggest contacting the business directly.

3. NEVER guess or make up information. Only state facts from the context.

4. NEVER discuss topics unrelated to this business.

5. Be polite and professional. Use a friendly, helpful tone.

6. Keep answers concise but complete. If asked about prices or products, list relevant ones from the context.

7. When listing products/services/prices, format them clearly.

8. IMPORTANT - LANGUAGE: Always respond in the SAME LANGUAGE the user writes in. If the user writes in Slovak, respond in Slovak. If they write in Czech, respond in Czech. If English, respond in English. Match their language exactly.

9. When helping users choose between options (e.g., cars, products, plans), use the available data to make informed recommendations based on their stated preferences.

10. BOOKING REQUESTS: If the user wants to book, schedule, or make an appointment:
    - Collect their name, phone number, email (optional), preferred service, and preferred date/time
    - Once you have the essential info (at least name and phone), confirm the details and let them know you'll submit the booking request
    - Be helpful in suggesting available services from the context

You represent this business - be helpful within these boundaries.`;

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
 * Build context from clinic data based on query
 * @param {object} clinicData - The clinic/business data
 * @param {string} query - User's query
 * @param {object} detectedIntents - Detected intents from LLM
 * @param {string} customKnowledge - Optional custom knowledge to append
 */
function buildContext(clinicData, query, detectedIntents = {}, customKnowledge = null) {
  const queryLower = query.toLowerCase();
  const chunks = [];

  // Always include basic info
  chunks.push(`BUSINESS INFORMATION:
- Name: ${clinicData.clinic_name || 'Not available'}
- Address: ${clinicData.address || 'Not available'}
- Phone: ${clinicData.phone || 'Not available'}
- Email: ${clinicData.email || 'Not available'}
- Opening Hours: ${clinicData.opening_hours || 'Not available'}`);

  // High-level positioning content
  if (clinicData.about) {
    chunks.push(`ABOUT THE BUSINESS:\n${clinicData.about}`);
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
    chunks.push(`TESTIMONIALS SUMMARY:\n${clinicData.testimonials_summary}`);
  }

  if (clinicData.additional_info) {
    chunks.push(`ADDITIONAL INFO:\n${clinicData.additional_info}`);
  }

  // Include services/prices if relevant or always for comprehensive answers
  const priceKeywords = ['price', 'cost', 'how much', 'cena', 'koľko', 'stojí', 'cenník', 'fee', 'stoji'];
  const serviceKeywords = ['service', 'treatment', 'procedure', 'služb', 'ošetren', 'liečb', 'offer', 'do you'];
  const locationKeywords = ['adresa', 'address', 'contact', 'kontakt', 'sídlo', 'sidl', 'pobočk', 'pobock'];

  const wantsPrice = detectedIntents.price || priceKeywords.some(kw => queryLower.includes(kw));
  const wantsService = detectedIntents.service || serviceKeywords.some(kw => queryLower.includes(kw));
  const wantsLocation = detectedIntents.contact || locationKeywords.some(kw => queryLower.includes(kw));
  const wantsHours = detectedIntents.hours || queryLower.includes('hours') || queryLower.includes('otvárac') || queryLower.includes('opening');
  const wantsDoctors = detectedIntents.doctors || false;

  // Filter out common stop words from query for better matching
  const stopWords = ['aka', 'aky', 'aká', 'aké', 'ako', 'je', 'su', 'sú', 'pre', 'za', 'na', 'the', 'is', 'for', 'what', 'how', 'much', 'cena', 'price', 'cost', 'kolko', 'koľko', 'stoji', 'stojí'];

  if (clinicData.services && clinicData.services.length > 0) {
    // If asking about specific service, try to find it
    // Remove punctuation and split into words
    const queryWords = queryLower
      .replace(/[?!.,;:'"„"()]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopWords.includes(w));

    const relevantServices = clinicData.services.filter(s => {
      const serviceLower = s.name.toLowerCase();
      // Match if any meaningful query word appears in service name
      return queryWords.some(word => serviceLower.includes(word));
    });

    console.log(`Query: "${query}" -> Words: [${queryWords.join(', ')}] -> Found ${relevantServices.length} services`);
    if (relevantServices.length > 0) {
      console.log(`Matched: ${relevantServices.map(s => s.name).join(', ')}`);
    }

    if (relevantServices.length > 0 && relevantServices.length <= 30) {
      const serviceList = relevantServices
        .map(s => `- ${s.name}: ${s.price}`)
        .join('\n');
      chunks.push(`MATCHING SERVICES & PRICES:\n${serviceList}`);
    }

    // If asking about prices/services in general, include a capped full list
    if (wantsPrice || wantsService || (relevantServices.length === 0 && (wantsPrice || wantsService))) {
      const allServices = clinicData.services
        .slice(0, 180)
        .map(s => `- ${s.name}: ${s.price}`)
        .join('\n');
      if (allServices.length > 0) {
        chunks.push(`ALL AVAILABLE SERVICES & PRICES (first ${clinicData.services.length > 180 ? '180 of ' + clinicData.services.length : clinicData.services.length}):\n${allServices}`);
      }
    }
  }

  // Include team/staff if relevant
  const staffKeywords = ['doctor', 'staff', 'team', 'lekár', 'doktor', 'tím', 'who', 'employee', 'zamestnan'];
  if (staffKeywords.some(kw => queryLower.includes(kw))) {
    if (clinicData.doctors && clinicData.doctors.length > 0) {
      const staffList = clinicData.doctors
        .map(d => `- ${d.name}${d.specialization ? ` (${d.specialization})` : ''}`)
        .join('\n');
      chunks.push(`TEAM/STAFF:\n${staffList}`);
    }
  } else if (wantsDoctors) {
    if (clinicData.doctors && clinicData.doctors.length > 0) {
      const staffList = clinicData.doctors
        .map(d => `- ${d.name}${d.specialization ? ` (${d.specialization})` : ''}`)
        .join('\n');
      chunks.push(`TEAM/STAFF:\n${staffList}`);
    }
  }

  // Include location/contact emphasis when asked
  if (wantsLocation) {
    chunks.push(`LOCATION & CONTACT:
- Address: ${clinicData.address || 'Not available'}
- Phone: ${clinicData.phone || 'Not available'}
- Email: ${clinicData.email || 'Not available'}
- Opening Hours: ${clinicData.opening_hours || 'Not available'}`);
  }

  // Include hours emphasis if specifically requested
  if (wantsHours && clinicData.opening_hours) {
    chunks.push(`OPENING HOURS:\n${clinicData.opening_hours}`);
  }

  // Include FAQ when available to help with common questions
  if (Array.isArray(clinicData.faq) && clinicData.faq.length > 0) {
    const faqs = clinicData.faq
      .slice(0, 12)
      .map(f => `Q: ${f.question}\nA: ${f.answer}`)
      .join('\n\n');
    chunks.push(`FAQ:\n${faqs}`);
  }

  // Search raw content for specific matches
  if (clinicData.raw_content) {
    const rawQueryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const paragraphs = clinicData.raw_content.split(/\n{2,}/);

    const relevant = paragraphs
      .filter(p => rawQueryWords.some(w => p.toLowerCase().includes(w)))
      .slice(0, 5)
      .join('\n\n');

    if (relevant.length > 50) {
      chunks.push(`ADDITIONAL CONTEXT FROM WEBSITE:\n${relevant.slice(0, 4000)}`);
    }
  }

  // Add custom knowledge if provided
  if (customKnowledge && customKnowledge.trim()) {
    chunks.push(`ADDITIONAL KNOWLEDGE (provided by business owner):\n${customKnowledge.trim()}`);
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
  "providingInfo": boolean // user is providing personal info (name, phone, email, date preference)
}`;

  try {
    // Include last few messages for context
    const contextMessages = conversationHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    const fullQuery = contextMessages ? `Previous context:\n${contextMessages}\n\nCurrent message: ${query}` : query;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
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
      model: 'gpt-4o-mini',
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
export async function generateChatResponse(apiKey, clinicData, conversationHistory, userMessage, options = {}) {
  const client = new OpenAI({ apiKey });

  const basePrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = buildSystemPrompt(basePrompt, options);
  const customKnowledge = options.customKnowledge || null;

  const intents = await detectIntent(apiKey, userMessage, conversationHistory);
  const context = buildContext(clinicData, userMessage, intents, customKnowledge);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `CONTEXT FROM BUSINESS WEBSITE:\n\n${context}` },
    ...conversationHistory.slice(-16),
    { role: 'user', content: userMessage }
  ];

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 800,
      temperature: 0.3
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

  const basePrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = buildSystemPrompt(basePrompt, options);
  const customKnowledge = options.customKnowledge || null;

  const intents = await detectIntent(apiKey, userMessage, conversationHistory);
  const context = buildContext(clinicData, userMessage, intents, customKnowledge);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: `CONTEXT FROM BUSINESS WEBSITE:\n\n${context}` },
    ...conversationHistory.slice(-16),
    { role: 'user', content: userMessage }
  ];

  // Debug: log what we're sending to the LLM
  console.log('\n========== LLM REQUEST ==========');
  console.log('SYSTEM PROMPT:', systemPrompt.slice(0, 500) + '...');
  console.log('\nCONTEXT (first 2000 chars):', context.slice(0, 2000));
  console.log('\nUSER MESSAGE:', userMessage);
  console.log('INTENTS:', JSON.stringify(intents));
  console.log('==================================\n');

  try {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 800,
      temperature: 0.3,
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
  const parts = [`Welcome! I'm the virtual assistant for ${name}.`];

  const available = [];
  if (clinicData.services?.length > 0) available.push(`${clinicData.services.length} products/services`);
  if (clinicData.doctors?.length > 0) available.push(`${clinicData.doctors.length} team members`);
  if (clinicData.opening_hours) available.push('opening hours');
  if (clinicData.phone || clinicData.email) available.push('contact information');

  if (available.length > 0) {
    parts.push(`I can help you with: ${available.join(', ')}.`);
  }

  parts.push('How can I help you today?');

  return parts.join(' ');
}
