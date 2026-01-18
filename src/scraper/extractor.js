import OpenAI from 'openai';

/**
 * LLM-based data extraction
 * Uses GPT-4o-mini to intelligently extract structured clinic data from scraped content
 */

const EXTRACTION_PROMPT = `You are a data extraction assistant. Analyze the following scraped website content and extract structured information about the business.

IMPORTANT RULES:
- Only extract information that is EXPLICITLY stated in the content
- If information is not found, use null
- For prices, include the currency symbol (€, $, Kč, etc.) and "from" if it's a starting price
- For opening hours, preserve the exact format from the website
- Extract ALL products/services with prices you can find
- Extract ALL team/staff members with their roles if mentioned
- This could be ANY type of business: car dealership, e-commerce, SaaS, restaurant, clinic, etc.

EXTRACTION TIPS:
- For car dealerships: Extract car models as products (e.g., "GLE 450d 4MATIC" with starting price)
- For e-commerce: Extract products with their prices and categories
- For clinics: Extract treatments/procedures with prices
- For SaaS: Extract plans/tiers with their pricing
- Clean up concatenated text (e.g., "Konfigurovať vozidloZistiť viacGLE" → just "GLE")
- If you see patterns like "cena od X €" extract it as "from X €"
- Extract key specifications when available (engine, features, capacity, etc.) in the category field

Return a JSON object with this exact structure:
{
  "clinic_name": "The official name of the business/company (not taglines or slogans)",
  "address": "Full address if found",
  "phone": "Primary phone number",
  "email": "Primary email",
  "opening_hours": "Opening hours exactly as stated, preserve formatting",
  "services": [
    {"name": "Clean product/service name", "price": "Price with currency (use 'from X €' for starting prices)", "category": "Category or key specs"}
  ],
  "doctors": [
    {"name": "Full name with title if any", "specialization": "Their role/specialty"}
  ],
  "additional_info": "Any other important business information (shipping, policies, etc.)"
}

SCRAPED CONTENT:
`;

/**
 * Extract structured data using LLM
 */
export async function extractWithLLM(apiKey, rawContent, pageData) {
  const client = new OpenAI({ apiKey });

  // Prepare content for extraction - prioritize important pages
  const contentChunks = [];

  // Add homepage/main content first
  const homepage = pageData.find(p =>
    p.url.match(/\/$/) || p.url.match(/\.sk\/?$/) || p.url.match(/\.com\/?$/)
  );
  if (homepage) {
    contentChunks.push(`=== HOMEPAGE ===\nTitle: ${homepage.title}\nURL: ${homepage.url}\n${homepage.content?.slice(0, 3000)}`);
  }

  // Add contact page
  const contactPage = pageData.find(p => /kontakt|contact/i.test(p.url));
  if (contactPage) {
    contentChunks.push(`=== CONTACT PAGE ===\nTitle: ${contactPage.title}\n${contactPage.content?.slice(0, 2000)}`);
  }

  // Add pricing pages
  const pricingPages = pageData.filter(p => /cennik|cenik|price|ceny/i.test(p.url));
  pricingPages.forEach(p => {
    contentChunks.push(`=== PRICING: ${p.title} ===\n${p.content?.slice(0, 4000)}`);
  });

  // Add team/about pages
  const teamPages = pageData.filter(p => /team|tim|about|o-nas|lekar|doctor/i.test(p.url));
  teamPages.forEach(p => {
    contentChunks.push(`=== TEAM/ABOUT: ${p.title} ===\n${p.content?.slice(0, 3000)}`);
  });

  // Add product/model pages (for car dealerships, e-commerce, etc.)
  const productPages = pageData.filter(p => /models|model|product|vozidl|sedan|suv|coupe|kombi|hatchback/i.test(p.url));
  productPages.forEach(p => {
    contentChunks.push(`=== PRODUCTS/MODELS: ${p.title} ===\n${p.content?.slice(0, 4000)}`);
  });

  // Add any extracted prices from scraper
  const allPrices = pageData.flatMap(p => p.prices || []);
  if (allPrices.length > 0) {
    contentChunks.push(`=== EXTRACTED PRICES ===\n${allPrices.map(p => p.text).join('\n')}`);
  }

  // Combine and limit total content
  const combinedContent = contentChunks.join('\n\n---\n\n').slice(0, 25000);

  try {
    console.log('Extracting data with LLM...');

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
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
    regexServices.forEach(addService); // add missing tail items from regex scrape

    return merged;
  })();

  // Merge doctors: keep LLM enrichments but don't drop regex doctors
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

    // If both are empty, return empty array to keep shape consistent
    return merged;
  })();

  return {
    clinic_name: llmData.clinic_name || regexData.clinic_name,
    address: llmData.address || regexData.address,
    phone: llmData.phone || regexData.phone,
    email: llmData.email || regexData.email,
    opening_hours: llmData.opening_hours || regexData.opening_hours,
    services: mergedServices,
    doctors: mergedDoctors,
    faq: regexData.faq || [],
    source_pages: regexData.source_pages,
    raw_content: regexData.raw_content,
    additional_info: llmData.additional_info || ''
  };
}
