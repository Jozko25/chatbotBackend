import { Router } from 'express';
import prisma from '../services/prisma.js';

const router = Router();

/**
 * GET /api/blog
 * List published blog posts, newest first.
 */
router.get('/', async (req, res) => {
  try {
    const posts = await prisma.blogPost.findMany({
      where: {
        publishedAt: { lte: new Date() }
      },
      orderBy: { publishedAt: 'desc' },
      select: {
        id: true,
        title: true,
        slug: true,
        excerpt: true,
        publishedAt: true
      }
    });
    res.json(posts);
  } catch (error) {
    console.error('Blog list error', error);
    res.status(500).json({ error: 'Failed to load blog posts' });
  }
});

/**
 * GET /api/blog/:slug
 * Get a single published blog post by slug.
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const post = await prisma.blogPost.findFirst({
      where: {
        slug,
        publishedAt: { lte: new Date() }
      }
    });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    console.error('Blog post error', error);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

export default router;
