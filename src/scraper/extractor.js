import OpenAI from 'openai';
import { UTILITY_MODEL } from '../config/ai.js';

/**
 * LLM-based data extraction
 * Uses the configured utility model to extract structured clinic data from scraped content
 */

const EXTRACTION_PROMPT = `You are a data extraction assistant. Extract ALL useful information from the website content below.

RULES:
- Extract EVERYTHING that could help answer questions about this business
- If something is not found, use null
- For services: extract ALL offerings, even without prices. Use "Contact for pricing" if no price.
- Be thorough - extract every service, feature, benefit, and capability mentioned

Return JSON with this structure:
{
  "clinic_name": "Business/company name",
  "address": "Address or location (city, country)",
  "phone": "Phone number",
  "email": "Email address",
  "opening_hours": "Opening hours if mentioned",
  "services": [
    {"name": "Service/product name", "price": "Price or 'Contact for pricing'", "category": "Brief description of what it is/does"}
  ],
  "doctors": [
    {"name": "Person's name", "specialization": "Their role/title"}
  ],
  "about": "What the business does, who it helps, its mission/approach (2-3 sentences)",
  "key_benefits": ["Benefit 1", "Benefit 2", "..."],
  "target_audience": "Who this business serves",
  "unique_approach": "What makes this business different or their methodology",
  "faq": [
    {"question": "Common question", "answer": "Answer from content"}
  ],
  "testimonials_summary": "Summary of what clients say if testimonials exist",
  "additional_info": "Any other important info (policies, guarantees, etc.)"
}

SCRAPED CONTENT:
`;

/**
 * Extract structured data using LLM
 */
export async function extractWithLLM(apiKey, rawContent, pageData) {
  const client = new OpenAI({ apiKey });

  // Simply include ALL pages - let the LLM figure out what's important
  // Sort by content length (most content first) to prioritize richer pages
  const sortedPages = [...pageData].sort((a, b) =>
    (b.content?.length || 0) - (a.content?.length || 0)
  );

  const contentChunks = [];
  let totalChars = 0;
  const maxTotalChars = 60000;

  for (const page of sortedPages) {
    if (totalChars >= maxTotalChars) break;

    const remainingChars = maxTotalChars - totalChars;
    const pageContent = page.content?.slice(0, Math.min(remainingChars, 8000)) || '';

    if (pageContent.length > 50) { // Skip nearly empty pages
      contentChunks.push(`=== PAGE: ${page.title || page.url} ===\nURL: ${page.url}\n${pageContent}`);
      totalChars += pageContent.length + 100; // +100 for headers
    }
  }

  // Add any extracted prices from scraper
  const allPrices = pageData.flatMap(p => p.prices || []);
  if (allPrices.length > 0 && totalChars < maxTotalChars) {
    contentChunks.push(`=== EXTRACTED PRICES ===\n${allPrices.map(p => p.text).join('\n')}`);
  }

  const combinedContent = contentChunks.join('\n\n---\n\n');

  try {
    console.log('Extracting data with LLM...');
    console.log(`  - Content chunks: ${contentChunks.length}`);
    console.log(`  - Total content length: ${combinedContent.length} chars`);
    console.log(`  - Pages included: ${contentChunks.length}`);

    const response = await client.chat.completions.create({
      model: UTILITY_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You extract structured data from website content. Always respond with valid JSON only, no markdown.'
        },
        {
          role: 'user',
          content: EXTRACTION_PROMPT + combinedContent
        }
      ],
      max_tokens: 4000,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });

    const extracted = JSON.parse(response.choices[0].message.content);
    console.log(`LLM extracted: ${extracted.clinic_name}, ${extracted.services?.length || 0} services, ${extracted.doctors?.length || 0} doctors`);

    return extracted;

  } catch (error) {
    console.error('LLM extraction error:', error.message);
    return null;
  }
}

/**
 * Merge LLM-extracted data with regex-extracted data
 * LLM data takes priority, regex fills gaps
 */
export function mergeExtractedData(llmData, regexData) {
  if (!llmData) return regexData;

  // Merge services, preferring LLM details but keeping any extra regex services
  const mergedServices = (() => {
    const llmServices = Array.isArray(llmData.services) ? llmData.services : [];
    const regexServices = Array.isArray(regexData.services) ? regexData.services : [];

    // If LLM returned nothing, fall back to regex only
    if (llmServices.length === 0) return regexServices;

    const seen = new Set();

    const addService = (svc) => {
      const key = (svc.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({
        name: svc.name || '',
        price: svc.price || '',
        category: svc.category || ''
      });
    };

    const merged = [];
    llmServices.forEach(addService);
    regexServices.forEach(addService);

    return merged;
  })();

  // Merge doctors/team members
  const mergedDoctors = (() => {
    const llmDoctors = Array.isArray(llmData.doctors) ? llmData.doctors : [];
    const regexDoctors = Array.isArray(regexData.doctors) ? regexData.doctors : [];

    const seen = new Set();
    const merged = [];

    const addDoctor = (doc) => {
      const key = (doc.name || '').toLowerCase().trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push({
        name: doc.name || '',
        specialization: doc.specialization || ''
      });
    };

    llmDoctors.forEach(addDoctor);
    regexDoctors.forEach(addDoctor);

    return merged;
  })();

  // Merge FAQ
  const mergedFaq = (() => {
    const llmFaq = Array.isArray(llmData.faq) ? llmData.faq : [];
    const regexFaq = Array.isArray(regexData.faq) ? regexData.faq : [];
    return [...llmFaq, ...regexFaq];
  })();

  return {
    clinic_name: llmData.clinic_name || regexData.clinic_name,
    address: llmData.address || regexData.address,
    phone: llmData.phone || regexData.phone,
    email: llmData.email || regexData.email,
    opening_hours: llmData.opening_hours || regexData.opening_hours,
    services: mergedServices,
    doctors: mergedDoctors,
    faq: mergedFaq,
    source_pages: regexData.source_pages,
    raw_content: regexData.raw_content,
    // New fields from improved extraction
    about: llmData.about || '',
    key_benefits: Array.isArray(llmData.key_benefits) ? llmData.key_benefits : [],
    target_audience: llmData.target_audience || '',
    unique_approach: llmData.unique_approach || '',
    testimonials_summary: llmData.testimonials_summary || '',
    additional_info: llmData.additional_info || ''
  };
}
