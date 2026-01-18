/**
 * Improved Data Normalizer
 * Better extraction of clinic info, services, and prices
 */

/**
 * Extract clinic name from homepage
 */
function extractClinicName(pages) {
  // First try: extract from URL domain (most reliable)
  let nameFromUrl = '';
  try {
    const url = new URL(pages[0].url);
    nameFromUrl = url.hostname.replace('www.', '').split('.')[0];
    // Capitalize first letter
    nameFromUrl = nameFromUrl.charAt(0).toUpperCase() + nameFromUrl.slice(1);
  } catch {}

  // Find the homepage
  const homepage = pages.find(p =>
    p.url.match(/\/$/) ||
    p.url.match(/\/index/i) ||
    p.url.match(/\.sk\/?$/) ||
    p.url.match(/\.com\/?$/) ||
    p.url.match(/\.cz\/?$/)
  ) || pages[0];

  if (!homepage) return nameFromUrl || 'Clinic';

  // Try to find a clean name from title
  let name = homepage.title || '';

  // Extract the brand name (usually before | or -)
  const titleParts = name.split(/\s*[|–—-]\s*/);
  if (titleParts.length > 1) {
    // Find the shortest meaningful part (likely the brand)
    const candidates = titleParts.filter(p => p.length > 2 && p.length < 40);
    if (candidates.length > 0) {
      // Prefer parts that look like names (contain clinic/klinik etc)
      const clinicPart = candidates.find(p => /klinik|clinic|center|centrum/i.test(p));
      name = clinicPart || candidates[candidates.length - 1]; // Often brand is last
    }
  }

  // Clean common noise
  name = name
    .replace(/home|domov|hlavná stránka|úvod|staráme sa o|vaše zdravie a krásu/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If name is weird/long, use URL-based name
  if (name.length < 3 || name.length > 50) {
    name = nameFromUrl;
  }

  return name || 'Clinic';
}

/**
 * Extract services with prices
 */
function extractServices(pages) {
  const services = [];
  const seenNames = new Set();

  // Collect all prices from all pages
  pages.forEach(page => {
    if (page.prices && page.prices.length > 0) {
      page.prices.forEach(priceItem => {
        const name = priceItem.service || priceItem.text.split(/[:–-]/)[0].trim();
        const price = priceItem.price;

        const cleanName = name
          .replace(/^\d+[\.\)]\s*/, '') // Remove numbering
          .replace(/\s+/g, ' ')
          .trim();

        if (cleanName.length > 3 && cleanName.length < 150 && !seenNames.has(cleanName.toLowerCase())) {
          seenNames.add(cleanName.toLowerCase());
          services.push({
            name: cleanName,
            price: price,
            description: ''
          });
        }
      });
    }
  });

  // Also extract from content using patterns
  const servicePatterns = [
    /([A-ZÁ-Ž][a-zá-ž\s\-–]+(?:ošetření|vyšetření|léčba|terapie|lifting|modelácia|omladenie|ošetrenie|procedúra))[:\s–-]+(?:od\s*)?(\d+[\s,.]?\d*)\s*€/gi,
    /([A-ZÁ-Ž][a-zá-ž\s\-–]{5,60})\s+(\d+[\s,.]?\d*)\s*€/gi
  ];

  pages.forEach(page => {
    if (/cennik|price|ceny|sluzby|service/i.test(page.url)) {
      servicePatterns.forEach(pattern => {
        let match;
        const content = page.content;
        while ((match = pattern.exec(content)) !== null) {
          const name = match[1].trim();
          const price = `${match[2]}€`;

          if (name.length > 4 && name.length < 100 && !seenNames.has(name.toLowerCase())) {
            seenNames.add(name.toLowerCase());
            services.push({ name, price, description: '' });
          }
        }
      });
    }
  });

  // Keep all unique services (no arbitrary limit) so we don't drop tail items from long price lists
  return services;
}

/**
 * Extract doctors/staff
 */
function extractDoctors(pages) {
  const doctors = [];
  const seenNames = new Set();

  // Pattern for doctor names with titles
  const doctorPattern = /(?:MUDr\.|MDDr\.|Dr\.med\.univ\.|Dr\.|PhDr\.|Mgr\.|Ing\.|doc\.|prof\.)\s*([A-ZÁ-Ž][a-zá-ž]+(?:\s+[A-ZÁ-Ž][a-zá-ž]+){1,3})(?:[,\s]+(?:Ph\.?D\.?|PhD|MBA|CSc\.?))?/gi;

  // Specialization patterns
  const specPatterns = [
    /plastick[áý]\s*chirurgi[ae]/i,
    /dermatológ|dermatológia/i,
    /stomatológ|stomatológia/i,
    /stomatochirurg|stomatochirurgia/i,
    /gynekológ|gynekológia/i,
    /urológ|urológia/i,
    /neurológ|neurológia/i,
    /cievn[áý]\s*chirurg|cievna chirurgia/i,
    /ORL|otolaryngológ/i,
    /nefrológ|nefrológia/i,
    /psychosomatick/i,
    /všeobecn[ýá]\s*lekár/i
  ];

  pages.forEach(page => {
    let match;
    // Reset regex lastIndex
    doctorPattern.lastIndex = 0;

    while ((match = doctorPattern.exec(page.content)) !== null) {
      const fullName = match[0].split(/[,]/)[0].trim();
      const lastName = match[1].split(/\s+/).pop().toLowerCase(); // Use last name for dedup

      if (!seenNames.has(lastName)) {
        seenNames.add(lastName);

        // Try to find specialization in surrounding context
        const idx = match.index;
        const context = page.content.slice(Math.max(0, idx - 100), idx + 300);

        let specialization = '';
        for (const specPattern of specPatterns) {
          const specMatch = context.match(specPattern);
          if (specMatch) {
            specialization = specMatch[0];
            break;
          }
        }

        doctors.push({
          name: fullName,
          specialization
        });
      }
    }
  });

  return doctors.slice(0, 30);
}

/**
 * Extract contact info
 */
function extractContactInfo(pages) {
  const phones = new Set();
  const emails = new Set();
  let address = '';

  pages.forEach(page => {
    (page.phones || []).forEach(p => phones.add(p.replace(/\s/g, ' ').trim()));
    (page.emails || []).forEach(e => emails.add(e.toLowerCase()));

    // Address extraction
    if (!address) {
      const addressPatterns = [
        /(?:adresa|address)[:\s]*([^,\n]{10,100}(?:,\s*\d{3}\s*\d{2}[^,\n]*)?)/i,
        /([\wá-ž\s]+\s+\d+[\/\d]*\s*,\s*\d{3}\s*\d{2}\s*[\wá-ž\s]+)/i
      ];

      for (const pattern of addressPatterns) {
        const match = page.content.match(pattern);
        if (match) {
          address = match[1].trim();
          break;
        }
      }
    }
  });

  return {
    phones: [...phones].slice(0, 3),
    emails: [...emails].slice(0, 2),
    address
  };
}

/**
 * Extract opening hours
 */
function extractOpeningHours(pages) {
  const hours = [];

  // Better patterns for Slovak opening hours
  const hoursPatterns = [
    // "Pon – Štv: 7:00 – 17:30" style
    /(?:pon(?:delok)?|ut(?:orok)?|str(?:eda)?|štv(?:rtok)?|pia(?:tok)?|sob(?:ota)?|ned(?:eľa)?|po|ut|st|št|pi|so|ne)[\s–\-:]+(?:pon(?:delok)?|ut(?:orok)?|str(?:eda)?|štv(?:rtok)?|pia(?:tok)?|sob(?:ota)?|ned(?:eľa)?|po|ut|st|št|pi|so|ne)?[\s–\-:]*\d{1,2}[:.]\d{2}\s*[–\-]\s*\d{1,2}[:.]\d{2}/gi,
    // "Mon - Fri: 9:00 - 17:00" style
    /(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)[\s–\-:]+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)?[\s–\-:]*\d{1,2}[:.]\d{2}\s*(?:am|pm)?\s*[–\-]\s*\d{1,2}[:.]\d{2}\s*(?:am|pm)?/gi
  ];

  pages.forEach(page => {
    // First check page.hours from scraper
    if (page.hours && page.hours.length > 0) {
      hours.push(...page.hours);
    }

    // Also search content for hour patterns
    hoursPatterns.forEach(pattern => {
      const matches = page.content.match(pattern);
      if (matches) {
        hours.push(...matches);
      }
    });
  });

  // Deduplicate and clean
  const unique = [...new Set(hours.map(h => h.trim()))];

  // Sort to put weekday ranges first
  const sorted = unique.sort((a, b) => {
    const aIsPon = /pon|mon/i.test(a);
    const bIsPon = /pon|mon/i.test(b);
    return bIsPon - aIsPon;
  });

  return sorted.slice(0, 10).join('\n');
}

/**
 * Build raw content for context
 */
function buildRawContent(pages) {
  return pages
    .map(p => {
      let content = `=== ${p.title || p.h1 || 'Page'} ===\nURL: ${p.url}\n`;

      if (p.prices && p.prices.length > 0) {
        content += '\nPRICES:\n' + p.prices.map(pr => `- ${pr.text}`).join('\n');
      }

      content += '\n\nCONTENT:\n' + p.content.slice(0, 5000);

      return content;
    })
    .join('\n\n---\n\n')
    .slice(0, 80000);
}

/**
 * Main normalization function
 */
export function normalizeClinicData(pages, sourceUrl) {
  if (!pages || pages.length === 0) {
    return {
      clinic_name: '',
      address: '',
      opening_hours: '',
      phone: '',
      email: '',
      services: [],
      doctors: [],
      faq: [],
      source_pages: [],
      raw_content: ''
    };
  }

  const contact = extractContactInfo(pages);
  const services = extractServices(pages);
  const doctors = extractDoctors(pages);

  console.log(`Normalized: ${services.length} services, ${doctors.length} doctors`);

  return {
    clinic_name: extractClinicName(pages),
    address: contact.address,
    opening_hours: extractOpeningHours(pages),
    phone: contact.phones[0] || '',
    email: contact.emails[0] || '',
    services,
    doctors,
    faq: [],
    source_pages: pages.map(p => p.url),
    raw_content: buildRawContent(pages)
  };
}
