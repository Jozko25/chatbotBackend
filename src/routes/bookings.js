import express from 'express';
import prisma from '../services/prisma.js';
import { sendBookingNotifications } from '../services/notifications.js';

const router = express.Router();

// ============================================
// DASHBOARD ROUTES (JWT auth via protectedRoute in index.js)
// ============================================

/**
 * Get booking requests for a chatbot
 * GET /api/bookings/:chatbotId
 */
router.get('/:chatbotId', async (req, res) => {
  const { chatbotId } = req.params;
  const user = req.user;
  const { status, limit = 50, offset = 0 } = req.query;

  // Verify chatbot ownership
  const chatbot = await prisma.chatbot.findFirst({
    where: { id: chatbotId, userId: user.id }
  });

  if (!chatbot) {
    return res.status(404).json({ error: 'Chatbot not found' });
  }

  const where = { chatbotId };
  if (status) {
    where.status = status;
  }

  const [bookings, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
    }),
    prisma.bookingRequest.count({ where })
  ]);

  res.json({ bookings, total, limit: parseInt(limit), offset: parseInt(offset) });
});

/**
 * Update booking status
 * PATCH /api/bookings/:bookingId/status
 */
router.patch('/:bookingId/status', async (req, res) => {
  const { bookingId } = req.params;
  const { status } = req.body;
  const user = req.user;

  const validStatuses = ['PENDING', 'NOTIFIED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  // Get booking with chatbot to verify ownership
  const booking = await prisma.bookingRequest.findUnique({
    where: { id: bookingId },
    include: { chatbot: true }
  });

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.chatbot.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const updated = await prisma.bookingRequest.update({
    where: { id: bookingId },
    data: { status }
  });

  res.json(updated);
});

/**
 * Delete booking
 * DELETE /api/bookings/:bookingId
 */
router.delete('/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const user = req.user;

  // Get booking with chatbot to verify ownership
  const booking = await prisma.bookingRequest.findUnique({
    where: { id: bookingId },
    include: { chatbot: true }
  });

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.chatbot.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await prisma.bookingRequest.delete({ where: { id: bookingId } });

  res.json({ success: true });
});

/**
 * Resend notification for a booking
 * POST /api/bookings/:bookingId/resend
 */
router.post('/:bookingId/resend', async (req, res) => {
  const { bookingId } = req.params;
  const user = req.user;

  const booking = await prisma.bookingRequest.findUnique({
    where: { id: bookingId },
    include: { chatbot: true }
  });

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.chatbot.userId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const results = await sendBookingNotifications(booking, booking.chatbot);

  // Update booking with notification status
  await prisma.bookingRequest.update({
    where: { id: bookingId },
    data: {
      notificationSent: results.email?.success || results.webhook?.success || false,
      notificationSentAt: new Date(),
      notificationError: results.email?.error || results.webhook?.error || null
    }
  });

  res.json({ success: true, results });
});

export default router;
