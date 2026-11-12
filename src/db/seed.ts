import {
  insertMessage,
  isDatabaseEmpty,
  clearDatabase,
  getDatabaseStats,
  Message
} from './memory.js';

export interface RelativeDates {
  nov3: { dateStr: string; userIso: string; assistantIso: string };
  lastTuesday: { dateStr: string; userIso: string; assistantIso: string; daysAgo: number };
  recentMonday: { dateStr: string; userIso: string; assistantIso: string; daysAgo: number };
}

/**
 * Dynamically computes relative target dates based on reference date:
 * 1. "3 November": most recent Nov 3 strictly in past
 * 2. "Last Tuesday": previous Tuesday (1-7 days ago)
 * 3. "Monday": most recent Monday (1-7 days ago)
 */
export function calculateRelativeDates(refDate: Date = new Date()): RelativeDates {
  const currentYear = refDate.getFullYear();

  // 1. November 3rd
  const nov3ThisYear = new Date(Date.UTC(currentYear, 10, 3, 14, 20, 0));
  const novYear = refDate.getTime() >= nov3ThisYear.getTime() ? currentYear : currentYear - 1;
  const novDateStr = `${novYear}-11-03`;

  // 2. Previous Tuesday (strictly prior to refDate)
  const currentDay = refDate.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, ...
  let tueDiff = (currentDay - 2 + 7) % 7;
  if (tueDiff === 0) {
    tueDiff = 7;
  }
  const tuesday = new Date(refDate);
  tuesday.setDate(refDate.getDate() - tueDiff);
  const tueYear = tuesday.getFullYear();
  const tueMonth = String(tuesday.getMonth() + 1).padStart(2, '0');
  const tueDay = String(tuesday.getDate()).padStart(2, '0');
  const tueDateStr = `${tueYear}-${tueMonth}-${tueDay}`;

  // 3. Most recent Monday (strictly prior to refDate, 1-7 days ago)
  let monDiff = (currentDay - 1 + 7) % 7;
  if (monDiff === 0) {
    monDiff = 7;
  }
  const monday = new Date(refDate);
  monday.setDate(refDate.getDate() - monDiff);
  const monYear = monday.getFullYear();
  const monMonth = String(monday.getMonth() + 1).padStart(2, '0');
  const monDay = String(monday.getDate()).padStart(2, '0');
  const monDateStr = `${monYear}-${monMonth}-${monDay}`;

  return {
    nov3: {
      dateStr: novDateStr,
      userIso: `${novDateStr}T14:20:00Z`,
      assistantIso: `${novDateStr}T14:20:35Z`
    },
    lastTuesday: {
      dateStr: tueDateStr,
      userIso: `${tueDateStr}T10:15:00Z`,
      assistantIso: `${tueDateStr}T10:15:45Z`,
      daysAgo: tueDiff
    },
    recentMonday: {
      dateStr: monDateStr,
      userIso: `${monDateStr}T09:30:00Z`,
      assistantIso: `${monDateStr}T09:31:15Z`,
      daysAgo: monDiff
    }
  };
}

/**
 * Seeds the database with the 3 canonical temporal conversation threads.
 */
export function seedDatabase(force: boolean = false, refDate: Date = new Date()): { seeded: boolean; messages: Message[] } {
  if (!force && !isDatabaseEmpty()) {
    console.log('[Seed] Database already contains messages. Skipping automatic seeding.');
    return { seeded: false, messages: [] };
  }

  if (force) {
    console.log('[Seed] Force seeding enabled. Clearing existing records...');
    clearDatabase();
  }

  console.log(`[Seed] Calculating dynamic dates relative to: ${refDate.toISOString()}...`);
  const dates = calculateRelativeDates(refDate);

  console.log(`[Seed] Target Dates:
  - 3 November:   ${dates.nov3.dateStr}
  - Last Tuesday: ${dates.lastTuesday.dateStr} (${dates.lastTuesday.daysAgo} days ago)
  - Mon Shortlist:${dates.recentMonday.dateStr} (${dates.recentMonday.daysAgo} days ago)`);

  const insertedMessages: Message[] = [];

  // ==========================================
  // Thread 1: 3 November (Versions & Claude 3.5 Sonnet Rates)
  // ==========================================
  const nov3Session = 'session-nov3-versions';
  const nov3User = insertMessage(
    nov3Session,
    'user',
    'What is the latest stable release version of Next.js and Node.js LTS, and what are the current API token rates for Claude 3.5 Sonnet?',
    dates.nov3.userIso,
    'Next.js, Node.js, LTS, Claude 3.5 Sonnet, Anthropic, API pricing, token rates, versions',
    true // is_demo = 1
  );
  insertedMessages.push(nov3User);

  const nov3Assistant = insertMessage(
    nov3Session,
    'assistant',
    `Here are the latest versions and official API pricing as of November 3:

1. Next.js:
   - Latest stable release: Next.js 15.0.1
   - Highlights: React 19 GA readiness, Turbopack for local dev enabled by default, async Request APIs (cookies(), headers(), params), and un-cached fetch by default.

2. Node.js LTS:
   - Active LTS line: Node.js v22.11.0 (Codename 'Jod', released October 29).
   - Maintenance LTS: Node.js v20.18.0 ('Iron').

3. Anthropic Claude 3.5 Sonnet (claude-3-5-sonnet-20241022):
   - Input token rate: $3.00 per million tokens (MTok).
   - Output token rate: $15.00 per million tokens (MTok).
   - Prompt Caching write rate: $3.75 per million tokens (MTok).
   - Prompt Caching read rate: $0.30 per million tokens (MTok).
   - Context window: 200,000 tokens with max output of 8,192 tokens.`,
    dates.nov3.assistantIso,
    'Next.js, Node.js, LTS, Claude 3.5 Sonnet, Anthropic, API pricing, token rates, versions',
    true // is_demo = 1
  );
  insertedMessages.push(nov3Assistant);

  // ==========================================
  // Thread 2: Last Tuesday (Postgres Hosting Breakdown)
  // ==========================================
  const tueSession = 'session-tuesday-postgres';
  const tueUser = insertMessage(
    tueSession,
    'user',
    'Can you compare managed Postgres hosting across Supabase, Neon, AWS RDS, Render, and Railway? We need exact tier pricing, compute/vCPU, RAM, and storage limits for our production setup.',
    dates.lastTuesday.userIso,
    'Postgres, PostgreSQL hosting, Supabase, Neon, AWS RDS, Render, Railway, pricing, compute, storage limits, database',
    true // is_demo = 1
  );
  insertedMessages.push(tueUser);

  const tueAssistant = insertMessage(
    tueSession,
    'assistant',
    `Here is the detailed breakdown of managed Postgres hosting options discussed on Tuesday:

1. Supabase (Managed Postgres):
   - Pro Tier: $25/month base (includes $10 compute credits + 8 GB disk storage).
   - Compute add-ons: Micro (2 vCPU, 1 GB RAM shared) included in base; Small (2 vCPU, 2 GB RAM dedicated) +$15/mo ($0.0208/hr); Medium (2 vCPU, 4 GB RAM dedicated) +$60/mo ($0.0833/hr).
   - Storage limits: 8 GB included, extra storage billed at $0.125/GB/mo up to 16 TB.
   - Backups: 7-day automated backups; Point-in-time recovery (PITR) available for $100/mo.

2. Neon (Serverless Postgres):
   - Launch Tier: $19/month base (includes 10 CU compute, 10 GB storage, 50 GB data transfer).
   - Scale Tier: $69/month base (includes 50 CU compute, 50 GB storage, 250 GB data transfer).
   - Compute autoscaling: Scales dynamically between 0.25 CU and 8 CU (1 CU = 1 vCPU + 4 GB RAM, billed at $0.16/CU-hour). Scale-to-zero supported.
   - Storage limits: $0.15/GB/month for data storage, $0.096/GB for written data.

3. AWS RDS (PostgreSQL Engine):
   - Instance Tiers (Single-AZ on US-East-1):
     * db.t4g.micro: ~$0.016/hr (~$11.68/mo) - 2 burstable vCPUs, 1 GB RAM.
     * db.t4g.small: ~$0.032/hr (~$23.36/mo) - 2 burstable vCPUs, 2 GB RAM.
     * db.t4g.medium: ~$0.064/hr (~$46.72/mo) - 2 burstable vCPUs, 4 GB RAM.
   - Storage: General Purpose SSD (gp3) at $0.115/GB-month (includes baseline 3,000 IOPS and 125 MB/s throughput). Multi-AZ deployment doubles instance and storage costs.

4. Render (Managed PostgreSQL):
   - Starter Tier: $7/month - 0.5 vCPU, 512 MB RAM, 1 GB SSD.
   - Standard Tier: $20/month - 1 vCPU, 2 GB RAM, 10 GB SSD. Extra storage at $0.30/GB/month.
   - Pro Tier: $35/month - 2 vCPU, 4 GB RAM, 20 GB SSD.
   - Pro Plus Tier: $95/month - 4 vCPU, 8 GB RAM, 50 GB SSD.
   - Automated daily snapshots with 7-day retention included.

5. Railway (Postgres Database Service):
   - Base plan: $5/month platform fee + resource usage.
   - Resource pricing:
     * vCPU: $0.000231/vCPU/minute (~$10/vCPU/month).
     * RAM: $0.000115/GB/minute (~$5/GB/month).
   - Storage: Persistent disk volumes at $0.15/GB/month.
   - Specs: Scales up to 32 vCPUs and 64 GB RAM seamlessly.`,
    dates.lastTuesday.assistantIso,
    'Postgres, PostgreSQL hosting, Supabase, Neon, AWS RDS, Render, Railway, pricing, compute, storage limits, database',
    true // is_demo = 1
  );
  insertedMessages.push(tueAssistant);

  // ==========================================
  // Thread 3: Monday Shortlist (5 CRM Tools for 20-Person Sales Team)
  // ==========================================
  const crmSession = 'session-monday-crm';
  const crmUser = insertMessage(
    crmSession,
    'user',
    'We need to shortlist 5 CRM tools for a 20-person sales team. Can you provide the top options, their exact per-seat pricing, monthly costs for 20 seats, and standout features?',
    dates.recentMonday.userIso,
    'CRM, sales team, 20 seats, HubSpot, Pipedrive, Attio, Close, Folk, pricing, shortlist, comparison',
    true // is_demo = 1
  );
  insertedMessages.push(crmUser);

  const crmAssistant = insertMessage(
    crmSession,
    'assistant',
    `Here is the finalized shortlist of 5 CRM platforms for a 20-person sales team evaluated on Monday:

1. HubSpot Sales Hub:
   - Recommended Tier: Sales Hub Professional.
   - Per-seat pricing: $90 per seat/month (billed annually) or $100/seat/mo billed monthly. Base edition starts at $450/mo (includes first 5 seats) + $90/mo per additional seat.
   - 20-seat cost: $1,800/month ($21,600/year).
   - Key Features: Deal stage automation, custom reports and analytics dashboards, automated sales sequences, e-signatures, sales forecasting, meeting scheduler, and deep integration with marketing automation.

2. Pipedrive:
   - Recommended Tier: Professional (or Advanced).
   - Per-seat pricing: $64 per user/month billed annually ($79 billed monthly) for Professional; $49/user/mo annually for Advanced.
   - 20-seat cost: $1,280/month ($15,360/year) on Professional.
   - Key Features: Highly intuitive visual Kanban pipeline view, email open/click tracking with 2-way sync, automated workflow triggers, contact data enrichment, revenue forecasting, and e-signatures.

3. Attio:
   - Recommended Tier: Pro Tier.
   - Per-seat pricing: $59 per user/month billed annually ($69/user/mo billed monthly).
   - 20-seat cost: $1,180/month ($14,160/year).
   - Key Features: Modern relational database model for CRM, real-time multi-player collaboration, automatic enrichment of company & contact metadata from email/calendar sync, flexible custom objects, and powerful automated workflows.

4. Close:
   - Recommended Tier: Professional Plan.
   - Per-seat pricing: $99 per user/month billed annually ($109 billed monthly). (Growth plan is $49/user/mo).
   - 20-seat cost: $1,980/month ($23,760/year).
   - Key Features: Built-in two-way calling and SMS directly within the app, predictive dialer, automated multi-channel sequences, lead management, and detailed sales leaderboard activity reporting.

5. Folk (folk.app):
   - Recommended Tier: Premium Plan.
   - Per-seat pricing: $24 per user/month billed annually ($29 billed monthly).
   - 20-seat cost: $480/month ($5,760/year).
   - Key Features: Notion-like lightweight CRM flexibility, Chrome extension to clip LinkedIn contacts, contact deduplication, smart pipeline views, personalized bulk mail merge with AI variables, and frictionless team sharing.`,
    dates.recentMonday.assistantIso,
    'CRM, sales team, 20 seats, HubSpot, Pipedrive, Attio, Close, Folk, pricing, shortlist, comparison',
    true // is_demo = 1
  );
  insertedMessages.push(crmAssistant);

  const stats = getDatabaseStats();
  console.log(`[Seed] Database seeded successfully! (${stats.totalMessages} messages across ${stats.sessionsCount} sessions and ${stats.datesCount} distinct dates)`);

  return { seeded: true, messages: insertedMessages };
}

// Support direct invocation via CLI: npm run seed
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('seed.ts')) {
  console.log('[Seed CLI] Running seed script...');
  seedDatabase(true);
}

