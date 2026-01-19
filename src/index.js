import express from 'express';
import cors from 'cors';
import { scrapeClinicWebsite } from './scraper/scraper.js';
import { normalizeClinicData } from './scraper/normalizer.js';
import { extractWithLLM, mergeExtractedData } from './scraper/extractor.js';
import { generateChatResponse, generateWelcomeMessage, generateChatResponseStream } from './chat/chatbot.js';
import prisma from './services/prisma.js';
import { protectedRoute, checkChatbotLimit, checkMessageLimit } from './middleware/auth.js';
import { validateApiKey } from './middleware/apiKey.js';
import { apiLimiter, scrapeLimiter, chatLimiter, widgetLimiter } from './middleware/rateLimiter.js';
import chatbotRoutes from './routes/chatbots.js';
import apiKeyRoutes from './routes/apiKeys.js';
import usageRoutes from './routes/usage.js';
import bookingRoutes from './routes/bookings.js';
import { sendBookingNotifications } from './services/notifications.js';
import { extractBookingData } from './chat/chatbot.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// CORS configuration - allow all origins, domain validation done via API key for widgets
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Apply general rate limit
app.use(apiLimiter);

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'sitebot-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
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

    const pages = await scrapeClinicWebsite(url, 10, 25, onProgress);

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
    const pages = await scrapeClinicWebsite(url, 10, 25);

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
    customGreeting: chatbot.customGreeting || null
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
      theme: true
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

  res.json({
    id: chatbot.id,
    name: chatbot.name,
    clinicData: chatbot.clinicData,
    theme: chatbot.theme
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
    bookingEnabled: chatbot.bookingEnabled || false
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

    // Save messages to conversation
    if (conversation) {
      await prisma.message.createMany({
        data: [
          { conversationId: conversation.id, role: 'user', content: message },
          { conversationId: conversation.id, role: 'assistant', content: fullResponse }
        ]
      });
    }

    // Try to auto-submit booking if user provided info
    try {
      const booking = await tryAutoSubmitBooking(chatbot, conversationHistory, message, user.id);
      if (booking) {
        console.log(`Widget auto-submitted booking ${booking.id} for chatbot ${chatbotId}`);
        res.write(`data: ${JSON.stringify({ bookingSubmitted: true, bookingId: booking.id })}\n\n`);
      }
    } catch (bookingError) {
      console.error('Widget auto-booking error:', bookingError);
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

// Widget booking submission endpoint (API key auth)
app.post('/api/widget/booking', validateApiKey, widgetLimiter, async (req, res) => {
  const { chatbotId, conversationHistory, bookingData, sessionId } = req.body;
  const user = req.user;
  const apiKeyData = req.apiKeyData;

  if (!chatbotId) return res.status(400).json({ error: 'Chatbot ID required' });

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

    console.log(`Booking created: ${booking.id} for chatbot ${chatbotId}`);
    console.log(`  Customer: ${finalBookingData.customerName || 'N/A'}`);
    console.log(`  Phone: ${finalBookingData.customerPhone || 'N/A'}`);
    console.log(`  Service: ${finalBookingData.service || 'N/A'}`);
    console.log(`  Notifications:`, notificationResults);

    res.json({
      success: true,
      bookingId: booking.id,
      notified: notificationResults.email?.success || notificationResults.webhook?.success || false
    });

  } catch (error) {
    console.error('Booking submission error:', error);
    res.status(500).json({ error: 'Failed to submit booking request' });
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
║     SITEBOT API                              ║
║     Running on port ${PORT}                      ║
║     Auth: Auth0 JWT + API Keys               ║
╚══════════════════════════════════════════════╝
  `);
});
