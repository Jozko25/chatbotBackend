import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to credentials file (in project root) - used for local development
const CREDENTIALS_PATH = path.join(__dirname, '../../../google_credentials.json');

// Calendar ID - using the service account email as calendar owner
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

let auth = null;

/**
 * Initialize Google Calendar auth with service account
 * Supports both environment variable (for Railway) and JSON file (for local dev)
 */
async function getAuth() {
  if (auth) return auth;

  try {
    let credentials;

    // Option 1: Use GOOGLE_CREDENTIALS env variable (for Railway/production)
    // Set this as a single-line JSON string in Railway
    if (process.env.GOOGLE_CREDENTIALS) {
      try {
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        console.log('Using Google credentials from environment variable');
      } catch (parseError) {
        console.error('Failed to parse GOOGLE_CREDENTIALS env variable:', parseError);
        return null;
      }
    }
    // Option 2: Fall back to JSON file (for local development)
    else if (fs.existsSync(CREDENTIALS_PATH)) {
      credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      console.log('Using Google credentials from file:', CREDENTIALS_PATH);
    }
    else {
      console.error('No Google credentials found. Set GOOGLE_CREDENTIALS env or add google_credentials.json');
      return null;
    }

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    return auth;
  } catch (error) {
    console.error('Failed to initialize Google Calendar auth:', error);
    return null;
  }
}

/**
 * Create a calendar event from booking data
 * @param {Object} booking - The booking request data
 * @param {Object} chatbot - The chatbot data (for context)
 * @returns {Object} - Result with success status and event details
 */
export async function createCalendarEvent(booking, chatbot) {
  try {
    const authClient = await getAuth();
    if (!authClient) {
      return { success: false, error: 'Google Calendar not configured' };
    }

    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Parse date and time
    const { startDateTime, endDateTime } = parseBookingDateTime(
      booking.preferredDate,
      booking.preferredTime
    );

    // Build event description
    const description = buildEventDescription(booking, chatbot);

    // Build event title
    const summary = booking.service
      ? `${booking.service} - ${booking.customerName || 'Customer'}`
      : `Booking - ${booking.customerName || 'Customer'}`;

    const event = {
      summary,
      description,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'Europe/Prague', // Default timezone, can be made configurable
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'Europe/Prague',
      },
      // Color ID 9 = Blue (matches XeloChat brand)
      // Google Calendar color IDs: 1=lavender, 2=sage, 3=grape, 4=flamingo, 5=banana,
      // 6=tangerine, 7=peacock, 8=graphite, 9=blueberry, 10=basil, 11=tomato
      colorId: '9',
      // Note: Service accounts cannot invite attendees without Domain-Wide Delegation
      // So we don't add attendees - the customer email is in the description instead
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 }, // 1 hour before
        ],
      },
      // Add metadata
      extendedProperties: {
        private: {
          bookingId: booking.id,
          chatbotId: booking.chatbotId,
          customerPhone: booking.customerPhone || '',
          customerEmail: booking.customerEmail || '',
          source: 'xelochat-widget',
        },
      },
    };

    console.log('Creating Google Calendar event:', {
      summary,
      start: startDateTime,
      end: endDateTime,
      calendarId: CALENDAR_ID,
    });

    const result = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendUpdates: 'none',
    });

    console.log('Google Calendar event created:', result.data.id);

    return {
      success: true,
      eventId: result.data.id,
      eventLink: result.data.htmlLink,
    };
  } catch (error) {
    console.error('Failed to create Google Calendar event:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Parse booking date and time into start/end DateTime objects
 */
function parseBookingDateTime(dateStr, timeStr) {
  const now = new Date();
  let startDateTime;

  // Try to parse the date
  if (dateStr) {
    // First, try ISO format (YYYY-MM-DD) from HTML date input
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      startDateTime = new Date(year, month - 1, day);
    }
    // Handle EU format (DD.MM.YYYY or DD/MM/YYYY)
    else if (/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(dateStr)) {
      const parts = dateStr.split(/[./-]/);
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const year = parseInt(parts[2]);
      startDateTime = new Date(year, month, day);
    }
    // Handle short EU format (DD.MM or DD/MM)
    else if (/^\d{1,2}[./-]\d{1,2}$/.test(dateStr)) {
      const parts = dateStr.split(/[./-]/);
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      startDateTime = new Date(now.getFullYear(), month, day);
      // If date is in the past, assume next year
      if (startDateTime < now) {
        startDateTime.setFullYear(startDateTime.getFullYear() + 1);
      }
    }
    // Try natural language parsing (tomorrow, next week, etc.)
    else {
      startDateTime = parseNaturalDate(dateStr) || new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
  } else {
    // Default to tomorrow
    startDateTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  // Try to parse the time
  if (timeStr) {
    // Handle HH:MM format (from HTML time input)
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const ampm = timeMatch[4]?.toLowerCase();

      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      startDateTime.setHours(hours, minutes, 0, 0);
    }
  } else {
    // Default to 10:00 AM
    startDateTime.setHours(10, 0, 0, 0);
  }

  // End time is 1 hour after start (default appointment duration)
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

  return { startDateTime, endDateTime };
}

/**
 * Parse natural language dates
 */
function parseNaturalDate(dateStr) {
  const now = new Date();
  const lower = dateStr.toLowerCase();

  if (lower.includes('today') || lower.includes('dnes')) {
    return new Date(now);
  }
  if (lower.includes('tomorrow') || lower.includes('zítra') || lower.includes('zitra')) {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  if (lower.includes('next week') || lower.includes('příští týden')) {
    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  // Day names
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const czechDays = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i]) || lower.includes(czechDays[i])) {
      const currentDay = now.getDay();
      let daysUntil = i - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      return new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

/**
 * Build event description from booking data
 */
function buildEventDescription(booking, chatbot) {
  const lines = [
    `📋 Booking via ${chatbot?.name || 'XeloChat'}`,
    '',
    '👤 Customer Information:',
  ];

  if (booking.customerName) lines.push(`   Name: ${booking.customerName}`);
  if (booking.customerEmail) lines.push(`   Email: ${booking.customerEmail}`);
  if (booking.customerPhone) lines.push(`   Phone: ${booking.customerPhone}`);
  if (booking.service) lines.push(`\n🏷️ Service: ${booking.service}`);
  if (booking.notes) lines.push(`\n📝 Notes: ${booking.notes}`);

  lines.push('');
  lines.push('---');
  lines.push(`Booking ID: ${booking.id}`);
  lines.push(`Created: ${new Date().toISOString()}`);

  return lines.join('\n');
}

/**
 * Get available time slots for a given date
 * @param {string} date - The date to check (YYYY-MM-DD)
 * @returns {Array} - Array of available time slots
 */
export async function getAvailableSlots(date) {
  try {
    const authClient = await getAuth();
    if (!authClient) {
      return { success: false, error: 'Google Calendar not configured' };
    }

    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Set time boundaries for the day
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Get existing events
    const result = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const busySlots = result.data.items.map(event => ({
      start: new Date(event.start.dateTime || event.start.date),
      end: new Date(event.end.dateTime || event.end.date),
    }));

    // Generate available slots (9 AM to 5 PM, 1-hour slots)
    const availableSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      const slotStart = new Date(startOfDay);
      slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(slotStart);
      slotEnd.setHours(hour + 1, 0, 0, 0);

      // Check if slot conflicts with any busy slot
      const isBusy = busySlots.some(
        busy => slotStart < busy.end && slotEnd > busy.start
      );

      if (!isBusy) {
        availableSlots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          label: `${hour}:00 - ${hour + 1}:00`,
        });
      }
    }

    return { success: true, slots: availableSlots };
  } catch (error) {
    console.error('Failed to get available slots:', error);
    return { success: false, error: error.message };
  }
}
