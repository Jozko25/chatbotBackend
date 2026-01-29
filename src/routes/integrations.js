import { Router } from 'express';
import prisma from '../services/prisma.js';
import {
  generateAuthUrl,
  getUserCalendars,
  revokeToken,
  encryptToken,
  decryptToken,
  refreshAccessToken,
  isGoogleOAuthConfigured
} from '../services/googleOAuth.js';
import { strictLimiter } from '../middleware/rateLimiter.js';

const router = Router();

/**
 * GET /api/integrations/chatbot/:chatbotId
 * Get integrations for a specific chatbot
 */
router.get('/chatbot/:chatbotId', async (req, res) => {
  const user = req.user;
  const { chatbotId } = req.params;

  try {
    // Verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId: user.id }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const integrations = await prisma.integration.findMany({
      where: { chatbotId },
      select: {
        id: true,
        provider: true,
        isConnected: true,
        calendarId: true,
        settings: true,
        lastSyncAt: true,
        error: true,
        createdAt: true,
        updatedAt: true
      }
    });

    const googleConfigured = isGoogleOAuthConfigured();

    res.json({
      integrations,
      available: {
        GOOGLE_CALENDAR: {
          configured: googleConfigured,
          connected: integrations.some(i => i.provider === 'GOOGLE_CALENDAR' && i.isConnected)
        }
      }
    });
  } catch (error) {
    console.error('Get chatbot integrations error:', error);
    res.status(500).json({ error: 'Failed to get integrations' });
  }
});

/**
 * GET /api/integrations/chatbot/:chatbotId/google-calendar/connect
 * Start Google Calendar OAuth flow for a chatbot
 */
router.get('/chatbot/:chatbotId/google-calendar/connect', strictLimiter, async (req, res) => {
  const user = req.user;
  const { chatbotId } = req.params;

  if (!isGoogleOAuthConfigured()) {
    return res.status(503).json({ error: 'Google Calendar integration not configured' });
  }

  try {
    // Verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId: user.id }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const { url } = generateAuthUrl(user.id, chatbotId);
    res.json({ authUrl: url });
  } catch (error) {
    console.error('Google Calendar connect error:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /api/integrations/chatbot/:chatbotId/google-calendar/status
 * Get Google Calendar connection status and calendars for a chatbot
 */
router.get('/chatbot/:chatbotId/google-calendar/status', async (req, res) => {
  const user = req.user;
  const { chatbotId } = req.params;

  try {
    // Verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId: user.id }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        chatbotId_provider: {
          chatbotId,
          provider: 'GOOGLE_CALENDAR'
        }
      }
    });

    if (!integration || !integration.isConnected) {
      return res.json({
        connected: false,
        configured: isGoogleOAuthConfigured()
      });
    }

    // Decrypt tokens
    const accessToken = decryptToken(integration.accessToken);
    const refreshToken = decryptToken(integration.refreshToken);

    // Check if token needs refresh
    let currentAccessToken = accessToken;
    if (integration.tokenExpiresAt && new Date(integration.tokenExpiresAt) < new Date()) {
      try {
        const refreshed = await refreshAccessToken(refreshToken);
        currentAccessToken = refreshed.accessToken;

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
        return res.json({
          connected: false,
          error: 'Token expired. Please reconnect.',
          configured: isGoogleOAuthConfigured()
        });
      }
    }

    // Get user's calendars
    let calendars = [];
    try {
      calendars = await getUserCalendars(currentAccessToken, refreshToken);
    } catch (calError) {
      console.error('Failed to get calendars:', calError);
    }

    res.json({
      connected: true,
      calendarId: integration.calendarId,
      calendars,
      lastSyncAt: integration.lastSyncAt,
      error: integration.error
    });

  } catch (error) {
    console.error('Google Calendar status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * PUT /api/integrations/chatbot/:chatbotId/google-calendar/settings
 * Update Google Calendar settings for a chatbot
 */
router.put('/chatbot/:chatbotId/google-calendar/settings', async (req, res) => {
  const user = req.user;
  const { chatbotId } = req.params;
  const { calendarId } = req.body;

  if (!calendarId) {
    return res.status(400).json({ error: 'calendarId is required' });
  }

  try {
    // Verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId: user.id }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        chatbotId_provider: {
          chatbotId,
          provider: 'GOOGLE_CALENDAR'
        }
      }
    });

    if (!integration || !integration.isConnected) {
      return res.status(404).json({ error: 'Google Calendar not connected' });
    }

    // Update calendar ID
    await prisma.integration.update({
      where: { id: integration.id },
      data: { calendarId }
    });

    res.json({ success: true, calendarId });

  } catch (error) {
    console.error('Update calendar settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * POST /api/integrations/chatbot/:chatbotId/google-calendar/disconnect
 * Disconnect Google Calendar from a chatbot
 */
router.post('/chatbot/:chatbotId/google-calendar/disconnect', strictLimiter, async (req, res) => {
  const user = req.user;
  const { chatbotId } = req.params;

  try {
    // Verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: { id: chatbotId, userId: user.id }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const integration = await prisma.integration.findUnique({
      where: {
        chatbotId_provider: {
          chatbotId,
          provider: 'GOOGLE_CALENDAR'
        }
      }
    });

    if (!integration) {
      return res.json({ success: true, message: 'Not connected' });
    }

    // Try to revoke the token
    if (integration.accessToken) {
      const accessToken = decryptToken(integration.accessToken);
      await revokeToken(accessToken);
    }

    // Delete the integration
    await prisma.integration.delete({
      where: { id: integration.id }
    });

    console.log(`Google Calendar disconnected for chatbot ${chatbotId}`);

    res.json({ success: true });

  } catch (error) {
    console.error('Google Calendar disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

export default router;
