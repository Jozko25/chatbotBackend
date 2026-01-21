// Input validation and sanitization utilities

// Sanitize string input
export function sanitizeString(str, maxLength = 1000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
}

// Validate URL
export function validateUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// Validate email
export function validateEmail(email) {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim()) && email.length <= 255;
}

// Validate phone number (basic)
export function validatePhone(phone) {
  if (typeof phone !== 'string') return false;
  // Allow digits, spaces, hyphens, parentheses, plus sign
  const phoneRegex = /^[\d\s\-\(\)\+]+$/;
  return phoneRegex.test(phone.trim()) && phone.length <= 50;
}

// Validate chatbot ID format
export function validateChatbotId(id) {
  if (typeof id !== 'string') return false;
  // Alphanumeric, hyphens, underscores only
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 100;
}

// Validate API key format
export function validateApiKeyFormat(key) {
  if (typeof key !== 'string') return false;
  return key.length >= 10 && key.length <= 200;
}

// Validate JSON object structure
export function validateObject(obj, schema) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  
  for (const [key, validator] of Object.entries(schema)) {
    if (!validator(obj[key])) {
      return false;
    }
  }
  
  return true;
}

// Middleware to validate request body
export function validateBody(schema) {
  return (req, res, next) => {
    if (!validateObject(req.body, schema)) {
      return res.status(400).json({ 
        error: 'Invalid request body', 
        code: 'VALIDATION_ERROR' 
      });
    }
    next();
  };
}

// Sanitize booking data
export function sanitizeBookingData(data) {
  return {
    customerName: sanitizeString(data?.customerName, 200) || null,
    customerEmail: data?.customerEmail ? (validateEmail(data.customerEmail) ? data.customerEmail.trim() : null) : null,
    customerPhone: data?.customerPhone ? (validatePhone(data.customerPhone) ? data.customerPhone.trim() : null) : null,
    service: sanitizeString(data?.service, 200) || null,
    preferredDate: sanitizeString(data?.preferredDate, 50) || null,
    preferredTime: sanitizeString(data?.preferredTime, 50) || null,
    notes: sanitizeString(data?.notes, 2000) || null
  };
}
