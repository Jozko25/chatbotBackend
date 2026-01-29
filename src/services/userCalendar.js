import { google } from 'googleapis';
import prisma from './prisma.js';
import { createUserOAuth2Client, decryptToken, refreshAccessToken, encryptToken } from './googleOAuth.js';

/**
 * Get chatbot's Google Calendar integration with valid tokens
 */
async function getChatbotCalendarIntegration(chatbotId) {
  const integration = await prisma.integration.findUnique({
    where: {
      chatbotId_provider: {
        chatbotId,
        provider: 'GOOGLE_CALENDAR'
      }
    }
  });

  if (!integration || !integration.isConnected) {
    return null;
  }

  // Decrypt tokens
  let accessToken = decryptToken(integration.accessToken);
  const refreshToken = decryptToken(integration.refreshToken);

  // Check if token needs refresh
  if (integration.tokenExpiresAt && new Date(integration.tokenExpiresAt) < new Date()) {
    try {
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;

      // Update stored token
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          accessToken: encryptToken(refreshed.accessToken),
          tokenExpiresAt: refreshed.expiresAt,
          error: null
        }
      });
    } catch (refreshError) {
      console.error('Token refresh failed:', refreshError);
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          isConnected: false,
          error: 'Token refresh failed. Please reconnect.'
        }
      });
      return null;
    }
  }

  return {
    integration,
    accessToken,
    refreshToken,
    calendarId: integration.calendarId || 'primary'
  };
}

/**
 * Create a calendar event in chatbot's connected Google Calendar
 * Falls back to service account if chatbot hasn't connected
 */
export async function createUserCalendarEvent(booking, chatbot, userId) {
  // Try to get chatbot's connected calendar
  const chatbotCalendar = await getChatbotCalendarIntegration(chatbot.id);

  if (!chatbotCalendar) {
    // Fall back to service account calendar
    const { createCalendarEvent } = await import('./googleCalendar.js');
    return createCalendarEvent(booking, chatbot);
  }

  try {
    const oauth2Client = createUserOAuth2Client(chatbotCalendar.accessToken, chatbotCalendar.refreshToken);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Parse date and time
    const { startDateTime, endDateTime } = parseBookingDateTime(
      booking.preferredDate,
      booking.preferredTime
    );

    // Build event
    const summary = booking.service
      ? `${booking.service} - ${booking.customerName || 'Customer'}`
      : `Booking - ${booking.customerName || 'Customer'}`;

    const description = buildEventDescription(booking, chatbot);

    const event = {
      summary,
      description,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'Europe/Prague'
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'Europe/Prague'
      },
      colorId: '9', // Blue
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'email', minutes: 1440 } // 24 hours before
        ]
      },
      extendedProperties: {
        private: {
          bookingId: booking.id,
          chatbotId: booking.chatbotId,
          customerPhone: booking.customerPhone || '',
          customerEmail: booking.customerEmail || '',
          source: 'xelochat-widget'
        }
      }
    };

    // Add attendee if customer has email
    if (booking.customerEmail) {
      event.attendees = [
        { email: booking.customerEmail, displayName: booking.customerName || 'Customer' }
      ];
    }

    console.log('Creating event in chatbot calendar:', {
      summary,
      calendarId: chatbotCalendar.calendarId,
      chatbotId: chatbot.id,
      start: startDateTime
    });

    const result = await calendar.events.insert({
      calendarId: chatbotCalendar.calendarId,
      resource: event,
      sendUpdates: booking.customerEmail ? 'all' : 'none' // Send invite if email provided
    });

    // Update last sync time
    await prisma.integration.update({
      where: { id: chatbotCalendar.integration.id },
      data: { lastSyncAt: new Date() }
    });

    console.log('Chatbot calendar event created:', result.data.id);

    return {
      success: true,
      eventId: result.data.id,
      eventLink: result.data.htmlLink,
      userCalendar: true
    };

  } catch (error) {
    console.error('Chatbot calendar event creation failed:', error);

    // Check if it's an auth error
    if (error.code === 401 || error.code === 403) {
      await prisma.integration.update({
        where: { id: chatbotCalendar.integration.id },
        data: {
          isConnected: false,
          error: 'Calendar access revoked. Please reconnect.'
        }
      });
    }

    // Fall back to service account
    console.log('Falling back to service account calendar');
    const { createCalendarEvent } = await import('./googleCalendar.js');
    return createCalendarEvent(booking, chatbot);
  }
}

/**
 * Get available slots from chatbot's connected calendar
 */
export async function getUserAvailableSlots(date, chatbotId) {
  const chatbotCalendar = await getChatbotCalendarIntegration(chatbotId);

  if (!chatbotCalendar) {
    // Fall back to service account
    const { getAvailableSlots } = await import('./googleCalendar.js');
    return getAvailableSlots(date);
  }

  try {
    const oauth2Client = createUserOAuth2Client(chatbotCalendar.accessToken, chatbotCalendar.refreshToken);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const result = await calendar.events.list({
      calendarId: chatbotCalendar.calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const busySlots = result.data.items.map(event => ({
      start: new Date(event.start.dateTime || event.start.date),
      end: new Date(event.end.dateTime || event.end.date)
    }));

    // Generate available slots (9 AM to 5 PM, 1-hour slots)
    const availableSlots = [];
    for (let hour = 9; hour < 17; hour++) {
      const slotStart = new Date(startOfDay);
      slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(slotStart);
      slotEnd.setHours(hour + 1, 0, 0, 0);

      const isBusy = busySlots.some(
        busy => slotStart < busy.end && slotEnd > busy.start
      );

      if (!isBusy) {
        availableSlots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          label: `${hour}:00 - ${hour + 1}:00`
        });
      }
    }

    return { success: true, slots: availableSlots, userCalendar: true };

  } catch (error) {
    console.error('Chatbot calendar availability check failed:', error);
    // Fall back to service account
    const { getAvailableSlots } = await import('./googleCalendar.js');
    return getAvailableSlots(date);
  }
}

/**
 * Parse booking date and time into start/end DateTime objects
 */
function parseBookingDateTime(dateStr, timeStr) {
  const now = new Date();
  let startDateTime;

  if (dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      startDateTime = new Date(year, month - 1, day);
    } else if (/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(dateStr)) {
      const parts = dateStr.split(/[./-]/);
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const year = parseInt(parts[2]);
      startDateTime = new Date(year, month, day);
    } else if (/^\d{1,2}[./-]\d{1,2}$/.test(dateStr)) {
      const parts = dateStr.split(/[./-]/);
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      startDateTime = new Date(now.getFullYear(), month, day);
      if (startDateTime < now) {
        startDateTime.setFullYear(startDateTime.getFullYear() + 1);
      }
    } else {
      startDateTime = parseNaturalDate(dateStr) || new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
  } else {
    startDateTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  if (timeStr) {
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
    startDateTime.setHours(10, 0, 0, 0);
  }

  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
  return { startDateTime, endDateTime };
}

function parseNaturalDate(dateStr) {
  const now = new Date();
  const lower = dateStr.toLowerCase();

  if (lower.includes('today') || lower.includes('dnes')) {
    return new Date(now);
  }
  if (lower.includes('tomorrow') || lower.includes('zítra') || lower.includes('zitra') || lower.includes('zajtra')) {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  if (lower.includes('next week') || lower.includes('příští týden') || lower.includes('budúci týždeň')) {
    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const czechDays = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
  const slovakDays = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];

  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i]) || lower.includes(czechDays[i]) || lower.includes(slovakDays[i])) {
      const currentDay = now.getDay();
      let daysUntil = i - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      return new Date(now.getTime() + daysUntil * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

function buildEventDescription(booking, chatbot) {
  const lines = [
    `📋 Booking via ${chatbot?.name || 'XeloChat'}`,
    '',
    '👤 Customer Information:'
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
