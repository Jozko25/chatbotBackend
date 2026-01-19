import { Router } from 'express';
import prisma from '../services/prisma.js';
import { generateApiKey, hashApiKey } from '../middleware/apiKey.js';

const router = Router();

// List user's API keys
router.get('/', async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        chatbotId: true,
        allowedDomains: true,
        scopes: true,
        rateLimit: true,
        isActive: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        chatbot: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(keys);
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create new API key
router.post('/', async (req, res) => {
  const { name, chatbotId, allowedDomains, scopes } = req.body;

  // Validate chatbot ownership if specified
  if (chatbotId) {
    const chatbot = await prisma.chatbot.findFirst({
      where: {
        id: chatbotId,
        userId: req.user.id,
        status: { not: 'DELETED' }
      }
    });

    if (!chatbot) {
      return res.status(404).json({ error: 'Chatbot not found' });
    }
  }

  // Validate allowed domains format
  let validatedDomains = [];
  if (allowedDomains && Array.isArray(allowedDomains)) {
    validatedDomains = allowedDomains
      .filter(d => typeof d === 'string' && d.trim().length > 0)
      .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  }

  // Generate the key
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 16) + '...';

  try {
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user.id,
        chatbotId: chatbotId || null,
        keyHash,
        keyPrefix,
        name: name?.trim() || 'API Key',
        allowedDomains: validatedDomains,
        scopes: scopes || ['chat']
      }
    });

    // Return the raw key ONLY on creation - user must save it!
    res.json({
      id: apiKey.id,
      key: rawKey, // Only shown once!
      keyPrefix,
      name: apiKey.name,
      chatbotId: apiKey.chatbotId,
      allowedDomains: apiKey.allowedDomains,
      scopes: apiKey.scopes,
      warning: 'Save this key now! It will not be shown again.'
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Update API key (name, domains, scopes)
router.put('/:id', async (req, res) => {
  const { name, allowedDomains, scopes, isActive } = req.body;

  // Build update data
  const updateData = {};

  if (name !== undefined) {
    updateData.name = name.trim();
  }

  if (allowedDomains !== undefined && Array.isArray(allowedDomains)) {
    updateData.allowedDomains = allowedDomains
      .filter(d => typeof d === 'string' && d.trim().length > 0)
      .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  }

  if (scopes !== undefined && Array.isArray(scopes)) {
    updateData.scopes = scopes;
  }

  if (isActive !== undefined) {
    updateData.isActive = Boolean(isActive);
  }

  try {
    const result = await prisma.apiKey.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      data: updateData
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating API key:', error);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// Revoke (deactivate) API key
router.delete('/:id', async (req, res) => {
  try {
    const result = await prisma.apiKey.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      data: { isActive: false }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking API key:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// Permanently delete API key
router.delete('/:id/permanent', async (req, res) => {
  try {
    const result = await prisma.apiKey.deleteMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

export default router;
