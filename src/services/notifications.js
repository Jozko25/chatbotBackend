import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// From address - use verified domain or Resend's test address
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'XeloChat <onboarding@resend.dev>';

/**
 * Format booking data for email
 */
function formatBookingData(booking, chatbot) {
  const fields = [];
  
  if (booking.customerName) fields.push(`Name: ${booking.customerName}`);
  if (booking.customerEmail) fields.push(`Email: ${booking.customerEmail}`);
  if (booking.customerPhone) fields.push(`Phone: ${booking.customerPhone}`);
  if (booking.service) fields.push(`Service: ${booking.service}`);
  if (booking.preferredDate) fields.push(`Preferred Date: ${booking.preferredDate}`);
  if (booking.preferredTime) fields.push(`Preferred Time: ${booking.preferredTime}`);
  if (booking.notes) fields.push(`Notes: ${booking.notes}`);
  
  // Include any extra data from JSON
  if (booking.data && typeof booking.data === 'object') {
    for (const [key, value] of Object.entries(booking.data)) {
      if (value && !['name', 'email', 'phone', 'service', 'preferredDate', 'preferredTime', 'notes'].includes(key)) {
        fields.push(`${key}: ${value}`);
      }
    }
  }
  
  return fields.join('\n');
}

/**
 * Generate HTML email for booking notification
 */
function generateBookingEmailHtml(booking, chatbot) {
  const data = formatBookingData(booking, chatbot);
  const dataHtml = data.split('\n').map(line => {
    const [label, ...valueParts] = line.split(': ');
    const value = valueParts.join(': ');
    return `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 500; color: #555;">${label}</td><td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${value}</td></tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #0ea5e9, #0284c7); padding: 24px; text-align: center;">
        <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">New Booking Request</h1>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">via ${chatbot.name} chatbot</p>
      </div>
      
      <!-- Content -->
      <div style="padding: 24px;">
        <p style="margin: 0 0 16px; color: #333; font-size: 15px;">
          A new booking request has been submitted through your chatbot widget.
        </p>
        
        <table style="width: 100%; border-collapse: collapse; background: #fafafa; border-radius: 8px; overflow: hidden;">
          ${dataHtml}
        </table>
      </div>
      
      <!-- Footer -->
      <div style="padding: 16px 24px; background: #f9fafb; border-top: 1px solid #eee; text-align: center;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">
          Powered by XeloChat
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text email for booking notification
 */
function generateBookingEmailText(booking, chatbot) {
  const data = formatBookingData(booking, chatbot);
  return `
NEW BOOKING REQUEST
via ${chatbot.name} chatbot

${data}

---
Powered by XeloChat
  `.trim();
}

/**
 * Send booking notification email
 * @param {object} booking - BookingRequest from database
 * @param {object} chatbot - Chatbot from database
 * @returns {object} - { success: boolean, error?: string }
 */
export async function sendBookingEmail(booking, chatbot) {
  const recipientEmail = chatbot.notificationEmail || chatbot.clinicData?.email;
  if (!recipientEmail) {
    return { success: false, error: 'No notification email configured' };
  }

  if (!resend) {
    console.warn('RESEND_API_KEY not configured, skipping email');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    console.log(`Sending email from ${FROM_EMAIL} to ${recipientEmail}`);
    
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: recipientEmail,
      replyTo: booking.customerEmail || undefined,
      subject: `New Booking Request - ${booking.customerName || 'Customer'} - ${chatbot.name}`,
      html: generateBookingEmailHtml(booking, chatbot),
      text: generateBookingEmailText(booking, chatbot)
    });

    console.log('Email sent successfully:', result);
    return { success: true, id: result.data?.id || result.id };
  } catch (error) {
    console.error('Failed to send email:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    return { success: false, error: error.message };
  }
}

/**
 * Send webhook notification
 * @param {object} booking - BookingRequest from database
 * @param {object} chatbot - Chatbot from database
 * @returns {object} - { success: boolean, error?: string }
 */
export async function sendBookingWebhook(booking, chatbot) {
  if (!chatbot.notificationWebhook) {
    return { success: false, error: 'No webhook URL configured' };
  }

  try {
    const payload = {
      event: 'booking.created',
      timestamp: new Date().toISOString(),
      chatbot: {
        id: chatbot.id,
        name: chatbot.name
      },
      booking: {
        id: booking.id,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        customerPhone: booking.customerPhone,
        service: booking.service,
        preferredDate: booking.preferredDate,
        preferredTime: booking.preferredTime,
        notes: booking.notes,
        data: booking.data,
        createdAt: booking.createdAt
      }
    };

    const response = await fetch(chatbot.notificationWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'XeloChat/1.0'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
    }

    console.log('Webhook sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Failed to send webhook:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send all configured notifications for a booking
 * @param {object} booking - BookingRequest from database
 * @param {object} chatbot - Chatbot from database (must include notification settings)
 * @returns {object} - { email?: object, webhook?: object }
 */
export async function sendBookingNotifications(booking, chatbot) {
  const results = {};

  // Send email if configured
  if ((chatbot.notificationEmail || chatbot.clinicData?.email) && chatbot.notifyOnBooking) {
    results.email = await sendBookingEmail(booking, chatbot);
  }

  // Send webhook if configured
  if (chatbot.notificationWebhook && chatbot.notifyOnBooking) {
    results.webhook = await sendBookingWebhook(booking, chatbot);
  }

  return results;
}
