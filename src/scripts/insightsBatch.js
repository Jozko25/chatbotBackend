import OpenAI from 'openai';
import prisma from '../services/prisma.js';
import { INSIGHTS_MODEL } from '../config/ai.js';

const DEFAULT_DAYS = 30;
const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;
const CONCURRENCY = 3;

const parseNumberArg = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const rangeDays =
  parseNumberArg(process.env.INSIGHTS_RANGE_DAYS, DEFAULT_DAYS) ||
  parseNumberArg(process.argv[2], DEFAULT_DAYS) ||
  DEFAULT_DAYS;

const now = new Date();
const rangeStart = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.error('Missing OPENAI_API_KEY. Cannot generate insights.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: openaiApiKey });

const runWithConcurrency = async (items, limit, handler) => {
  const results = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }).map(async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      const result = await handler(current);
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
};

const buildPrompt = ({ services, messages }) => {
  const serviceList = services.length > 0 ? services.join(', ') : 'none';
  const joined = messages.join('\n');

  return {
    system: `You analyze user chat messages and output anonymized insights only.
Return a JSON object with keys:
- asked_services: array of short service names the user asked about (prefer matching provided services list).
- cant_find: array of short items the user says they cannot find on the website.
- not_offered: array of short service names the user asked for that are NOT in the provided services list.
- pricing_question: boolean
- location_question: boolean
- booking_intent: boolean
Rules:
- Use lowercase short phrases, max 5 words each.
- If nothing found, use empty arrays and false booleans.
- Output JSON only.`,
    user: `Known services list: ${serviceList}

User messages (most recent last):
${joined}`
  };
};

const normalizePhrases = (values) =>
  Array.isArray(values)
    ? values
        .filter((value) => typeof value === 'string')
        .map((value) => value.toLowerCase().trim())
        .filter((value) => value.length > 1)
    : [];

const analyzeConversation = async (services, messages) => {
  const prompt = buildPrompt({ services, messages });
  try {
    const response = await openai.chat.completions.create({
      model: INSIGHTS_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 300
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    return {
      askedServices: normalizePhrases(parsed.asked_services),
      cantFind: normalizePhrases(parsed.cant_find),
      notOffered: normalizePhrases(parsed.not_offered),
      pricingQuestion: Boolean(parsed.pricing_question),
      locationQuestion: Boolean(parsed.location_question),
      bookingIntent: Boolean(parsed.booking_intent)
    };
  } catch (error) {
    console.error('[Insights] LLM parse failed:', error.message);
    return {
      askedServices: [],
      cantFind: [],
      notOffered: [],
      pricingQuestion: false,
      locationQuestion: false,
      bookingIntent: false
    };
  }
};

const truncateMessages = (messages) => {
  const limited = messages.slice(-MAX_MESSAGES);
  let total = 0;
  const result = [];
  for (const message of limited) {
    const remaining = MAX_CHARS - total;
    if (remaining <= 0) break;
    const chunk = message.slice(0, remaining);
    result.push(chunk);
    total += chunk.length;
  }
  return result;
};

const incrementMap = (map, key) => {
  map.set(key, (map.get(key) || 0) + 1);
};

const topList = (map, limit = 8) =>
  [...map.entries()]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

const run = async () => {
  const chatbots = await prisma.chatbot.findMany({
    where: { status: { not: 'DELETED' } },
    select: { id: true, clinicData: true }
  });

  console.log(`[Insights] Running batch for ${chatbots.length} chatbots (last ${rangeDays} days).`);

  for (const chatbot of chatbots) {
    const services = Array.isArray(chatbot.clinicData?.services)
      ? chatbot.clinicData.services
          .map((service) => service?.name)
          .filter((name) => typeof name === 'string' && name.trim().length > 0)
      : [];

    const messages = await prisma.message.findMany({
      where: {
        role: 'user',
        createdAt: { gte: rangeStart, lte: now },
        conversation: { chatbotId: chatbot.id }
      },
      select: { conversationId: true, content: true },
      orderBy: { createdAt: 'asc' }
    });

    if (messages.length === 0) {
      console.log(`[Insights] ${chatbot.id}: no messages, skipping.`);
      continue;
    }

    const bookingCount = await prisma.bookingRequest.count({
      where: { chatbotId: chatbot.id, createdAt: { gte: rangeStart, lte: now } }
    });

    const grouped = new Map();
    for (const message of messages) {
      if (!message.content) continue;
      if (!grouped.has(message.conversationId)) {
        grouped.set(message.conversationId, []);
      }
      grouped.get(message.conversationId).push(message.content);
    }

    const conversationEntries = [...grouped.values()].map(truncateMessages);
    const results = await runWithConcurrency(conversationEntries, CONCURRENCY, (entry) =>
      analyzeConversation(services, entry)
    );

    const askedMap = new Map();
    const cantFindMap = new Map();
    const notOfferedMap = new Map();
    let pricingQuestions = 0;
    let locationQuestions = 0;

    for (const result of results) {
      result.askedServices.forEach((item) => incrementMap(askedMap, item));
      result.cantFind.forEach((item) => incrementMap(cantFindMap, item));
      result.notOffered.forEach((item) => incrementMap(notOfferedMap, item));
      if (result.pricingQuestion) pricingQuestions += 1;
      if (result.locationQuestion) locationQuestions += 1;
    }

    const insightRecord = {
      chatbotId: chatbot.id,
      rangeDays,
      rangeStart,
      rangeEnd: now,
      totalMessages: messages.length,
      pricingQuestions,
      locationQuestions,
      bookingCount,
      topServices: topList(askedMap),
      notProvidedServices: topList(notOfferedMap),
      couldntFindServices: topList(cantFindMap)
    };

    await prisma.chatbotInsight.create({ data: insightRecord });
    console.log(`[Insights] ${chatbot.id}: saved.`);
  }
};

run()
  .then(() => {
    console.log('[Insights] Batch finished.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[Insights] Batch failed:', error);
    process.exit(1);
  });
