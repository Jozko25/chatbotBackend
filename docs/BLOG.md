# Blog (XeloChat)

Blog posts are stored in the `blog_posts` table and served by the backend at `GET /api/blog` (list) and `GET /api/blog/:slug` (single post). The frontend shows them at `/blog` and `/blog/[slug]`.

## Apply schema and seed

From the **backend** directory, with database reachable:

```bash
# Create the blog_posts table (if using migrations)
npx prisma migrate deploy

# Or if you use db push (no migrations)
npx prisma db push

# Insert the 5 sample posts
npm run db:seed
```

After that, open `/blog` on the frontend to see the list and click a post to read it.

## Seed contents

The seed creates 5 posts:

1. What Is XeloChat and Why Add a Chatbot to Your Website?
2. How to Add XeloChat to Your Website in 5 Minutes
3. XeloChat vs Generic Chatbots: Website-Trained AI That Knows Your Business
4. Automate Appointments with XeloChat and Google Calendar
5. Best Practices for AI Customer Support on Your Website

To change or add posts, edit `backend/prisma/seed.js` and run `npm run db:seed` again (upsert by slug updates existing posts).
