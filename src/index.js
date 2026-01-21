import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { scrapeClinicWebsite } from './scraper/scraper.js';
import { normalizeClinicData } from './scraper/normalizer.js';
import { extractWithLLM, mergeExtractedData } from './scraper/extractor.js';
import { generateChatResponse, generateWelcomeMessage, generateChatResponseStream, prepareChatMessages } from './chat/chatbot.js';
import prisma from './services/prisma.js';
import { protectedRoute, checkChatbotLimit, checkMessageLimit } from './middleware/auth.js';
import { validateApiKey } from './middleware/apiKey.js';
import { apiLimiter, scrapeLimiter, chatLimiter, widgetLimiter, strictLimiter } from './middleware/rateLimiter.js';
import { validateChatbotId, sanitizeBookingData } from './middleware/validation.js';
import chatbotRoutes from './routes/chatbots.js';
import apiKeyRoutes from './routes/apiKeys.js';
import usageRoutes from './routes/usage.js';
import bookingRoutes from './routes/bookings.js';
import { sendBookingNotifications } from './services/notifications.js';
import { extractBookingData } from './chat/chatbot.js';
import { createCalendarEvent, getAvailableSlots } from './services/googleCalendar.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false, // Allow embedding
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow widget embedding
}));

// CORS configuration - allow all origins, domain validation done via API key for widgets
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Request size limits (reduced from 10mb for security)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Request timeout (30 seconds)
app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

// Apply general rate limit
app.use(apiLimiter);

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'xelochat-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Demo chat endpoint for landing page (no auth required, uses OpenAI with tool calling)
app.post('/api/demo/chat', strictLimiter, async (req, res) => {
  const { messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Define the booking tool
    const tools = [
      {
        type: 'function',
        function: {
          name: 'show_booking_form',
          description: 'Display the booking form to allow the user to schedule an appointment, demo, consultation, or any kind of reservation. Use this when the user expresses intent to book, schedule, reserve, or make an appointment.',
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
      }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 500,
      temperature: 0.7
    });

    const choice = response.choices[0];
    const message = choice.message;

    // Check if the AI called a tool
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];

      if (toolCall.function.name === 'show_booking_form') {
        // Return with tool call indicator and a message
        return res.json({
          message: message.content || "I'd be happy to help you book an appointment! Click the button below to fill in your details.",
          toolCall: 'show_booking_form'
        });
      }
    }

    // Regular response without tool call
    res.json({
      message: message.content || "I'm sorry, I couldn't generate a response.",
      toolCall: null
    });

  } catch (error) {
    console.error('Demo chat error:', error);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Demo booking endpoint for landing page (no auth required, creates calendar event)
app.post('/api/demo/booking', strictLimiter, async (req, res) => {
  const { customerName, customerEmail, customerPhone, service, preferredDate, preferredTime, notes, source } = req.body;

  if (!customerName) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    // Create a mock booking object for the calendar event
    const booking = {
      id: `demo-${Date.now()}`,
      chatbotId: 'demo',
      customerName,
      customerEmail: customerEmail || null,
      customerPhone: customerPhone || null,
      service: service || 'Demo Booking',
      preferredDate: preferredDate || null,
      preferredTime: preferredTime || null,
      notes: notes || null
    };

    const chatbot = {
      name: 'XeloChat Demo'
    };

    // Create Google Calendar event
    const calendarResult = await createCalendarEvent(booking, chatbot);

    console.log(`Demo booking created: ${booking.id}`);
    console.log(`  Customer: ${customerName}`);
    console.log(`  Date: ${preferredDate || 'N/A'}`);
    console.log(`  Time: ${preferredTime || 'N/A'}`);
    console.log(`  Source: ${source || 'unknown'}`);
    console.log(`  Calendar:`, calendarResult);

    res.json({
      success: true,
      bookingId: booking.id,
      calendarEvent: calendarResult.success ? {
        eventId: calendarResult.eventId,
        eventLink: calendarResult.eventLink
      } : null
    });

  } catch (error) {
    console.error('Demo booking error:', error);
    res.status(500).json({ error: 'Failed to create demo booking' });
  }
});

// Check if API key is configured on server
app.get('/api/config', (req, res) => {
  res.json({ hasApiKey: !!OPENAI_API_KEY });
});

// ============================================
// PROTECTED DASHBOARD ROUTES (JWT auth)
// ============================================

app.use('/api/chatbots', protectedRoute, chatbotRoutes);
app.use('/api/api-keys', protectedRoute, apiKeyRoutes);
app.use('/api/usage', protectedRoute, usageRoutes);
app.use('/api/bookings', protectedRoute, bookingRoutes);

// Check user limits endpoint (call before scraping to verify)
app.get('/api/limits', protectedRoute, async (req, res) => {
  const user = req.user;
  const { PLAN_LIMITS } = await import('./middleware/auth.js');
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;

  const chatbotCount = await prisma.chatbot.count({
    where: {
      userId: user.id,
      status: { in: ['ACTIVE', 'PAUSED'] }
    }
  });

  res.json({
    plan: user.plan,
    chatbots: {
      current: chatbotCount,
      limit: limits.chatbots,
      canCreate: chatbotCount < limits.chatbots
    },
    messages: {
      used: user.messagesUsed,
      limit: limits.messages,
      remaining: Math.max(0, limits.messages - user.messagesUsed),
      resetsAt: user.limitResetAt
    }
  });
});

// ============================================
// SCRAPE ENDPOINT WITH STREAMING (protected, creates chatbot)
// ============================================

app.post('/api/scrape/stream', protectedRoute, scrapeLimiter, checkChatbotLimit, async (req, res) => {
  const { url } = req.body;
  const user = req.user;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable request/response timeouts for long-running SSE streams.
  req.setTimeout(0);
  res.setTimeout(0);
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping (streaming): ${url} (user: ${user.email})`);
  console.log(`${'='.repeat(50)}`);

  try {
    // Progress callback for streaming updates
    const onProgress = (progress) => {
      sendEvent(progress.type, progress);
    };

    const pages = await scrapeClinicWebsite(url, 10, 50, onProgress);

    if (!pages || pages.length === 0) {
      sendEvent('error', { error: 'Could not scrape content from this website' });
      res.end();
      return;
    }

    // First pass: regex-based extraction
    sendEvent('extracting', { step: 'regex', message: 'Extracting data from content...' });
    const regexData = normalizeClinicData(pages, url);

    // Second pass: LLM-based extraction for better accuracy
    let clinicData = regexData;
    if (OPENAI_API_KEY) {
      sendEvent('extracting', { step: 'llm', message: 'Using AI to improve data extraction...' });
      const llmData = await extractWithLLM(OPENAI_API_KEY, regexData.raw_content, pages);
      clinicData = mergeExtractedData(llmData, regexData);
    }

    const welcomeMessage = generateWelcomeMessage(clinicData);

    sendEvent('saving', { message: 'Saving chatbot to database...' });

    // Save chatbot to database
    const chatbot = await prisma.chatbot.create({
      data: {
        userId: user.id,
        name: clinicData.clinic_name || new URL(url).hostname,
        sourceUrl: url,
        clinicData: {
          clinic_name: clinicData.clinic_name,
          address: clinicData.address,
          opening_hours: clinicData.opening_hours,
          phone: clinicData.phone,
          email: clinicData.email,
          services: clinicData.services,
          doctors: clinicData.doctors,
          faq: clinicData.faq,
          source_pages: clinicData.source_pages,
          welcomeMessage,
          about: clinicData.about,
          key_benefits: clinicData.key_benefits,
          target_audience: clinicData.target_audience,
          unique_approach: clinicData.unique_approach,
          testimonials_summary: clinicData.testimonials_summary,
          additional_info: clinicData.additional_info
        },
        rawContent: clinicData.raw_content,
        theme: {},
        lastScrapedAt: new Date()
      }
    });

    // Track usage
    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        chatbotId: chatbot.id,
        eventType: 'SCRAPE',
        date: new Date()
      }
    });

    console.log(`\nResults:`);
    console.log(`  - Chatbot ID: ${chatbot.id}`);
    console.log(`  - Clinic: ${clinicData.clinic_name}`);
    console.log(`  - Pages: ${clinicData.source_pages.length}`);
    console.log(`  - Services: ${clinicData.services.length}`);
    console.log(`  - Doctors: ${clinicData.doctors.length}\n`);

    sendEvent('complete', {
      chatbotId: chatbot.id,
      name: clinicData.clinic_name,
      pagesScraped: clinicData.source_pages.length,
      servicesFound: clinicData.services.length,
      phone: clinicData.phone,
      email: clinicData.email
    });

    res.end();

  } catch (error) {
    console.error('Scrape error:', error);
    sendEvent('error', { error: `Scraping failed: ${error.message}` });
    res.end();
  }
});

// Legacy non-streaming endpoint (for backward compatibility)
app.post('/api/scrape', protectedRoute, scrapeLimiter, checkChatbotLimit, async (req, res) => {
  const { url } = req.body;
  const user = req.user;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping: ${url} (user: ${user.email})`);
  console.log(`${'='.repeat(50)}`);

  try {
    const pages = await scrapeClinicWebsite(url, 10, 50);

    if (!pages || pages.length === 0) {
      return res.status(400).json({
        error: 'Could not scrape content from this website'
      });
    }

    // First pass: regex-based extraction
    const regexData = normalizeClinicData(pages, url);

    // Second pass: LLM-based extraction for better accuracy
    let clinicData = regexData;
    if (OPENAI_API_KEY) {
      console.log('Running LLM extraction...');
      const llmData = await extractWithLLM(OPENAI_API_KEY, regexData.raw_content, pages);
      clinicData = mergeExtractedData(llmData, regexData);
    }

    const welcomeMessage = generateWelcomeMessage(clinicData);

    // Save chatbot to database
    const chatbot = await prisma.chatbot.create({
      data: {
        userId: user.id,
        name: clinicData.clinic_name || new URL(url).hostname,
        sourceUrl: url,
        clinicData: {
          clinic_name: clinicData.clinic_name,
          address: clinicData.address,
          opening_hours: clinicData.opening_hours,
          phone: clinicData.phone,
          email: clinicData.email,
          services: clinicData.services,
          doctors: clinicData.doctors,
          faq: clinicData.faq,
          source_pages: clinicData.source_pages,
          welcomeMessage,
          about: clinicData.about,
          key_benefits: clinicData.key_benefits,
          target_audience: clinicData.target_audience,
          unique_approach: clinicData.unique_approach,
          testimonials_summary: clinicData.testimonials_summary,
          additional_info: clinicData.additional_info
        },
        rawContent: clinicData.raw_content,
        theme: {},
        lastScrapedAt: new Date()
      }
    });

    // Track usage
    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        chatbotId: chatbot.id,
        eventType: 'SCRAPE',
        date: new Date()
      }
    });

    console.log(`\nResults:`);
    console.log(`  - Chatbot ID: ${chatbot.id}`);
    console.log(`  - Clinic: ${clinicData.clinic_name}`);
    console.log(`  - Pages: ${clinicData.source_pages.length}`);
    console.log(`  - Services: ${clinicData.services.length}`);
    console.log(`  - Doctors: ${clinicData.doctors.length}\n`);

    res.json({
      ...clinicData,
      welcomeMessage,
      chatbotId: chatbot.id
    });

  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: `Scraping failed: ${error.message}` });
  }
});

// ============================================
// HELPER: Auto-detect and submit booking from conversation
// ============================================

async function tryAutoSubmitBooking(chatbot, conversationHistory, userMessage, userId) {
  // Only process if booking is enabled
  if (!chatbot.bookingEnabled) return null;

  // Build full conversation including current message
  const fullHistory = [
    ...(conversationHistory || []),
    { role: 'user', content: userMessage }
  ];

  // Extract booking data from conversation
  const bookingData = await extractBookingData(OPENAI_API_KEY, fullHistory);
  
  console.log('Booking extraction result:', bookingData);

  // Only submit if we have complete booking data
  if (!bookingData.isComplete) {
    return null;
  }

  // Check if we already submitted this booking recently (prevent duplicates)
  const recentBooking = await prisma.bookingRequest.findFirst({
    where: {
      chatbotId: chatbot.id,
      customerPhone: bookingData.customerPhone || undefined,
      customerEmail: bookingData.customerEmail || undefined,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
    }
  });

  if (recentBooking) {
    console.log('Booking already submitted recently, skipping:', recentBooking.id);
    return null;
  }

  // Create booking request
  const booking = await prisma.bookingRequest.create({
    data: {
      chatbotId: chatbot.id,
      customerName: bookingData.customerName || null,
      customerEmail: bookingData.customerEmail || null,
      customerPhone: bookingData.customerPhone || null,
      service: bookingData.service || null,
      preferredDate: bookingData.preferredDate || null,
      preferredTime: bookingData.preferredTime || null,
      notes: bookingData.notes || null,
      data: bookingData,
      status: 'PENDING'
    }
  });

  console.log('Auto-created booking:', booking.id);

  // Track usage
  await prisma.usageRecord.create({
    data: {
      userId,
      chatbotId: chatbot.id,
      eventType: 'BOOKING_REQUEST',
      date: new Date()
    }
  });

  // Send notifications
  if (chatbot.notifyOnBooking && (chatbot.notificationEmail || chatbot.notificationWebhook)) {
    const notificationResults = await sendBookingNotifications(booking, chatbot);

    console.log('Notification results:', notificationResults);

    const emailSuccess = notificationResults.email?.success;
    const webhookSuccess = notificationResults.webhook?.success;

    await prisma.bookingRequest.update({
      where: { id: booking.id },
      data: {
        status: (emailSuccess || webhookSuccess) ? 'NOTIFIED' : 'PENDING',
        notificationSent: emailSuccess || webhookSuccess || false,
        notificationSentAt: (emailSuccess || webhookSuccess) ? new Date() : null,
        notificationError: notificationResults.email?.error || notificationResults.webhook?.error || null
      }
    });
  }

  // Create Google Calendar event
  try {
    const calendarResult = await createCalendarEvent(booking, chatbot);
    if (calendarResult.success) {
      console.log('Calendar event created for auto-booking:', calendarResult.eventId);
    }
  } catch (calendarError) {
    console.error('Auto-booking calendar error:', calendarError);
  }

  return booking;
}

// ============================================
// DASHBOARD CHAT ENDPOINT (JWT auth - for testing)
// ============================================

app.post('/api/chat/stream', protectedRoute, chatLimiter, checkMessageLimit, async (req, res) => {
  const { chatbotId, conversationHistory, message } = req.body;
  const user = req.user;

  if (!chatbotId) return res.status(400).json({ error: 'Chatbot ID required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Verify chatbot ownership
  const chatbot = await prisma.chatbot.findFirst({
    where: {
      id: chatbotId,
      userId: user.id,
      status: 'ACTIVE'
    }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  // Reconstruct clinicData from stored chatbot
  const clinicData = {
    ...chatbot.clinicData,
    raw_content: chatbot.rawContent
  };

  // Get custom AI settings including communication style
  const aiOptions = {
    systemPrompt: chatbot.systemPrompt || null,
    customKnowledge: chatbot.customKnowledge || null,
    communicationStyle: chatbot.communicationStyle || 'PROFESSIONAL',
    language: chatbot.language || 'auto',
    customGreeting: chatbot.customGreeting || null,
    bookingEnabled: chatbot.bookingEnabled || false,
    bookingFields: chatbot.bookingFields || ['name', 'email', 'phone', 'service', 'preferredDate', 'notes'],
    bookingPromptMessage: chatbot.bookingPromptMessage || null
  };

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const stream = generateChatResponseStream(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      aiOptions
    );

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // Try to auto-submit booking if user provided info
    try {
      const booking = await tryAutoSubmitBooking(chatbot, conversationHistory, message, user.id);
      if (booking) {
        console.log(`Auto-submitted booking ${booking.id} for chatbot ${chatbotId}`);
        res.write(`data: ${JSON.stringify({ bookingSubmitted: true, bookingId: booking.id })}\n\n`);
      }
    } catch (bookingError) {
      console.error('Auto-booking error:', bookingError);
    }

    // Increment usage
    await prisma.user.update({
      where: { id: user.id },
      data: { messagesUsed: { increment: 1 } }
    });

    // Track usage
    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        chatbotId: chatbot.id,
        eventType: 'CHAT_MESSAGE',
        date: new Date()
      }
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// ============================================
// WIDGET ENDPOINTS (API key auth)
// ============================================

// Get chatbot config for widget
app.get('/api/widget/chatbot/:id', validateApiKey, widgetLimiter, async (req, res) => {
  const chatbotId = req.params.id;
  const apiKeyData = req.apiKeyData;

  // Check if API key is scoped to this chatbot
  if (apiKeyData.chatbotId && apiKeyData.chatbotId !== chatbotId) {
    return res.status(403).json({ error: 'API key not valid for this chatbot' });
  }

  const chatbot = await prisma.chatbot.findFirst({
    where: {
      id: chatbotId,
      userId: req.user.id,
      status: 'ACTIVE'
    },
    select: {
      id: true,
      name: true,
      clinicData: true,
      theme: true,
      bookingEnabled: true,
      bookingFields: true,
      welcomeMessage: true,
      pageDisplayMode: true,
      allowedPages: true
    }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  // Track widget load
  prisma.usageRecord.create({
    data: {
      userId: req.user.id,
      chatbotId: chatbot.id,
      eventType: 'WIDGET_LOAD',
      date: new Date()
    }
  }).catch(err => console.error('Failed to track widget load:', err));

  // Add welcome message to clinicData for widget
  const clinicDataWithWelcome = {
    ...chatbot.clinicData,
    welcomeMessage: chatbot.welcomeMessage
  };

  res.json({
    id: chatbot.id,
    name: chatbot.name,
    clinicData: clinicDataWithWelcome,
    theme: chatbot.theme,
    bookingEnabled: chatbot.bookingEnabled,
    bookingFields: chatbot.bookingFields,
    pageDisplayMode: chatbot.pageDisplayMode,
    allowedPages: chatbot.allowedPages
  });
});

// Widget chat endpoint (API key auth)
app.post('/api/widget/chat/stream', validateApiKey, widgetLimiter, async (req, res) => {
  const { chatbotId, conversationHistory, message, sessionId } = req.body;
  const user = req.user;
  const apiKeyData = req.apiKeyData;

  if (!chatbotId) return res.status(400).json({ error: 'Chatbot ID required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Check if API key is scoped to this chatbot
  if (apiKeyData.chatbotId && apiKeyData.chatbotId !== chatbotId) {
    return res.status(403).json({ error: 'API key not valid for this chatbot' });
  }

  // Get chatbot
  const chatbot = await prisma.chatbot.findFirst({
    where: {
      id: chatbotId,
      userId: user.id,
      status: 'ACTIVE'
    }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  // Get or create conversation
  const visitorSession = sessionId || 'anonymous';
  let conversation;
  try {
    conversation = await prisma.conversation.upsert({
      where: {
        chatbotId_sessionId: { chatbotId, sessionId: visitorSession }
      },
      create: {
        chatbotId,
        sessionId: visitorSession,
        visitorIp: req.ip,
        visitorUserAgent: req.headers['user-agent']
      },
      update: { updatedAt: new Date() }
    });
  } catch (error) {
    console.error('Failed to create conversation:', error);
  }

  // Reconstruct clinicData
  const clinicData = {
    ...chatbot.clinicData,
    raw_content: chatbot.rawContent
  };

  // Get custom AI settings including communication style
  const aiOptions = {
    systemPrompt: chatbot.systemPrompt || null,
    customKnowledge: chatbot.customKnowledge || null,
    communicationStyle: chatbot.communicationStyle || 'PROFESSIONAL',
    language: chatbot.language || 'auto',
    customGreeting: chatbot.customGreeting || null,
    bookingEnabled: chatbot.bookingEnabled || false,
    bookingFields: chatbot.bookingFields || ['name', 'email', 'phone', 'service', 'preferredDate', 'notes'],
    bookingPromptMessage: chatbot.bookingPromptMessage || null
  };

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const prepared = await prepareChatMessages(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      aiOptions
    );

    // Tool-call detection for booking (before streaming)
    let bookingToolCall = false;
    if (chatbot.bookingEnabled && OPENAI_API_KEY) {
      try {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const tools = [
          {
            type: 'function',
            function: {
              name: 'show_booking_form',
              description: 'Display the booking form to allow the user to schedule an appointment, demo, consultation, or any kind of reservation.',
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
          }
        ];

        const toolMessages = [
          { role: 'system', content: 'If the user wants to book or schedule an appointment, call the show_booking_form tool.' },
          ...prepared.messages
        ];

        const toolResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: toolMessages,
          tools,
          tool_choice: 'auto',
          max_tokens: 200,
          temperature: 0.2
        });

        const toolCall = toolResponse.choices[0]?.message?.tool_calls?.[0];
        if (toolCall?.function?.name === 'show_booking_form') {
          bookingToolCall = true;
          res.write(`data: ${JSON.stringify({ toolCall: 'show_booking_form' })}\n\n`);
        }
      } catch (toolError) {
        console.error('Tool call detection error:', toolError);
      }
    }

    const stream = generateChatResponseStream(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      { ...aiOptions, prepared }
    );

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // Save messages to conversation
    if (conversation) {
      await prisma.message.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', content: message },
          { conversationId: conversation.id, role: 'assistant', content: fullResponse }
        ]
      });
    }

    // Try to auto-submit booking if user provided info and booking intent was detected
    if (bookingToolCall) {
      try {
        const booking = await tryAutoSubmitBooking(chatbot, conversationHistory, message, user.id);
        if (booking) {
          console.log(`Widget auto-submitted booking ${booking.id} for chatbot ${chatbotId}`);
          res.write(`data: ${JSON.stringify({ bookingSubmitted: true, bookingId: booking.id })}\n\n`);
        }
      } catch (bookingError) {
        console.error('Widget auto-booking error:', bookingError);
      }
    }

    // Increment usage
    await prisma.user.update({
      where: { id: user.id },
      data: { messagesUsed: { increment: 1 } }
    });

    // Track usage
    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        chatbotId: chatbot.id,
        eventType: 'CHAT_MESSAGE',
        date: new Date()
      }
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Widget stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// Widget booking submission endpoint (API key auth) - with strict rate limiting
app.post('/api/widget/booking', validateApiKey, strictLimiter, async (req, res) => {
  const { chatbotId, conversationHistory, bookingData, sessionId } = req.body;
  const user = req.user;
  const apiKeyData = req.apiKeyData;

  // Validate chatbot ID format
  if (!chatbotId || !validateChatbotId(chatbotId)) {
    return res.status(400).json({ error: 'Invalid chatbot ID format', code: 'INVALID_CHATBOT_ID' });
  }

  // Check if API key is scoped to this chatbot
  if (apiKeyData.chatbotId && apiKeyData.chatbotId !== chatbotId) {
    return res.status(403).json({ error: 'API key not valid for this chatbot' });
  }

  // Get chatbot with notification settings
  const chatbot = await prisma.chatbot.findFirst({
    where: {
      id: chatbotId,
      userId: user.id,
      status: 'ACTIVE'
    }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  if (!chatbot.bookingEnabled) {
    return res.status(400).json({ error: 'Booking is not enabled for this chatbot' });
  }

  try {
    // If conversationHistory provided, extract booking data from conversation
    let finalBookingData = bookingData || {};
    
    if (conversationHistory && conversationHistory.length > 0 && OPENAI_API_KEY) {
      const extracted = await extractBookingData(OPENAI_API_KEY, conversationHistory);
      // Merge extracted with provided data (provided takes precedence)
      finalBookingData = {
        customerName: bookingData?.customerName || extracted.customerName,
        customerEmail: bookingData?.customerEmail || extracted.customerEmail,
        customerPhone: bookingData?.customerPhone || extracted.customerPhone,
        service: bookingData?.service || extracted.service,
        preferredDate: bookingData?.preferredDate || extracted.preferredDate,
        preferredTime: bookingData?.preferredTime || extracted.preferredTime,
        notes: bookingData?.notes || extracted.notes,
        ...bookingData
      };
    }

    // Sanitize all booking data
    finalBookingData = sanitizeBookingData(finalBookingData);

    // Validate we have minimum required data
    if (!finalBookingData.customerName && !finalBookingData.customerPhone && !finalBookingData.customerEmail) {
      return res.status(400).json({ 
        error: 'Insufficient booking data. At least name, phone, or email is required.',
        code: 'INSUFFICIENT_DATA'
      });
    }

    // Get conversation ID if exists
    let conversationId = null;
    if (sessionId) {
      const conversation = await prisma.conversation.findUnique({
        where: {
          chatbotId_sessionId: { chatbotId, sessionId }
        }
      });
      conversationId = conversation?.id;
    }

    // Create booking request
    const booking = await prisma.bookingRequest.create({
      data: {
        chatbotId,
        conversationId,
        customerName: finalBookingData.customerName || null,
        customerEmail: finalBookingData.customerEmail || null,
        customerPhone: finalBookingData.customerPhone || null,
        service: finalBookingData.service || null,
        preferredDate: finalBookingData.preferredDate || null,
        preferredTime: finalBookingData.preferredTime || null,
        notes: finalBookingData.notes || null,
        data: finalBookingData,
        status: 'PENDING'
      }
    });

    // Track usage
    await prisma.usageRecord.create({
      data: {
        userId: user.id,
        chatbotId,
        eventType: 'BOOKING_REQUEST',
        date: new Date()
      }
    });

    // Send notifications
    let notificationResults = {};
    if (chatbot.notifyOnBooking) {
      notificationResults = await sendBookingNotifications(booking, chatbot);
      
      // Update booking with notification status
      const emailSuccess = notificationResults.email?.success;
      const webhookSuccess = notificationResults.webhook?.success;
      
      await prisma.bookingRequest.update({
        where: { id: booking.id },
        data: {
          status: (emailSuccess || webhookSuccess) ? 'NOTIFIED' : 'PENDING',
          notificationSent: emailSuccess || webhookSuccess || false,
          notificationSentAt: (emailSuccess || webhookSuccess) ? new Date() : null,
          notificationError: notificationResults.email?.error || notificationResults.webhook?.error || null
        }
      });
    }

    // Create Google Calendar event
    let calendarResult = { success: false };
    try {
      calendarResult = await createCalendarEvent(booking, chatbot);
      if (calendarResult.success) {
        // Update booking with calendar event ID
        await prisma.bookingRequest.update({
          where: { id: booking.id },
          data: {
            data: {
              ...finalBookingData,
              calendarEventId: calendarResult.eventId,
              calendarEventLink: calendarResult.eventLink
            }
          }
        });
      }
    } catch (calendarError) {
      console.error('Calendar event creation error:', calendarError);
    }

    console.log(`Booking created: ${booking.id} for chatbot ${chatbotId}`);
    console.log(`  Customer: ${finalBookingData.customerName || 'N/A'}`);
    console.log(`  Phone: ${finalBookingData.customerPhone || 'N/A'}`);
    console.log(`  Service: ${finalBookingData.service || 'N/A'}`);
    console.log(`  Notifications:`, notificationResults);
    console.log(`  Calendar:`, calendarResult);

    res.json({
      success: true,
      bookingId: booking.id,
      notified: notificationResults.email?.success || notificationResults.webhook?.success || false,
      calendarEvent: calendarResult.success ? {
        eventId: calendarResult.eventId,
        eventLink: calendarResult.eventLink
      } : null
    });

  } catch (error) {
    console.error('Booking submission error:', error);
    res.status(500).json({ error: 'Failed to submit booking request' });
  }
});

// Widget endpoint to get available time slots (API key auth)
app.get('/api/widget/availability/:date', validateApiKey, widgetLimiter, async (req, res) => {
  const { date } = req.params;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    const result = await getAvailableSlots(date);
    res.json(result);
  } catch (error) {
    console.error('Availability check error:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// ============================================
// LEGACY CHAT ENDPOINT (for backward compatibility during transition)
// ============================================

app.post('/api/chat', async (req, res) => {
  const { apiKey, clinicData, conversationHistory, message } = req.body;

  const key = apiKey || OPENAI_API_KEY;
  if (!key) return res.status(400).json({ error: 'API key required' });
  if (!clinicData) return res.status(400).json({ error: 'Clinic data required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const response = await generateChatResponse(
      key,
      clinicData,
      conversationHistory || [],
      message
    );

    if (!response.success) {
      return res.status(400).json(response);
    }

    res.json(response);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║     XELOCHAT API                             ║
║     Running on port ${PORT}                      ║
║     Auth: Auth0 JWT + API Keys               ║
╚══════════════════════════════════════════════╝
  `);
});
