require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'nexus-verify';
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';

const META_REDIRECT_URI =
  process.env.META_REDIRECT_URI ||
  `${BASE_URL}/api/meta/callback`;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public', 'public');

const ROOT_INDEX = path.join(ROOT_DIR, 'index.html');
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');

const DB_PATH =
  process.env.DB_PATH ||
  path.join(ROOT_DIR, 'nexus.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  job TEXT,
  agent_name TEXT,
  business TEXT,
  channel TEXT,
  tone TEXT,
  knowledge TEXT,
  escalation TEXT,
  actions_json TEXT,
  system_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  external_id TEXT,
  direction TEXT,
  message TEXT,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  url TEXT,
  source_type TEXT,
  raw_text TEXT,
  knowledge_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  channel TEXT,
  external_account_id TEXT,
  access_token TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

/* -------------------------------------------------------
   EXPRESS
------------------------------------------------------- */

app.disable('x-powered-by');

app.use(express.json({
  limit: '4mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '4mb'
}));

/*
  Serve files from /public if that directory exists.
*/
app.use(express.static(PUBLIC_DIR, {
  index: false,
  dotfiles: 'deny'
}));

/*
  The current repository contains index.html in the ROOT.
  We therefore serve only safe frontend asset types from root,
  instead of exposing server.js/package.json/etc.
*/
const SAFE_ROOT_ASSET_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.mjs',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.mp4',
  '.webm',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf'
]);

const BLOCKED_ROOT_FILES = new Set([
  'server.js',
  'package.json',
  'package-lock.json',
  'render.yaml',
  'Dockerfile',
  '.env',
  '.gitignore',
  'nexus.db',
  'nexus.db-shm',
  'nexus.db-wal'
]);

app.use((req, res, next) => {
  if (!req.path || req.path === '/') {
    return next();
  }

  const requestedName = path.basename(req.path);

  if (BLOCKED_ROOT_FILES.has(requestedName)) {
    return res.sendStatus(404);
  }

  const ext = path.extname(requestedName).toLowerCase();

  if (!SAFE_ROOT_ASSET_EXTENSIONS.has(ext)) {
    return next();
  }

  const filePath = path.resolve(ROOT_DIR, requestedName);
  const rootPath = path.resolve(ROOT_DIR);

  if (!filePath.startsWith(rootPath + path.sep)) {
    return res.sendStatus(403);
  }

  return res.sendFile(filePath, err => {
    if (err && !res.headersSent) {
      next();
    }
  });
});

/*
  Frontend entry point.
  Prefer /public/index.html if it exists.
  Otherwise use root/index.html.
*/
app.get('/', (req, res) => {
  const fs = require('fs');

  if (fs.existsSync(PUBLIC_INDEX)) {
    return res.sendFile(PUBLIC_INDEX);
  }

  if (fs.existsSync(ROOT_INDEX)) {
    return res.sendFile(ROOT_INDEX);
  }

  return res.status(500).send(
    'NEXUS frontend index.html was not found.'
  );
});

/* -------------------------------------------------------
   JOBS
------------------------------------------------------- */

const JOBS = {
  sales: {
    name: 'FOLLOWER',
    summary:
      'Qualifies new leads, answers approved questions, follows up and escalates high-intent conversations.'
  },

  support: {
    name: 'RECEPTION',
    summary:
      'Handles common customer questions, follows approved policies and escalates uncertain or sensitive cases.'
  },

  booking: {
    name: 'SCHEDULER',
    summary:
      'Collects booking details, checks configured rules and prepares or requests a booking action.'
  },

  content: {
    name: 'STUDIO',
    summary:
      'Turns approved business knowledge into platform-ready content while following the requested tone.'
  },

  operations: {
    name: 'ANALYST',
    summary:
      'Summarizes operational information, highlights exceptions and prepares human-review actions.'
  }
};

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function buildPrompt({
  business,
  job,
  channel,
  tone,
  knowledge,
  escalation,
  actions
}) {
  const selectedJob = JOBS[job] || JOBS.sales;

  return `
You are ${selectedJob.name}, the AI customer-facing employee for ${business}.

JOB:
${selectedJob.summary}

CHANNEL:
${channel}

TONE:
${tone}

APPROVED ACTIONS:
${(actions || []).join(', ') || 'Reply to customers'}

ESCALATION:
${escalation}

VERIFIED BUSINESS KNOWLEDGE:
${knowledge || '(No verified business knowledge supplied yet.)'}

RULES:

1. Only use verified business knowledge.
2. Never invent prices, services, availability, policies, addresses, opening hours, guarantees, credentials or other business facts.
3. If the answer is not available in verified knowledge, clearly say that you do not have that information yet and offer human assistance.
4. Answer the customer's actual question first.
5. Do not mention that you are an AI unless the customer asks.
6. Keep replies natural, concise and appropriate for the channel.
7. Use the customer's language whenever possible.
8. Never request passwords, payment-card numbers, security codes or unnecessary sensitive information.
9. Never make irreversible commitments without a configured business rule or human approval.
10. If the customer shows buying intent, guide them toward the next configured action.
11. Never claim an action was completed unless the system actually completed it.
12. If information is uncertain, escalate rather than guessing.
`.trim();
}

function upsertCustomer(name, email) {
  const existing = db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(email);

  if (existing) {
    return existing;
  }

  const result = db
    .prepare(
      'INSERT INTO customers(name, email) VALUES(?, ?)'
    )
    .run(
      name || 'NEXUS Customer',
      email
    );

  return db
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(result.lastInsertRowid);
}

function createAgent(data) {
  const job = JOBS[data.job]
    ? data.job
    : 'sales';

  const actions = Array.isArray(data.actions)
    ? data.actions
    : [];

  const prompt = buildPrompt({
    business: data.business,
    job,
    channel: data.channel,
    tone: data.tone,
    knowledge: data.knowledge,
    escalation: data.escalation,
    actions
  });

  const result = db.prepare(`
    INSERT INTO agents (
      customer_id,
      job,
      agent_name,
      business,
      channel,
      tone,
      knowledge,
      escalation,
      actions_json,
      system_prompt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.customerId || null,
    job,
    JOBS[job].name,
    data.business,
    data.channel,
    data.tone,
    data.knowledge,
    data.escalation,
    JSON.stringify(actions),
    prompt
  );

  return db
    .prepare('SELECT * FROM agents WHERE id = ?')
    .get(result.lastInsertRowid);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());

    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }

    url.hash = '';

    return url.toString();
  } catch {
    return null;
  }
}

function sourceType(url) {
  try {
    const hostname = new URL(url)
      .hostname
      .toLowerCase();

    if (hostname.includes('instagram.com')) {
      return 'Instagram';
    }

    if (hostname.includes('facebook.com')) {
      return 'Facebook';
    }

    if (hostname.includes('whatsapp.com')) {
      return 'WhatsApp';
    }

    return 'Website';
  } catch {
    return 'Website';
  }
}

function cleanText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtml(html, url) {
  const title =
    (
      html.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
      ) || []
    )[1] || '';

  const description =
    (
      html.match(
        /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["']/i
      ) || []
    )[1] || '';

  const ogTitle =
    (
      html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i
      ) || []
    )[1] || '';

  const headings = [
    ...html.matchAll(
      /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi
    )
  ]
    .map(match => cleanText(match[1]))
    .filter(Boolean)
    .slice(0, 80);

  const body = cleanText(html)
    .slice(0, 30000);

  const links = [
    ...html.matchAll(
      /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    )
  ]
    .map(match => ({
      href: match[1],
      text: cleanText(match[2])
    }))
    .filter(item => item.text)
    .slice(0, 100);

  return {
    url,
    title: cleanText(title),
    description: cleanText(description),
    ogTitle: cleanText(ogTitle),
    headings,
    body,
    links
  };
}

async function fetchPublicSource(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'NEXUS-Business-Analyzer/1.0'
      }
    });

    const text = await response.text();

    return {
      status: response.status,
      contentType:
        response.headers.get('content-type') || '',
      finalUrl: response.url,
      text: text.slice(0, 800000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAIText(data) {
  if (!data) {
    return '';
  }

  if (typeof data.output_text === 'string') {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.output)) {
    return '';
  }

  return data.output
    .flatMap(item => {
      if (!Array.isArray(item.content)) {
        return [];
      }

      return item.content;
    })
    .map(content => {
      if (typeof content.text === 'string') {
        return content.text;
      }

      return '';
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function answerWithAI(agent, message, channel) {
  if (!OPENAI_API_KEY) {
    return {
      response:
        'The AI provider is not configured on this server yet.',
      live: false,
      reason: 'OPENAI_API_KEY_MISSING'
    };
  }

  const input = `
BUSINESS:
${agent.business}

CHANNEL:
${channel || agent.channel}

VERIFIED BUSINESS KNOWLEDGE:
${agent.knowledge || '(none)'}

CUSTOMER MESSAGE:
${message}
`.trim();

  const response = await fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'Authorization':
          `Bearer ${OPENAI_API_KEY}`
      },

      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: agent.system_prompt,
        input,
        max_output_tokens: 500
      })
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `OpenAI returned an invalid JSON response (${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `OpenAI request failed with HTTP ${response.status}.`
    );
  }

  const text = extractOpenAIText(data);

  if (!text) {
    throw new Error(
      'OpenAI returned an empty response.'
    );
  }

  return {
    response: text,
    live: true,
    responseId: data.id || null
  };
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nexus-ai-engine',
    aiConfigured: Boolean(OPENAI_API_KEY),
    metaConfigured: Boolean(
      META_APP_ID &&
      META_APP_SECRET
    ),
    model: OPENAI_MODEL,
    baseUrl: BASE_URL,
    database: 'sqlite'
  });
});

/* -------------------------------------------------------
   BUSINESS ANALYZER
------------------------------------------------------- */

app.post(
  '/api/business/analyze',
  async (req, res) => {
    const url = normalizeUrl(
      req.body?.url
    );

    if (!url) {
      return res.status(400).json({
        error:
          'Enter a valid public http(s) URL.'
      });
    }

    try {
      const fetched =
        await fetchPublicSource(url);

      if (fetched.status >= 400) {
        return res.status(502).json({
          error:
            `Source returned HTTP ${fetched.status}.`
        });
      }

      const parsed = extractHtml(
        fetched.text,
        fetched.finalUrl || url
      );

      const type = sourceType(url);

      return res.json({
        ok: true,
        source: type,
        fetchStatus: fetched.status,
        contentType: fetched.contentType,
        finalUrl:
          fetched.finalUrl || url,

        knowledge: {
          sourceType: type,
          sourceUrl:
            fetched.finalUrl || url,

          businessName:
            parsed.ogTitle ||
            parsed.title ||
            new URL(url).hostname,

          description:
            parsed.description,

          headings:
            parsed.headings,

          pageText:
            parsed.body,

          usefulLinks:
            parsed.links
              .filter(item =>
                /menu|service|product|price|contact|location|about|book|shop|faq|hours/i
                  .test(
                    `${item.text} ${item.href}`
                  )
              )
              .slice(0, 40)
        }
      });
    } catch (error) {
      console.error(
        'Business analysis error:',
        error
      );

      return res.status(502).json({
        error:
          'Could not read that public source.'
      });
    }
  }
);

/* -------------------------------------------------------
   AGENT GENERATION
------------------------------------------------------- */

app.post(
  '/api/agent/generate',
  (req, res) => {
    try {
      const body = req.body || {};

      if (!body.business) {
        return res.status(400).json({
          error: 'Business name required'
        });
      }

      const customer =
        upsertCustomer(
          body.name ||
            'NEXUS Customer',

          body.email ||
            `customer-${crypto.randomUUID()}@nexus.local`
        );

      const agent = createAgent({
        customerId:
          body.customerId ||
          customer.id,

        business:
          body.business,

        job:
          body.job ||
          'sales',

        channel:
          body.channel ||
          'Website chat',

        tone:
          body.tone ||
          'Professional & friendly',

        knowledge:
          body.knowledge ||
          '',

        escalation:
          body.escalation ||
          'Ask a human when unsure',

        actions:
          Array.isArray(body.actions)
            ? body.actions
            : []
      });

      return res.json({
        agentId: agent.id,
        agentName: agent.agent_name,
        summary:
          JOBS[agent.job].summary,
        systemPrompt:
          agent.system_prompt,
        status: 'ready',
        aiConfigured:
          Boolean(OPENAI_API_KEY)
      });

    } catch (error) {
      console.error(
        'Agent generation error:',
        error
      );

      return res.status(500).json({
        error:
          'Could not generate the agent.'
      });
    }
  }
);

/* -------------------------------------------------------
   AGENT CHAT
------------------------------------------------------- */

app.post(
  '/api/agent/chat',
  async (req, res) => {
    const {
      agentId,
      message,
      channel
    } = req.body || {};

    if (!agentId || !message) {
      return res.status(400).json({
        error:
          'agentId and message required'
      });
    }

    const agent = db
      .prepare(
        'SELECT * FROM agents WHERE id = ?'
      )
      .get(agentId);

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found'
      });
    }

    try {
      const result =
        await answerWithAI(
          agent,
          String(message),
          channel || agent.channel
        );

      db.prepare(`
        INSERT INTO messages
        (agent_id, external_id, direction, message, response)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        agent.id,
        `chat-${Date.now()}-${crypto.randomUUID()}`,
        'inbound',
        String(message),
        result.response
      );

      return res.json(result);

    } catch (error) {
      console.error(
        'Agent chat error:',
        error
      );

      return res.status(502).json({
        error:
          error.message ||
          'AI request failed.'
      });
    }
  }
);

/* -------------------------------------------------------
   GENERIC CHANNEL INBOUND
------------------------------------------------------- */

app.post(
  '/api/channel/inbound',
  async (req, res) => {
    const {
      agentId,
      externalId,
      message,
      channel,
      customerRef
    } = req.body || {};

    if (!agentId || !message) {
      return res.status(400).json({
        error:
          'agentId and message required'
      });
    }

    const agent = db
      .prepare(
        'SELECT * FROM agents WHERE id = ?'
      )
      .get(agentId);

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found'
      });
    }

    try {
      const result =
        await answerWithAI(
          agent,
          String(message),
          channel || agent.channel
        );

      db.prepare(`
        INSERT INTO messages
        (agent_id, external_id, direction, message, response)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        agent.id,
        externalId ||
          `inbound-${crypto.randomUUID()}`,
        'inbound',
        String(message),
        result.response
      );

      return res.json({
        status: 'processed',

        mode:
          result.live
            ? 'live-ai'
            : 'engine-ready',

        agent:
          agent.agent_name,

        channel:
          channel || agent.channel,

        response:
          result.response,

        customerRef:
          customerRef || null
      });

    } catch (error) {
      console.error(
        'Channel inbound error:',
        error
      );

      return res.status(502).json({
        error:
          error.message ||
          'Channel processing failed.'
      });
    }
  }
);

/* -------------------------------------------------------
   META WEBHOOK VERIFICATION
------------------------------------------------------- */

app.get(
  '/api/webhooks/meta',
  (req, res) => {
    const mode =
      req.query['hub.mode'];

    const token =
      req.query['hub.verify_token'];

    const challenge =
      req.query['hub.challenge'];

    if (
      mode === 'subscribe' &&
      token === META_VERIFY_TOKEN
    ) {
      return res
        .status(200)
        .send(challenge);
    }

    return res.sendStatus(403);
  }
);

/*
  Meta webhook POST endpoint.

  For now it safely accepts and logs the
  incoming event. Actual message routing/sending
  requires the connected Page/Instagram account IDs
  and permissions.
*/
app.post(
  '/api/webhooks/meta',
  async (req, res) => {
    try {
      const body = req.body || {};

      console.log(
        'META WEBHOOK:',
        JSON.stringify(body)
      );

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        'Meta webhook error:',
        error
      );

      return res.sendStatus(200);
    }
  }
);

/* -------------------------------------------------------
   META OAUTH
------------------------------------------------------- */

const oauthStates = new Map();

function cleanupOAuthStates() {
  const now = Date.now();

  for (const [
    state,
    data
  ] of oauthStates.entries()) {
    if (data.expires <= now) {
      oauthStates.delete(state);
    }
  }
}

setInterval(
  cleanupOAuthStates,
  60 * 1000
).unref();

app.get(
  '/api/meta/connect',
  (req, res) => {
    if (
      !META_APP_ID ||
      !META_APP_SECRET
    ) {
      return res.status(503).send(
        'Meta OAuth is not configured on this server yet.'
      );
    }

    const agentId =
      String(
        req.query.agentId || ''
      );

    if (!agentId) {
      return res.status(400).send(
        'agentId is required'
      );
    }

    const agent = db
      .prepare(
        'SELECT id FROM agents WHERE id = ?'
      )
      .get(agentId);

    if (!agent) {
      return res.status(404).send(
        'Agent not found'
      );
    }

    const state =
      crypto.randomBytes(32)
        .toString('hex');

    oauthStates.set(
      state,
      {
        agentId,
        expires:
          Date.now() + 10 * 60 * 1000
      }
    );

    const url =
      new URL(
        `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`
      );

    url.searchParams.set(
      'client_id',
      META_APP_ID
    );

    url.searchParams.set(
      'redirect_uri',
      META_REDIRECT_URI
    );

    url.searchParams.set(
      'state',
      state
    );

    url.searchParams.set(
      'scope',
      process.env.META_SCOPE ||
        [
          'instagram_business_basic',
          'instagram_business_manage_messages',
          'pages_show_list',
          'pages_messaging'
        ].join(',')
    );

    return res.redirect(
      url.toString()
    );
  }
);

/* -------------------------------------------------------
   META OAUTH CALLBACK
------------------------------------------------------- */

app.get(
  '/api/meta/callback',
  async (req, res) => {
    const state =
      String(
        req.query.state || ''
      );

    const stored =
      oauthStates.get(state);

    oauthStates.delete(state);

    if (
      !stored ||
      stored.expires < Date.now()
    ) {
      return res.status(400).send(
        'Invalid or expired OAuth state.'
      );
    }

    if (!req.query.code) {
      return res.status(400).send(
        'Missing OAuth code.'
      );
    }

    try {
      const url =
        new URL(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`
        );

      url.searchParams.set(
        'client_id',
        META_APP_ID
      );

      url.searchParams.set(
        'client_secret',
        META_APP_SECRET
      );

      url.searchParams.set(
        'redirect_uri',
        META_REDIRECT_URI
      );

      url.searchParams.set(
        'code',
        String(req.query.code)
      );

      const response =
        await fetch(url.toString());

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          'Meta returned an invalid response.'
        );
      }

      if (
        !response.ok ||
        !data.access_token
      ) {
        throw new Error(
          data?.error?.message ||
          'Meta token exchange failed.'
        );
      }

      db.prepare(`
        INSERT INTO channel_connections
        (
          agent_id,
          channel,
          external_account_id,
          access_token,
          meta_json
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        stored.agentId,
        'Meta',
        '',
        data.access_token,
        JSON.stringify({
          connectedAt:
            new Date().toISOString()
        })
      );

      return res.send(
        'NEXUS Meta authorization completed. Return to your NEXUS workspace.'
      );

    } catch (error) {
      console.error(
        'Meta OAuth error:',
        error
      );

      return res.status(502).send(
        'Meta connection failed: ' +
        error.message
      );
    }
  }
);

/* -------------------------------------------------------
   404
------------------------------------------------------- */

app.use(
  (req, res) => {
    if (
      req.path.startsWith('/api/')
    ) {
      return res.status(404).json({
        error: 'API route not found'
      });
    }

    return res.status(404).send(
      'NEXUS page not found.'
    );
  }
);

/* -------------------------------------------------------
   ERROR HANDLER
------------------------------------------------------- */

app.use(
  (error, req, res, next) => {
    console.error(
      'Unhandled server error:',
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    return res.status(500).json({
      error:
        'Internal server error.'
    });
  }
);

/* -------------------------------------------------------
   START
------------------------------------------------------- */

const server = app.listen(
  PORT,
  () => {
    console.log(
      `NEXUS AI Engine running at ${BASE_URL}`
    );

    console.log(
      `OpenAI configured: ${Boolean(OPENAI_API_KEY)}`
    );

    console.log(
      `OpenAI model: ${OPENAI_MODEL}`
    );

    console.log(
      `Meta configured: ${Boolean(
        META_APP_ID &&
        META_APP_SECRET
      )}`
    );

    console.log(
      `Database: ${DB_PATH}`
    );
  }
);

/* -------------------------------------------------------
   GRACEFUL SHUTDOWN
------------------------------------------------------- */

function shutdown(signal) {
  console.log(
    `${signal} received. Shutting down...`
  );

  server.close(() => {
    try {
      db.close();
    } catch {}

    process.exit(0);
  });
}

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);
