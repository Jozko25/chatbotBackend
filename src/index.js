console.log('🚀🚀🚀 LOADING INDEX.JS - CLAUDE EDIT CONFIRMED 🚀🚀🚀');

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
import { apiLimiter, scrapeLimiter, chatLimiter, widgetLimiter, strictLimiter, demoScrapeLimiter, demoChatLimiter } from './middleware/rateLimiter.js';
import { validateChatbotId, sanitizeBookingData } from './middleware/validation.js';
import chatbotRoutes from './routes/chatbots.js';
import apiKeyRoutes from './routes/apiKeys.js';
import usageRoutes from './routes/usage.js';
import bookingRoutes from './routes/bookings.js';
import billingRoutes from './routes/billing.js';
import stripeWebhookRoutes from './routes/stripeWebhook.js';
import accountRoutes from './routes/account.js';
import integrationsRoutes from './routes/integrations.js';
import { sendBookingNotifications } from './services/notifications.js';
import { extractBookingData } from './chat/chatbot.js';
import { CHAT_MODEL, UTILITY_MODEL } from './config/ai.js';
import { normalizeWebsiteUrl } from './utils/url.js';
import { createCalendarEvent, getAvailableSlots } from './services/googleCalendar.js';
import { createUserCalendarEvent, getUserAvailableSlots } from './services/userCalendar.js';

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

// CORS configuration - strict for dashboard, open for widget endpoints.
const rawAllowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.CORS_ALLOWED_ORIGINS
].filter(Boolean).join(',');
const allowedOrigins = rawAllowedOrigins
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const strictCors = cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    const normalizedOrigin = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  maxAge: 86400 // 24 hours
});

const widgetCors = cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  maxAge: 86400
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/widget')) {
    return widgetCors(req, res, next);
  }
  return strictCors(req, res, next);
});

// Stripe webhooks require the raw body for signature verification
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

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
app.post('/api/demo/chat', strictLimiter, demoChatLimiter, async (req, res) => {
  const startTime = Date.now();
  console.log(`\n🟢 /api/demo/chat REQUEST - ${new Date().toISOString()}`);

  const { messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  const lastMessage = messages[messages.length - 1]?.content || '';
  console.log(`📝 Last message: "${lastMessage}"`);

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
          description: 'Display the booking form when user wants to book, schedule, reserve, make an appointment, or says things like "chcem sa booknut", "objednat", "rezervovat", "book", "schedule".',
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

    const apiStart = Date.now();
    const response = await openai.chat.completions.create({
      model: UTILITY_MODEL,
      messages: [
        { role: 'system', content: systemPrompt + '\n\nIMPORTANT: If the user wants to book, schedule, or make an appointment (in any language - e.g. "chcem sa booknut", "objednat sa", "book", "schedule"), you MUST call the show_booking_form tool.' },
        ...messages
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 500,
      temperature: 0.7
    });
    console.log(`⏱️  OpenAI API: ${Date.now() - apiStart}ms`);

    const choice = response.choices[0];
    const message = choice.message;

    console.log(`🔧 Tool calls:`, message.tool_calls ? JSON.stringify(message.tool_calls.map(t => t.function.name)) : 'none');

    // Check if the AI called a tool
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];

      if (toolCall.function.name === 'show_booking_form') {
        console.log(`🔔 ✅ BOOKING TOOL CALLED - sending button`);
        console.log(`✅ Total time: ${Date.now() - startTime}ms\n`);
        // Return with tool call indicator and a message
        return res.json({
          message: message.content || "Super! Klikni na tlačidlo nižšie a vyplň svoje údaje.",
          toolCall: 'show_booking_form'
        });
      }
    }

    console.log(`❌ No booking tool called`);
    console.log(`✅ Total time: ${Date.now() - startTime}ms\n`);

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

// Demo scrape endpoint with streaming (no auth required, no DB persistence)
app.post('/api/demo/scrape/stream', demoScrapeLimiter, async (req, res) => {
  const { url } = req.body;

  const normalizedUrl = normalizeWebsiteUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(normalizedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  req.setTimeout(0);
  res.setTimeout(0);
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Demo scraping (streaming): ${normalizedUrl}`);
  console.log(`${'='.repeat(50)}`);

  try {
    const onProgress = (progress) => {
      sendEvent(progress.type, progress);
    };

    const pages = await scrapeClinicWebsite(normalizedUrl, 10, 50, onProgress);

    if (!pages || pages.length === 0) {
      sendEvent('error', { error: 'Could not scrape content from this website' });
      res.end();
      return;
    }

    sendEvent('extracting', { step: 'regex', message: 'Extracting data from content...' });
    const regexData = normalizeClinicData(pages, normalizedUrl);

    let clinicData = regexData;
    if (OPENAI_API_KEY) {
      sendEvent('extracting', { step: 'llm', message: 'Using AI to improve data extraction...' });
      const llmData = await extractWithLLM(OPENAI_API_KEY, regexData.raw_content, pages);
      clinicData = mergeExtractedData(llmData, regexData);
    }

    const welcomeMessage = generateWelcomeMessage(clinicData);
    const clinicDataWithWelcome = { ...clinicData, welcomeMessage, sourceUrl: normalizedUrl };

    sendEvent('complete', {
      clinicData: clinicDataWithWelcome,
      name: clinicData.clinic_name || new URL(normalizedUrl).hostname
    });

    res.end();
  } catch (error) {
    console.error('Demo scrape error:', error);
    sendEvent('error', { error: `Scraping failed: ${error.message}` });
    res.end();
  }
});

// Demo chatbot stream for user-created bots (no auth required)
app.post('/api/demo/chatbot/stream', chatLimiter, demoChatLimiter, async (req, res) => {
  const { clinicData, conversationHistory, message } = req.body;

  if (!clinicData) return res.status(400).json({ error: 'clinicData required' });
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key not configured' });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const requestStart = Date.now();
    console.log(`\n========== DEMO CHAT REQUEST ==========`);
    console.log(`[${new Date().toISOString()}] Message: "${message}"`);

    const prepared = prepareChatMessages(
      clinicData,
      conversationHistory || [],
      message,
      { bookingEnabled: true }
    );

    const streamStart = Date.now();
    const stream = generateChatResponseStream(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      { bookingEnabled: true, prepared }
    );

    let firstChunk = true;
    for await (const event of stream) {
      if (event.type === 'content') {
        if (firstChunk) {
          console.log(`[TIMING] First token (TTFT): ${Date.now() - streamStart}ms`);
          firstChunk = false;
        }
        res.write(`data: ${JSON.stringify({ content: event.content })}\n\n`);
      } else if (event.type === 'tool_call' && event.name === 'show_booking_form') {
        res.write(`data: ${JSON.stringify({ toolCall: 'show_booking_form' })}\n\n`);
        console.log(`[DEBUG] Booking tool called`);
      }
    }

    console.log(`[TIMING] Total demo chat: ${Date.now() - requestStart}ms`);
    console.log(`========== DEMO CHAT COMPLETE ==========\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Demo chatbot stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
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
// OAUTH CALLBACKS (public - must be before protected routes)
// ============================================

// OAuth callback needs to be public (no JWT) since user is redirected from Google
app.get('/api/integrations/google-calendar/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

  // Import OAuth functions dynamically
  const { validateState, exchangeCodeForTokens, getUserCalendars, encryptToken } = await import('./services/googleOAuth.js');

  if (oauthError) {
    console.error('Google OAuth error:', oauthError);
    return res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=${encodeURIComponent(oauthError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=missing_params`);
  }

  try {
    const stateResult = validateState(state);
    if (!stateResult.valid) {
      return res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=${encodeURIComponent(stateResult.error)}`);
    }

    const { userId, chatbotId } = stateResult;

    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=user_not_found`);
    }

    // Verify chatbot exists and belongs to user
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId }
    });
    if (!chatbot) {
      return res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=chatbot_not_found`);
    }

    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.accessToken) {
      return res.redirect(`${FRONTEND_URL}/dashboard/chatbots/${chatbotId}?tab=integrations&error=no_access_token`);
    }

    const encryptedAccessToken = encryptToken(tokens.accessToken);
    const encryptedRefreshToken = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;

    let defaultCalendarId = 'primary';
    try {
      const calendars = await getUserCalendars(tokens.accessToken, tokens.refreshToken);
      const primaryCalendar = calendars.find(c => c.primary);
      if (primaryCalendar) defaultCalendarId = primaryCalendar.id;
    } catch (calError) {
      console.error('Failed to get calendars:', calError);
    }

    await prisma.integration.upsert({
      where: { chatbotId_provider: { chatbotId, provider: 'GOOGLE_CALENDAR' } },
      create: {
        userId,
        chatbotId,
        provider: 'GOOGLE_CALENDAR',
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: tokens.expiresAt,
        calendarId: defaultCalendarId,
        isConnected: true,
        settings: {},
        lastSyncAt: new Date()
      },
      update: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: tokens.expiresAt,
        calendarId: defaultCalendarId,
        isConnected: true,
        error: null,
        lastSyncAt: new Date()
      }
    });

    console.log(`Google Calendar connected for chatbot ${chatbotId} (user ${userId})`);
    res.redirect(`${FRONTEND_URL}/dashboard/chatbots/${chatbotId}?tab=integrations&success=google_calendar_connected`);

  } catch (error) {
    console.error('Google Calendar callback error:', error);
    res.redirect(`${FRONTEND_URL}/dashboard/chatbots?error=${encodeURIComponent(error.message)}`);
  }
});

// ============================================
// PROTECTED DASHBOARD ROUTES (JWT auth)
// ============================================

app.use('/api/chatbots', protectedRoute, chatbotRoutes);
app.use('/api/api-keys', protectedRoute, apiKeyRoutes);
app.use('/api/usage', protectedRoute, usageRoutes);
app.use('/api/bookings', protectedRoute, bookingRoutes);
app.use('/api/billing', protectedRoute, billingRoutes);
app.use('/api/account', protectedRoute, accountRoutes);
app.use('/api/integrations', protectedRoute, integrationsRoutes);

// Check user limits endpoint (call before scraping to verify)
app.get('/api/limits', protectedRoute, async (req, res) => {
  const user = req.user;
  const { PLAN_LIMITS } = await import('./config/billing.js');
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

  const normalizedUrl = normalizeWebsiteUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(normalizedUrl);
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
  console.log(`Scraping (streaming): ${normalizedUrl} (user: ${user.email})`);
  console.log(`${'='.repeat(50)}`);

  try {
    // Progress callback for streaming updates
    const onProgress = (progress) => {
      sendEvent(progress.type, progress);
    };

    const pages = await scrapeClinicWebsite(normalizedUrl, 10, 50, onProgress);

    if (!pages || pages.length === 0) {
      sendEvent('error', { error: 'Could not scrape content from this website' });
      res.end();
      return;
    }

    // First pass: regex-based extraction
    sendEvent('extracting', { step: 'regex', message: 'Extracting data from content...' });
    const regexData = normalizeClinicData(pages, normalizedUrl);

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
        name: clinicData.clinic_name || new URL(normalizedUrl).hostname,
        sourceUrl: normalizedUrl,
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

  const normalizedUrl = normalizeWebsiteUrl(url);

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(normalizedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping: ${normalizedUrl} (user: ${user.email})`);
  console.log(`${'='.repeat(50)}`);

  try {
    const pages = await scrapeClinicWebsite(normalizedUrl, 10, 50);

    if (!pages || pages.length === 0) {
      return res.status(400).json({
        error: 'Could not scrape content from this website'
      });
    }

    // First pass: regex-based extraction
    const regexData = normalizeClinicData(pages, normalizedUrl);

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
        name: clinicData.clinic_name || new URL(normalizedUrl).hostname,
        sourceUrl: normalizedUrl,
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

  // Create Google Calendar event (uses user's calendar if connected)
  try {
    const calendarResult = await createUserCalendarEvent(booking, chatbot, userId);
    if (calendarResult.success) {
      console.log(`Calendar event created for auto-booking: ${calendarResult.eventId} (userCalendar: ${calendarResult.userCalendar || false})`);
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

// Preview chat endpoint (authenticated user testing their own chatbot)
app.post('/api/chatbots/:chatbotId/preview/chat', protectedRoute, async (req, res) => {
  const requestStartTime = Date.now();
  const chatbotId = req.params.chatbotId;
  const { conversationHistory, message, sessionId } = req.body;
  const user = req.user;

  console.log(`\n========== PREVIEW CHAT REQUEST ==========`);
  console.log(`[${new Date().toISOString()}] chatbotId=${chatbotId} user=${user.id}`);
  console.log(`Message: "${message}"`);

  if (!message) return res.status(400).json({ error: 'Message required' });

  // Get chatbot (verify ownership)
  const chatbot = await prisma.chatbot.findFirst({
    where: {
      id: chatbotId,
      userId: user.id
    }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
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
    bookingFields: chatbot.bookingFields || ['name', 'email', 'preferredDate', 'preferredTime'],
    bookingPromptMessage: chatbot.bookingPromptMessage || null
  };

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const prepared = prepareChatMessages(
      clinicData,
      conversationHistory || [],
      message,
      aiOptions
    );

    const stream = generateChatResponseStream(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      { ...aiOptions, prepared }
    );

    let fullResponse = '';
    let bookingToolCall = false;

    for await (const event of stream) {
      if (event.type === 'content') {
        fullResponse += event.content;
        res.write(`data: ${JSON.stringify({ content: event.content })}\n\n`);
      } else if (event.type === 'tool_call' && event.name === 'show_booking_form') {
        bookingToolCall = true;
        res.write(`data: ${JSON.stringify({ toolCall: 'show_booking_form' })}\n\n`);
      }
    }

    // If the LLM called the booking tool but produced no text, generate a short reply
    if (bookingToolCall && !fullResponse.trim()) {
      try {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const followUp = await openai.chat.completions.create({
          model: UTILITY_MODEL,
          messages: [
            { role: 'system', content: 'You are a helpful assistant. The user requested a booking and the booking form is now being shown. Write a single short sentence acknowledging this, in the SAME language the user wrote in. Do not ask for details — the form handles that.' },
            { role: 'user', content: message }
          ],
          max_tokens: 60,
          temperature: 0.5
        });
        const fallbackText = followUp.choices[0]?.message?.content || '';
        if (fallbackText) {
          fullResponse = fallbackText;
          res.write(`data: ${JSON.stringify({ content: fallbackText })}\n\n`);
        }
      } catch (fallbackErr) {
        console.error('[ERROR] Preview booking fallback text failed:', fallbackErr.message);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    console.log(`[TIMING] Preview chat total: ${Date.now() - requestStartTime}ms`);
  } catch (error) {
    console.error('[ERROR] Preview chat error:', error.message);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// Widget chat endpoint (API key auth)
app.post('/api/widget/chat/stream', validateApiKey, widgetLimiter, async (req, res) => {
  const requestStartTime = Date.now();
  const { chatbotId, conversationHistory, message, sessionId } = req.body;
  const user = req.user;
  const apiKeyData = req.apiKeyData;

  console.log(`\n========== WIDGET CHAT REQUEST ==========`);
  console.log(`[${new Date().toISOString()}] chatbotId=${chatbotId} sessionId=${sessionId || 'anonymous'}`);
  console.log(`Message: "${message}"`);

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
    // Single-call approach: prepareChatMessages is now synchronous (no intent detection)
    const prepareStart = Date.now();
    const prepared = prepareChatMessages(
      clinicData,
      conversationHistory || [],
      message,
      aiOptions
    );
    console.log(`[TIMING] prepareChatMessages: ${Date.now() - prepareStart}ms`);

    // Single streaming LLM call with integrated tool calling
    const streamStart = Date.now();
    const stream = generateChatResponseStream(
      OPENAI_API_KEY,
      clinicData,
      conversationHistory || [],
      message,
      { ...aiOptions, prepared }
    );

    let fullResponse = '';
    let firstTokenTime = null;
    let bookingToolCall = false;

    for await (const event of stream) {
      if (event.type === 'content') {
        if (!firstTokenTime) {
          firstTokenTime = Date.now();
          console.log(`[TIMING] First token (TTFT): ${firstTokenTime - streamStart}ms`);
        }
        fullResponse += event.content;
        res.write(`data: ${JSON.stringify({ content: event.content })}\n\n`);
      } else if (event.type === 'tool_call' && event.name === 'show_booking_form') {
        bookingToolCall = true;
        res.write(`data: ${JSON.stringify({ toolCall: 'show_booking_form' })}\n\n`);
        console.log(`[TIMING] Booking tool detected by LLM`);
      }
    }
    // If the LLM called the booking tool but produced no text, ask the LLM for a short reply
    if (bookingToolCall && !fullResponse.trim()) {
      try {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const followUpStart = Date.now();
        const followUp = await openai.chat.completions.create({
          model: UTILITY_MODEL,
          messages: [
            { role: 'system', content: 'You are a helpful assistant. The user requested a booking and the booking form is now being shown. Write a single short sentence acknowledging this, in the SAME language the user wrote in. Do not ask for details — the form handles that.' },
            { role: 'user', content: message }
          ],
          max_tokens: 60,
          temperature: 0.5
        });
        const fallbackText = followUp.choices[0]?.message?.content || '';
        console.log(`[TIMING] Booking fallback text: ${Date.now() - followUpStart}ms`);
        if (fallbackText) {
          fullResponse = fallbackText;
          res.write(`data: ${JSON.stringify({ content: fallbackText })}\n\n`);
        }
      } catch (fallbackErr) {
        console.error('[ERROR] Booking fallback text failed:', fallbackErr.message);
      }
    }

    const streamDuration = Date.now() - streamStart;
    console.log(`[TIMING] Full stream duration: ${streamDuration}ms`);
    console.log(`[TIMING] Response length: ${fullResponse.length} chars`);

    // Save messages to conversation
    if (conversation) {
      await prisma.message.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', content: message },
          { conversationId: conversation.id, role: 'assistant', content: fullResponse }
        ]
      });
    }

    // Try to auto-submit booking if the LLM called the booking tool
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

    const totalDuration = Date.now() - requestStartTime;
    console.log(`[TIMING] Total request duration: ${totalDuration}ms`);
    console.log(`========== WIDGET CHAT COMPLETE ==========\n`);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Widget stream error:', error);
    console.log(`[TIMING] Request failed after ${Date.now() - requestStartTime}ms`);
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

    // Create Google Calendar event (uses user's calendar if connected)
    let calendarResult = { success: false };
    try {
      calendarResult = await createUserCalendarEvent(booking, chatbot, user.id);
      if (calendarResult.success) {
        // Update booking with calendar event ID
        await prisma.bookingRequest.update({
          where: { id: booking.id },
          data: {
            data: {
              ...finalBookingData,
              calendarEventId: calendarResult.eventId,
              calendarEventLink: calendarResult.eventLink,
              userCalendar: calendarResult.userCalendar || false
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
    console.log(`  Calendar:`, calendarResult, `(userCalendar: ${calendarResult.userCalendar || false})`);

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
// Uses chatbot's connected calendar if available
app.get('/api/widget/availability/:chatbotId/:date', validateApiKey, widgetLimiter, async (req, res) => {
  const { chatbotId, date } = req.params;
  const user = req.user;
  const apiKeyData = req.apiKeyData;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  // Check if API key is scoped to this chatbot
  if (apiKeyData.chatbotId && apiKeyData.chatbotId !== chatbotId) {
    return res.status(403).json({ error: 'API key not valid for this chatbot' });
  }

  // Verify chatbot exists and belongs to user
  const chatbot = await prisma.chatbot.findFirst({
    where: { id: chatbotId, userId: user.id, status: 'ACTIVE' }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  try {
    // Try chatbot's calendar first, fall back to service account
    const result = await getUserAvailableSlots(date, chatbotId);
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
║     Auth: Clerk JWT + API Keys               ║
╚══════════════════════════════════════════════╝
  `);
});
