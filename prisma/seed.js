import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const posts = [
  {
    slug: 'what-is-xelochat-why-add-chatbot-to-your-website',
    title: 'What Is XeloChat and Why Add a Chatbot to Your Website?',
    excerpt: 'Learn how AI-powered chatbots turn visitors into customers by answering questions 24/7, in your brand voice, trained on your own website.',
    publishedAt: new Date('2025-01-15T10:00:00Z'),
    content: `Modern visitors expect instant answers. If they can't find what they need quickly, they leave—often to a competitor. XeloChat is an AI chatbot that lives on your website and talks to visitors using your own content.

**How it works**

XeloChat crawls your site (services, pricing, FAQ, contact), then uses that information to answer questions in natural language. No scripted menus: the bot understands intent and responds with relevant, accurate answers. It works in multiple languages and keeps your tone professional or friendly, depending on how you set it up.

**Why add a chatbot?**

- **24/7 availability** – Answer questions outside business hours.
- **Faster replies** – No waiting for email or a free agent.
- **Consistent answers** – Everyone gets the same, up-to-date information.
- **Lead capture** – Collect emails and booking requests from the chat.
- **Less repetitive work** – Your team spends less time on the same FAQs.

**Who is it for?**

XeloChat fits small businesses, clinics, agencies, and e‑commerce sites that want better support without hiring more staff. You get one free chatbot and 50 messages per month to try it; paid plans add more bots, messages, and features like Google Calendar booking.

If you're ready to let your website do more of the talking, start with XeloChat's free plan and see how it performs on your site.`
  },
  {
    slug: 'how-to-add-xelochat-to-your-website-in-5-minutes',
    title: 'How to Add XeloChat to Your Website in 5 Minutes',
    excerpt: 'Step-by-step guide to installing the XeloChat widget on any website—Webflow, WordPress, Shopify, or custom HTML—with one snippet.',
    publishedAt: new Date('2025-01-18T10:00:00Z'),
    content: `Adding XeloChat to your site doesn't require coding. You paste one script tag, point the chatbot at your website URL, and the AI trains on your content. Here’s how.

**1. Create a XeloChat account**

Sign up at xelochat.com. Confirm your email and go to the dashboard.

**2. Create your first chatbot**

In the dashboard, click “New chatbot.” Enter your website URL (e.g. https://yoursite.com). XeloChat will crawl your pages and use that content to answer questions. You can limit how many pages are crawled on the free plan.

**3. Get your embed code**

After the bot is created, open it and go to the “Embed” or “Install” section. Copy the one-line script tag. It looks like:

\`\`\`
<script src="https://xelochat.com/embed.js" data-api-key="your-key" data-chatbot-id="your-bot-id"></script>
\`\`\`

**4. Add it to your site**

- **Webflow / WordPress / Squarespace** – Add a “Custom code” or “Embed” block in the footer or before \`</body>\`, and paste the script.
- **Shopify** – Theme settings → “Additional scripts” or a footer snippet; paste the script.
- **Custom HTML** – Paste the script just before the closing \`</body>\` tag.

**5. Publish and test**

Save and publish your site. Open your site in a new tab and look for the chat bubble. Ask a question that’s answered on your site; the bot should reply using your content.

That’s it. No backend setup, no API keys on the front end—just one snippet. For advanced options (custom domain, styling, multiple bots), see the dashboard docs.`
  },
  {
    slug: 'xelochat-vs-generic-chatbots-website-trained-ai',
    title: 'XeloChat vs Generic Chatbots: Website-Trained AI That Knows Your Business',
    excerpt: 'Generic chatbots give scripted answers. XeloChat is trained on your website so every response is based on your real content and stays accurate.',
    publishedAt: new Date('2025-01-20T10:00:00Z'),
    content: `Many “chatbots” are just decision trees: click Option A or B, get a fixed reply. They don’t understand your services, your pricing, or your FAQ. XeloChat is different: it reads your website and uses that information to answer in natural language.

**The problem with generic chatbots**

- They need someone to write and maintain hundreds of scripted answers.
- They break when you change a price or add a new service.
- They can’t answer questions that weren’t anticipated.
- Visitors notice the rigid experience and often prefer to email or call.

**How XeloChat is different**

XeloChat crawls your site and builds a knowledge base from your real pages. When a visitor asks “What does the Pro plan include?” or “Do you offer home visits?”, the model uses your content to generate an answer. Update your site, and the next crawl keeps the bot in sync. No manual script updates.

**Accuracy and safety**

Responses are grounded in your content, so the bot is less likely to invent information. You control the tone (professional, friendly) and can add custom instructions. For sensitive topics, you can still route to a human or show a contact form.

**When it shines**

- **Service businesses** – “What do you offer?”, “How much is X?”, “How do I book?”
- **Clinics and practices** – “Do you take my insurance?”, “What are your hours?”
- **Agencies** – “What’s included in the package?”, “What’s your process?”
- **E‑commerce** – “Do you ship to my country?”, “What’s the return policy?”

If you want a chatbot that actually reflects your business, try XeloChat’s free tier: one bot, 50 messages/month, trained on your site in minutes.`
  },
  {
    slug: 'automate-appointments-xelochat-google-calendar',
    title: 'Automate Appointments with XeloChat and Google Calendar',
    excerpt: 'Let visitors book appointments from the chat. XeloChat’s Google Calendar integration creates events in real time and confirms with the customer.',
    publishedAt: new Date('2025-01-22T10:00:00Z'),
    content: `Taking bookings by email or phone means back-and-forth and manual calendar entry. XeloChat’s Google Calendar integration lets visitors request or book appointments directly in the chat; the bot can create events in your calendar and send a confirmation.

**How it works**

1. **Connect Google Calendar** – In the XeloChat dashboard, connect your Google account and choose which calendar to use (e.g. “Appointments”).
2. **Turn on booking** – Enable booking for the chatbot and, if you want, set which services or appointment types are available.
3. **Visitor books in chat** – The visitor says they want to book, picks a date/time (from free slots if you use availability), and provides name and contact details.
4. **Event is created** – XeloChat creates the event in your Google Calendar and can send a confirmation message in the chat (and optionally by email).

**Why use it**

- **Fewer no-shows** – Clear confirmation and calendar link.
- **Less admin** – No copying from email to the calendar.
- **Better UX** – Visitors don’t leave the site to book.
- **One place for schedules** – Everything stays in Google Calendar; use it with other tools (e.g. video links) as you already do.

**Availability and slots**

On Pro and higher plans, XeloChat can check your calendar and only offer free slots, so visitors don’t book over existing appointments. You can define working hours and buffer times in the dashboard.

**Privacy and control**

Only the calendars you authorize are used. You can disconnect the integration anytime. Data is handled according to XeloChat’s privacy policy and Google’s API terms.

If you’re on XeloChat Pro or Enterprise, connect Google Calendar in the dashboard and turn on booking; your chatbot will start handling appointment requests for you.`
  },
  {
    slug: 'best-practices-ai-customer-support-on-your-website',
    title: 'Best Practices for AI Customer Support on Your Website',
    excerpt: 'Get the most from your website chatbot: clear placement, honest scope, handoff to humans, and regular checks so AI support stays helpful.',
    publishedAt: new Date('2025-01-25T10:00:00Z'),
    content: `A well-set-up AI chatbot can handle a large share of routine questions and improve satisfaction. These practices help you deploy XeloChat (or any website chatbot) in a way that stays useful and trustworthy.

**1. Set expectations**

Tell visitors they’re talking to an AI (e.g. “I’m an AI assistant trained on this site”). That builds trust and avoids frustration when the bot can’t do something (e.g. process refunds). A short greeting like “Ask me about our services, pricing, or how to book” keeps conversations focused.

**2. Make the bot easy to find**

Use a visible but non-intrusive launcher (e.g. bottom-right). Avoid hiding the chat behind multiple clicks. On mobile, ensure the bubble doesn’t cover key buttons.

**3. Define when to hand off to a human**

Configure handoff when the topic is sensitive (complaints, legal, health) or when the user asks for a person. Offer a clear path: “I’ll connect you with the team” plus a form or email. That way the bot doesn’t overreach and you don’t miss important conversations.

**4. Keep the knowledge base up to date**

XeloChat is trained on your site. When you change pricing, services, or policies, update the site and, if needed, trigger a re-crawl or re-sync so the bot’s answers stay accurate. Stale information is the main cause of user frustration.

**5. Review and refine**

Check chat logs periodically. See which questions get good answers and which don’t. Add missing info to your site or adjust the bot’s instructions. Use feedback (e.g. thumbs up/down) if you have it.

**6. Respect privacy and accessibility**

Only use data you’re allowed to use; state in your privacy policy that you use a chatbot and how data is processed. Keep responses concise and structured so screen readers and stressed users can scan them easily.

**7. Start small, then expand**

Begin with one chatbot and a clear scope (e.g. “FAQs and booking”). Once it’s stable and accurate, add more bots or pages. Use analytics to see which pages or intents drive the most chats.

XeloChat gives you the tools (website training, booking, handoff); applying these practices will make your AI support more effective and reliable over time.`
  },
  {
    slug: 'why-small-businesses-need-ai-chatbots-in-2025',
    title: 'Why Small Businesses Need AI Chatbots in 2025',
    excerpt: 'Customers expect instant answers. AI chatbots level the playing field—without hiring more staff or working round the clock.',
    publishedAt: new Date('2025-01-28T10:00:00Z'),
    content: `Small businesses often can’t afford a support team. Yet customers expect fast answers. AI chatbots close that gap.

**The shift in expectations**

- 79% of consumers expect a response within 24 hours; many want it within minutes.
- After-hours queries pile up—and many visitors leave if they don’t get a quick answer.
- Email and contact forms feel slow; live chat feels immediate.

**How chatbots help small teams**

- **24/7 presence** – Answer questions while you sleep or focus on core work.
- **Consistent quality** – Every visitor gets accurate, up-to-date information.
- **Scale without headcount** – One chatbot handles dozens of conversations.
- **Lead capture** – Collect emails and booking requests directly in the chat.

**Why XeloChat works for small business**

XeloChat trains on your existing website content. No scripts to write, no decision trees to build. You add your URL, the AI learns your services and FAQs, and you deploy with one embed. Free tier: 50 messages/month to try it. Paid plans start low and grow with you.

If you’re a small business owner tired of “I’ll get back to you,” a chatbot can give your visitors instant answers—and free your time for higher-value work.`
  },
  {
    slug: 'xelochat-vs-intercom-vs-drift-which-chatbot-fits-your-budget',
    title: 'XeloChat vs Intercom vs Drift: Which Chatbot Fits Your Budget?',
    excerpt: 'Compare pricing, setup, and features: when to choose a simple AI chatbot vs. full sales and support platforms.',
    publishedAt: new Date('2025-01-30T10:00:00Z'),
    content: `Intercom and Drift are powerful—but expensive and complex. XeloChat is built for businesses that want AI support without enterprise pricing.

**Intercom**

- Full customer communication suite: live chat, help center, product tours, marketing automation.
- Pricing: typically \$74+/month per seat. Good for teams with dedicated support and marketing roles.
- Overkill if you mainly need a website chatbot for FAQs and lead capture.

**Drift**

- Conversational marketing and sales: lead scoring, meeting booking, revenue attribution.
- Pricing: custom, often \$2,500+/month. Built for sales-led B2B.
- Too heavy for small teams or content-driven support.

**XeloChat**

- Single focus: AI chatbot trained on your site. Answer questions, capture leads, book appointments.
- Pricing: Free (50 msg/mo) → \$18 (Starter) → \$49 (Pro) → \$99 (Enterprise).
- Fits small businesses, clinics, agencies, e‑commerce. Setup in minutes, not weeks.

**When to choose what**

- **Intercom** – You need help desk, ticketing, team inbox, and advanced automation.
- **Drift** – You’re B2B, sales-driven, and have budget for a full revenue platform.
- **XeloChat** – You want an AI chatbot that knows your site, embeds in one line, and costs a fraction.

Start with XeloChat’s free plan. If you outgrow it, you’ll know exactly what you need from a bigger platform.`
  },
  {
    slug: 'how-to-train-your-website-chatbot-for-better-answers',
    title: 'How to Train Your Website Chatbot for Better Answers',
    excerpt: 'Tips to improve chatbot accuracy: structure your content, add custom knowledge, and keep your site in sync.',
    publishedAt: new Date('2025-02-01T10:00:00Z'),
    content: `A website-trained chatbot is only as good as the content it learns from. Here’s how to get better answers from XeloChat (or any similar tool).

**1. Put answers where the bot can find them**

- FAQs on a dedicated page: “What are your hours?” “Do you ship internationally?”
- Clear service and pricing pages—not buried in PDFs or images.
- Contact and booking info in text, not just “Contact us” links.

**2. Use clear, scannable structure**

- Headings (H2, H3) help the AI understand topics.
- Bullet points and short paragraphs beat long blocks.
- Specific phrases (“We offer X, Y, Z”) work better than vague copy.

**3. Add custom knowledge in the dashboard**

- XeloChat lets you inject extra context: internal policies, seasonal info, product nuances.
- Use it for details that aren’t on your site or change often.
- Keep it concise and factual.

**4. Re-crawl when you update**

- When you change pricing, hours, or services, trigger a re-crawl so the bot stays in sync.
- Stale answers are the top cause of user frustration.

**5. Review and refine**

- Check chat logs: Which questions get wrong or incomplete answers?
- Add missing info to your site or custom knowledge.
- Adjust tone and instructions in the dashboard if needed.

Your chatbot reflects your content. Clean, structured, up-to-date content yields better answers and happier visitors.`
  },
  {
    slug: '7-ways-to-use-xelochat-for-lead-capture',
    title: '7 Ways to Use XeloChat for Lead Capture',
    excerpt: 'Turn conversations into leads: qualify prospects, book demos, collect emails, and route high-intent visitors—all from the chat.',
    publishedAt: new Date('2025-02-03T10:00:00Z'),
    content: `Your chatbot doesn’t just answer questions—it can capture leads. Here are seven practical ways to use XeloChat for lead generation.

**1. Email capture before answers**

- “I can share our pricing. What’s your email?”—collect before revealing details.
- Works well for gated content or demo requests.

**2. Qualify before booking**

- Ask: “What’s your use case?” or “Which plan are you considering?”
- Route high-intent visitors to a booking or sales form; others get self-serve help.

**3. Booking requests from chat**

- “I’d like to book a consultation”—capture name, email, preferred time.
- XeloChat can create Google Calendar events; you get a structured lead and confirmed slot.

**4. Product interest**

- “Which product are you interested in?” → save the answer with contact details.
- Pass to CRM or spreadsheets for follow-up.

**5. Newsletter signup**

- “Want our weekly tips? Drop your email.”
- Simple, low-friction way to grow your list.

**6. Support-to-sales handoff**

- When someone asks about pricing or enterprise, offer a call or demo.
- Capture details and notify your team for a warm follow-up.

**7. Feedback and NPS**

- “How was your experience? 1–10.” Plus optional email for follow-up.
- Turns feedback into a lead when they’re engaged.

XeloChat’s booking and lead capture run inside the conversation—no separate forms. Configure what you collect in the dashboard and start turning chat into leads.`
  }
];

async function main() {
  const now = new Date();
  for (const post of posts) {
    await prisma.blogPost.upsert({
      where: { slug: post.slug },
      update: {
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        publishedAt: post.publishedAt,
        updatedAt: now
      },
      create: {
        ...post,
        updatedAt: now
      }
    });
  }
  console.log(`Seeded ${posts.length} blog posts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
