import { Router } from 'express';
import prisma from '../services/prisma.js';

const router = Router();

// List user's chatbots
router.get('/', async (req, res) => {
  try {
    const chatbots = await prisma.chatbot.findMany({
      where: {
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      select: {
        id: true,
        name: true,
        sourceUrl: true,
        theme: true,
        status: true,
        lastScrapedAt: true,
        createdAt: true,
        _count: {
          select: { conversations: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(chatbots);
  } catch (error) {
    console.error('Error fetching chatbots:', error);
    res.status(500).json({ error: 'Failed to fetch chatbots' });
  }
});

// Get single chatbot with full details
router.get('/:id', async (req, res) => {
  try {
    const chatbot = await prisma.chatbot.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      include: {
        _count: {
          select: {
            conversations: true,
            apiKeys: { where: { isActive: true } }
          }
        }
      }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    res.json(chatbot);
  } catch (error) {
    console.error('Error fetching chatbot:', error);
    res.status(500).json({ error: 'Failed to fetch chatbot' });
  }
});

// Update chatbot name
router.put('/:id/name', async (req, res) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const result = await prisma.chatbot.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      data: { name: name.trim() }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating chatbot name:', error);
    res.status(500).json({ error: 'Failed to update chatbot' });
  }
});

// Update chatbot theme
router.put('/:id/theme', async (req, res) => {
  const { theme } = req.body;

  if (!theme || typeof theme !== 'object') {
    return res.status(400).json({ error: 'Theme object is required' });
  }

  try {
    const result = await prisma.chatbot.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      data: { theme }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating chatbot theme:', error);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

// Update chatbot AI settings (system prompt, knowledge base, welcome message)
router.put('/:id/settings', async (req, res) => {
  const { systemPrompt, customKnowledge, welcomeMessage, clinicData } = req.body;

  try {
    // Build update data - only include fields that are provided
    const updateData = {};

    if (systemPrompt !== undefined) {
      updateData.systemPrompt = systemPrompt || null;
    }
    if (customKnowledge !== undefined) {
      updateData.customKnowledge = customKnowledge || null;
    }
    if (welcomeMessage !== undefined) {
      updateData.welcomeMessage = welcomeMessage || null;
    }
    if (clinicData !== undefined) {
      // Merge with existing clinicData to allow partial updates
      const existing = await prisma.chatbot.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        select: { clinicData: true }
      });
      if (existing) {
        updateData.clinicData = { ...existing.clinicData, ...clinicData };
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await prisma.chatbot.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      data: updateData
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating chatbot settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Update chatbot status (pause/activate)
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;

  if (!['ACTIVE', 'PAUSED'].includes(status)) {
    return res.status(400).json({ error: 'Status must be ACTIVE or PAUSED' });
  }

  try {
    const result = await prisma.chatbot.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      data: { status }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating chatbot status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Delete chatbot (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const result = await prisma.chatbot.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      data: { status: 'DELETED' }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    // Also deactivate all API keys for this chatbot
    await prisma.apiKey.updateMany({
      where: { chatbotId: req.params.id },
      data: { isActive: false }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting chatbot:', error);
    res.status(500).json({ error: 'Failed to delete chatbot' });
  }
});

// Get chatbot conversations
router.get('/:id/conversations', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    // First verify chatbot ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    const conversations = await prisma.conversation.findMany({
      where: { chatbotId: req.params.id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 100 // Limit messages per conversation
        },
        _count: { select: { messages: true } }
      },
      orderBy: { updatedAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
    });

    res.json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get chatbot stats
router.get('/:id/stats', async (req, res) => {
  try {
    // Verify ownership
    const chatbot = await prisma.chatbot.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: { not: 'DELETED' }
      }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }

    // Get stats
    const [conversationCount, messageCount, last7DaysMessages] = await Promise.all([
      prisma.conversation.count({ where: { chatbotId: req.params.id } }),
      prisma.message.count({
        where: { conversation: { chatbotId: req.params.id } }
      }),
      prisma.usageRecord.count({
        where: {
          chatbotId: req.params.id,
          eventType: 'CHAT_MESSAGE',
          date: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      })
    ]);

    res.json({
      conversationCount,
      messageCount,
      last7DaysMessages
    });
  } catch (error) {
    console.error('Error fetching chatbot stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
