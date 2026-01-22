import { Router } from 'express';
import prisma from '../services/prisma.js';
import { PLAN_LIMITS } from '../config/billing.js';

const router = Router();

// Get user's usage stats
router.get('/stats', async (req, res) => {
  try {
    const user = req.user;
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.FREE;

    // Get chatbot count
    const chatbotCount = await prisma.chatbot.count({
      where: {
        userId: user.id,
        status: { not: 'DELETED' }
      }
    });

    // Get total conversations
    const conversationCount = await prisma.conversation.count({
      where: {
        chatbot: { userId: user.id }
      }
    });

    res.json({
      plan: user.plan,
      messagesUsed: user.messagesUsed,
      messageLimit: limits.messages,
      messagesRemaining: Math.max(0, limits.messages - user.messagesUsed),
      chatbotCount,
      chatbotLimit: limits.chatbots,
      conversationCount,
      limitResetAt: user.limitResetAt,
      percentageUsed: Math.round((user.messagesUsed / limits.messages) * 100)
    });
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

// Get usage history (daily aggregates)
router.get('/history', async (req, res) => {
  const { days = 30 } = req.query;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));
  startDate.setHours(0, 0, 0, 0);

  try {
    const records = await prisma.usageRecord.groupBy({
      by: ['date', 'eventType'],
      where: {
        userId: req.user.id,
        date: { gte: startDate }
      },
      _count: { id: true },
      orderBy: { date: 'asc' }
    });

    // Transform to more usable format
    const byDate = {};
    records.forEach(record => {
      const dateStr = record.date.toISOString().split('T')[0];
      if (!byDate[dateStr]) {
        byDate[dateStr] = { date: dateStr, messages: 0, scrapes: 0, widgetLoads: 0 };
      }
      if (record.eventType === 'CHAT_MESSAGE') {
        byDate[dateStr].messages = record._count.id;
      } else if (record.eventType === 'SCRAPE') {
        byDate[dateStr].scrapes = record._count.id;
      } else if (record.eventType === 'WIDGET_LOAD') {
        byDate[dateStr].widgetLoads = record._count.id;
      }
    });

    res.json(Object.values(byDate));
  } catch (error) {
    console.error('Error fetching usage history:', error);
    res.status(500).json({ error: 'Failed to fetch usage history' });
  }
});

// Get usage by chatbot
router.get('/by-chatbot', async (req, res) => {
  try {
    const chatbots = await prisma.chatbot.findMany({
      where: {
        userId: req.user.id,
        status: { not: 'DELETED' }
      },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            conversations: true,
            usageRecords: true
          }
        }
      }
    });

    // Get message counts for each chatbot
    const result = await Promise.all(chatbots.map(async (chatbot) => {
      const messageCount = await prisma.usageRecord.count({
        where: {
          chatbotId: chatbot.id,
          eventType: 'CHAT_MESSAGE'
        }
      });

      return {
        id: chatbot.id,
        name: chatbot.name,
        conversationCount: chatbot._count.conversations,
        messageCount
      };
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching usage by chatbot:', error);
    res.status(500).json({ error: 'Failed to fetch usage by chatbot' });
  }
});

export default router;
