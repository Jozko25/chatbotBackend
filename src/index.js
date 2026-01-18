import express from 'express';
import cors from 'cors';
import { scrapeClinicWebsite } from './scraper/scraper.js';
import { normalizeClinicData } from './scraper/normalizer.js';
import { extractWithLLM, mergeExtractedData } from './scraper/extractor.js';
import { generateChatResponse, generateWelcomeMessage, generateChatResponseStream } from './chat/chatbot.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
const PORT = process.env.PORT || 3001;

// CORS for frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'clinic-chatbot-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Check if API key is configured on server
app.get('/api/config', (req, res) => {
  res.json({ hasApiKey: !!OPENAI_API_KEY });
});

// Scrape endpoint
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping: ${url}`);
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
    } else {
      console.log('No OPENAI_API_KEY set, skipping LLM extraction');
    }

    const welcomeMessage = generateWelcomeMessage(clinicData);

    console.log(`\nResults:`);
    console.log(`  - Clinic: ${clinicData.clinic_name}`);
    console.log(`  - Pages: ${clinicData.source_pages.length}`);
    console.log(`  - Services: ${clinicData.services.length}`);
    console.log(`  - Doctors: ${clinicData.doctors.length}\n`);

    res.json({ ...clinicData, welcomeMessage });

  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: `Scraping failed: ${error.message}` });
  }
});

// Chat endpoint
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

// Streaming chat endpoint using SSE
app.post('/api/chat/stream', async (req, res) => {
  const { apiKey, clinicData, conversationHistory, message } = req.body;

  const key = apiKey || OPENAI_API_KEY;
  if (!key) return res.status(400).json({ error: 'API key required' });
  if (!clinicData) return res.status(400).json({ error: 'Clinic data required' });
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const stream = generateChatResponseStream(
      key,
      clinicData,
      conversationHistory || [],
      message
    );

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║     CLINIC CHATBOT API                       ║
║     Running on port ${PORT}                      ║
╚══════════════════════════════════════════════╝
  `);
});
