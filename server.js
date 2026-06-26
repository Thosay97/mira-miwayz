const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Knowledge base removed -- using Claude+Rovo MCP as primary knowledge source

const app = express();
const PORT = process.env.PORT || 3001;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── HEALTH ── */
app.get('/api/health', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    res.json({
      status: 'online',
      ollama: 'connected',
      model: OLLAMA_MODEL,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY
    });
  } catch (e) {
    res.status(503).json({ status: 'error', ollama: 'offline' });
  }
});

/* ── JIRA PROXY (mirrors Chathura's server.py approach) ──
   Browser sends: GET /jira-proxy?target=https://miwayz.atlassian.net/rest/...
   Server forwards with Basic auth header passed through from browser
   This bypasses CORS and keeps credentials server-proxied
*/
app.get('/jira-proxy', async (req, res) => {
  const targetUrl = req.query.target;
  if (!targetUrl) return res.status(400).json({ error: "Missing 'target' query parameter" });

  // Only allow Atlassian domains
  try {
    const parsed = new URL(targetUrl);
    const allowed = parsed.hostname.endsWith('.atlassian.net') || parsed.hostname === 'api.atlassian.com';
    if (!allowed) return res.status(403).json({ error: 'Proxy only forwards to *.atlassian.net' });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader) return res.status(401).json({ error: 'No Authorization header provided' });

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    const body = await response.text();
    res.status(response.status)
       .set('Content-Type', 'application/json')
       .set('Cache-Control', 'no-store')
       .send(body);
  } catch (err) {
    console.error('Jira proxy error:', err.message);
    res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
});

/* ── JIRA LIVE DATA (server-side, uses .env credentials) ──
   Falls back to this when browser doesn't provide credentials.
   Uses same board→sprint→issues approach as Chathura's dashboard.
*/
let jiraCache = null, jiraCacheTime = 0; // cache cleared

app.get('/api/jira', async (req, res) => {
  const now = Date.now();
  if (jiraCache && (now - jiraCacheTime) < 5 * 60 * 1000) return res.json(jiraCache);
  if (!process.env.JIRA_API_TOKEN || !process.env.JIRA_EMAIL) {
    return res.status(500).json({ error: 'Jira credentials not configured in .env' });
  }

  const base = process.env.JIRA_BASE_URL || 'https://miwayz.atlassian.net';
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

  async function jiraGet(path) {
    const r = await fetch(`${base}${path}`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error(`Jira ${r.status} on ${path}`);
    return r.json();
  }

  try {
    // Step 1: Find the board for MICT project (same as Chathura's findBoard)
    const boardData = await jiraGet('/rest/agile/1.0/board?projectKeyOrId=MICT');
    if (!boardData.values || boardData.values.length === 0) {
      return res.status(404).json({ error: 'No agile board found for MICT project' });
    }
    const board = boardData.values.find(b => (b.type || '').toLowerCase() === 'scrum') || boardData.values[0];
    const boardId = board.id;
    console.log(`Board found: ${board.name} (ID: ${boardId})`);

    // Step 2: Find active sprint (same as Chathura's findActiveSprint)
    const sprintData = await jiraGet(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    if (!sprintData.values || sprintData.values.length === 0) {
      return res.json({ error: 'No active sprint found', gtmDays: calcGTM(), total: 0 });
    }
    const sprint = sprintData.values[0];
    const sprintId = sprint.id;
    const sprintGoal = sprint.goal || '';
    console.log(`Active sprint: ${sprint.name} (ID: ${sprintId})`);
    if(sprintGoal) console.log(`Sprint goal: ${sprintGoal}`);

    // Step 3: Fetch all sprint issues (same as Chathura's fetchAllSprintIssues)
    const fields = 'summary,status,issuetype,priority,assignee,parent,statuscategorychangedate,created';
    let allIssues = [], startAt = 0, total = Infinity;
    while (startAt < total) {
      const data = await jiraGet(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=${fields}`);
      total = data.total ?? data.issues.length;
      allIssues = allIssues.concat(data.issues || []);
      if (!data.issues || data.issues.length === 0) break;
      startAt += data.issues.length;
      if (startAt >= total) break;
    }
    console.log(`Fetched ${allIssues.length} issues from sprint ${sprint.name}`);

    // Step 3b: Smart child/subtask detection
    // Parent types: Story, Bug, Task, UI -- everything else is treated as a child item
    const PARENT_TYPES = ['story','bug','task','ui','epic','feature','improvement'];

    function isParentType(issue) {
      const itype = (issue.fields?.issuetype?.name || '').toLowerCase();
      // Explicitly known child types
      if (itype.includes('sub-task') || itype.includes('subtask') || itype.includes('child')) return false;
      // Known parent types
      if (PARENT_TYPES.some(t => itype === t || itype.includes(t))) return true;
      // Has a parent field set = it's a child
      if (issue.fields?.parent) return false;
      // Default: treat as parent if we're not sure
      return true;
    }

    try {
      const have = new Set(allIssues.map(i => i.key));

      // Strategy 1: Fetch by parent key for all known parent issues
      const parentKeys = allIssues.filter(i => isParentType(i)).map(i => i.key);
      console.log(`Found ${parentKeys.length} parent issues, fetching children...`);

      const batchSize = 40;
      for (let b = 0; b < parentKeys.length; b += batchSize) {
        const batch = parentKeys.slice(b, b + batchSize);
        const jql = encodeURIComponent(`parent in (${batch.join(',')}) AND sprint = ${sprintId}`);
        try {
          const childData = await jiraGet(`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${fields}`);
          let added = 0;
          for (const child of (childData.issues || [])) {
            if (!have.has(child.key)) {
              // Mark as subtask regardless of its issuetype name
              if (!child.fields) child.fields = {};
              if (!child.fields.issuetype) child.fields.issuetype = {};
              child.fields.issuetype._isChild = true;
              allIssues.push(child);
              have.add(child.key);
              added++;
            }
          }
          if (added > 0) console.log(`Children fetched: +${added} from batch ${Math.floor(b/batchSize)+1}`);
        } catch(e) { console.warn(`Batch ${Math.floor(b/batchSize)+1} failed:`, e.message); }
      }

      // Strategy 2: Catch any remaining by known child issuetype names
      const knownChildTypes = ['Sub-task','Subtask','Child Task','Child Issue','Sub Task'];
      const childTypeJql = encodeURIComponent(
        `sprint = ${sprintId} AND issuetype in (${knownChildTypes.map(t=>'"'+t+'"').join(',')})`
      );
      try {
        const childTypeData = await jiraGet(`/rest/api/3/search/jql?jql=${childTypeJql}&maxResults=200&fields=${fields}`);
        let added = 0;
        for (const child of (childTypeData.issues || [])) {
          if (!have.has(child.key)) { allIssues.push(child); have.add(child.key); added++; }
        }
        if (added > 0) console.log(`issuetype sweep: +${added} child issues`);
      } catch(e) { console.warn('issuetype sweep failed:', e.message); }

      // Strategy 3: Any issue in sprint with a parent field that we might have missed
      try {
        const parentedJql = encodeURIComponent(`sprint = ${sprintId} AND "Epic Link" is EMPTY AND parent is not EMPTY`);
        const parentedData = await jiraGet(`/rest/api/3/search/jql?jql=${parentedJql}&maxResults=200&fields=${fields}`);
        let added = 0;
        for (const child of (parentedData.issues || [])) {
          if (!have.has(child.key)) { allIssues.push(child); have.add(child.key); added++; }
        }
        if (added > 0) console.log(`parent-field sweep: +${added} issues`);
      } catch(e) { /* this JQL may not work on all Jira configs */ }

    } catch(e) { console.warn('Child task detection failed:', e.message); }
    console.log(`Total after child detection: ${allIssues.length} issues`);

    // Step 4: Bucket issues using MiWayz's exact status names (from Chathura's bucketForStatus)
    const counts = { done: 0, codeReview: 0, readyForQA: 0, inQA: 0, inProgress: 0, toDo: 0, blocked: 0, excluded: 0, total: 0 };
    const blockedTickets = [], inProgressTickets = [], reviewTickets = [];

    allIssues.forEach(issue => {
      const statusName = issue.fields?.status?.name || '';
      const bucket = bucketForStatus(statusName);
      if (bucket === 'excluded') return;
      counts.total++;
      counts[bucket]++;

      const key = issue.key;
      const summary = issue.fields?.summary || '';
      const assignee = issue.fields?.assignee?.displayName || 'Unassigned';

      if (bucket === 'blocked') blockedTickets.push({ key, summary, assignee, status: statusName });
      if (bucket === 'inProgress') inProgressTickets.push({ key, summary, assignee, status: statusName });
      if (bucket === 'codeReview' || bucket === 'readyForQA' || bucket === 'inQA') {
        reviewTickets.push({ key, summary, assignee, status: statusName });
      }
    });

    const gtmDays = calcGTM();
    const pct = (n) => Math.round((n / Math.max(counts.total, 1)) * 100);

    // Squad member mapping
    const squads = {
      sq1: ['Ashfak Khajudeen','Umar Muwahid','Jaliya Lamahewa','Kukeenthan Thiyaharasa','Nadee Prabha Swarnapali Silva','Sujanthan Arputharasu'],
      sq2: ['Chethana Jayasinghe','Husni Faiz','Dilip Vengadesan','Yuvanshan Prabakaran','Kasuni Piyumanthi'],
      sq3: ['Sineth Sandaruwan','Thanuja Mahendran','Vishagan Nadesalingam','Thajun Najaah','Oneli Visakya'],
      qa:  ['Shanilka','Umar Muwahid','Nadee Prabha Swarnapali Silva','Dilip Vengadesan','Kasuni Piyumanthi','Oneli Visakya'],
    };

    // Count done tickets per squad
    const squadDone = { sq1: 0, sq2: 0, sq3: 0, qa: 0 };
    const squadTotal = { sq1: 0, sq2: 0, sq3: 0, qa: 0 };
    allIssues.forEach(issue => {
      const assignee = issue.fields?.assignee?.displayName || '';
      const bucket = bucketForStatus(issue.fields?.status?.name || '');
      if (bucket === 'excluded') return;
      for (const [squad, members] of Object.entries(squads)) {
        if (members.some(m => assignee.includes(m.split(' ')[0]))) {
          squadTotal[squad]++;
          if (bucket === 'done') squadDone[squad]++;
          break;
        }
      }
    });

    const result = {
      sprintName: sprint.name,
      sprintGoal: sprintGoal,
      sprintId,
      boardId,
      gtmDays,
      total: counts.total,
      done: counts.done,
      codeReview: counts.codeReview,
      readyForQA: counts.readyForQA,
      inQA: counts.inQA,
      inProgress: counts.inProgress,
      toDo: counts.toDo,
      blocked: counts.blocked,
      donePercent: pct(counts.done),
      reviewPercent: pct(counts.codeReview + counts.readyForQA + counts.inQA),
      inProgressPercent: pct(counts.inProgress),
      blockedPercent: pct(counts.blocked),
      todoPercent: pct(counts.toDo),
      blockedTickets: blockedTickets.slice(0, 6),
      inProgressTickets: inProgressTickets.slice(0, 5),
      reviewTickets: reviewTickets.slice(0, 5),
      squads: {
        sq1: { done: squadDone.sq1, total: squadTotal.sq1, pct: Math.round((squadDone.sq1/Math.max(squadTotal.sq1,1))*100) },
        sq2: { done: squadDone.sq2, total: squadTotal.sq2, pct: Math.round((squadDone.sq2/Math.max(squadTotal.sq2,1))*100) },
        sq3: { done: squadDone.sq3, total: squadTotal.sq3, pct: Math.round((squadDone.sq3/Math.max(squadTotal.sq3,1))*100) },
        qa:  { done: squadDone.qa,  total: squadTotal.qa,  pct: Math.round((squadDone.qa /Math.max(squadTotal.qa, 1))*100) },
      },
      fetchedAt: new Date().toISOString(),
    };

    jiraCache = result;
    jiraCacheTime = now;
    res.json(result);

  } catch (err) {
    console.error('Jira fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function calcGTM() {
  return Math.max(0, Math.ceil((new Date('2026-07-12') - new Date()) / 86400000));
}

// MiWayz exact status mapping from Chathura's bucketForStatus
function mcpSystem(jira) {
  const gtmDays = Math.max(0, Math.ceil((new Date('2026-07-12') - new Date()) / 86400000));
  return `You are MIRA, MiWayz Intelligence and Resource Advisor for Thoshan Rathnayake, Product Owner at MiWayz — a Sri Lankan ride-hailing startup launching in Colombo on July 12 2026 (${gtmDays} days away). Current sprint: Sprint 29.
${jira ? `Live Jira: ${jira.total} tickets, ${jira.blocked} blocked, ${jira.donePercent}% done.` : ''}

You have full access to MiWayz's Atlassian workspace via Rovo. Proactively search Confluence and Jira when answering questions about product decisions, specs, or ticket details.
Reply in plain text only. No markdown bold or asterisks. Max 3 sentences unless a list is needed.`;
}

function bucketForStatus(name) {
  if (!name) return 'toDo';
  const n = name.trim().toLowerCase();
  if (n === 'done' || n === 'closed' || n === 'resolved' || n === 'not reproducible' || n === 'non reproducible' || n === 'non-reproducible' || n === "won't fix") return 'done';
  if (n === 'code review' || n === 'in review' || n === 'review') return 'codeReview';
  if (n === 'ready for qa' || n === 'ready for testing') return 'readyForQA';
  if (n === 'in qa' || n === 'in testing' || n === 'qa') return 'inQA';
  if (n === 'in progress' || n === 'in development' || n === 'developing') return 'inProgress';
  if (n === 'to do' || n === 'todo' || n === 'open' || n === 'backlog' || n === 'new') return 'toDo';
  if (n === 'blocked' || n === 'on hold' || n === 'blocked/on hold' || n === 'on-hold' || n === 'hold' || n === 'impediment') return 'blocked';
  if (n === 'cancelled' || n === 'canceled' || n === "won't do" || n === 'wont do') return 'excluded';
  return 'toDo';
}

/* ── CHAT (Groq primary, Ollama offline fallback) ── */
app.post('/api/chat', async (req, res) => {
  const { messages, jiraContext } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  // Try Groq first
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 300,
          temperature: 0.5,
          messages: [
            { role: 'system', content: miraSystem(jiraContext) },
            ...messages
          ],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || 'No response.';
        return res.json({ reply, source: 'groq' });
      }
      console.warn('Groq failed, falling back to Ollama');
    } catch (err) {
      console.warn('Groq error, falling back to Ollama:', err.message);
    }
  }

  // Ollama offline fallback
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.5, num_predict: 150 },
        messages: [
          { role: 'system', content: miraSystem(jiraContext) },
          ...messages
        ],
      }),
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Ollama error' });
    const data = await response.json();
    const reply = data.message?.content || 'No response from MIRA.';
    res.json({ reply, source: 'ollama' });
  } catch (err) {
    if (err.message.includes('ECONNREFUSED')) return res.status(503).json({ error: 'Ollama is not running. Start it with: ollama serve' });
    res.status(500).json({ error: err.message });
  }
});

/* ── ELEVENLABS TTS ── */
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!process.env.ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ElevenLabs not configured' });

  const voiceId = process.env.ELEVENLABS_VOICE_ID || '9BWtsMINqrJLrRacOk9x';
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs error:', err);
      return res.status(response.status).json({ error: 'ElevenLabs error: ' + response.status });
    }

    const audioBuffer = await response.arrayBuffer();
    console.log('ElevenLabs TTS success, bytes:', audioBuffer.byteLength);
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': audioBuffer.byteLength, 'Cache-Control': 'no-cache' });
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── CLAUDE MCP (Option 2 — Rovo/Confluence search) ──
   Routes knowledge-heavy queries to Claude API with Atlassian Rovo MCP.
   Requires ANTHROPIC_API_KEY in .env
   Falls back gracefully if not configured.
*/
app.post('/api/mcp', async (req, res) => {
  const { messages, jiraContext } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'Claude API not configured',
      fallback: true,
      message: 'Add ANTHROPIC_API_KEY to .env to enable Confluence and live Jira search'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: mcpSystem(jiraContext),
        messages,
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.atlassian.com/v1/mcp',
            name: 'atlassian-rovo',
          }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Claude MCP error:', err);
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error', fallback: true });
    }

    const data = await response.json();
    // Extract text from content blocks (may include tool_use blocks)
    const reply = data.content
      ?.filter(b => b.type === 'text')
      ?.map(b => b.text)
      ?.join(' ')
      || 'No response from Claude.';

    res.json({ reply, source: 'claude-mcp' });

  } catch (err) {
    console.error('Claude MCP error:', err.message);
    res.status(500).json({ error: err.message, fallback: true });
  }
});

/* ── MS TEAMS WEBHOOK ── */
app.post('/api/teams', async (req, res) => {
  const { type, jiraContext } = req.body;
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) return res.status(500).json({ error: 'TEAMS_WEBHOOK_URL not set in .env' });

  const jira = jiraContext;
  const gtmDays = Math.max(0, Math.ceil((new Date('2026-07-12') - new Date()) / 86400000));
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' });

  let card;

  if (type === 'sprint') {
    // Sprint status card
    card = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'Container',
              style: 'emphasis',
              items: [{
                type: 'ColumnSet',
                columns: [
                  { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '🟠', size: 'Large' }] },
                  { type: 'Column', width: 'stretch', items: [
                    { type: 'TextBlock', text: 'M.I.R.A. Sprint Update', weight: 'Bolder', size: 'Medium', color: 'Accent' },
                    { type: 'TextBlock', text: `${jira?.sprintName || 'Sprint 29'} · ${now}`, size: 'Small', isSubtle: true, spacing: 'None' }
                  ]}
                ]
              }]
            },
            {
              type: 'FactSet',
              facts: [
                { title: '📊 Total Tickets', value: `${jira?.total || 0}` },
                { title: '✅ Done', value: `${jira?.done || 0} (${jira?.donePercent || 0}%)` },
                { title: '🔄 In Progress', value: `${jira?.inProgress || 0}` },
                { title: '🔍 In Review/QA', value: `${(jira?.codeReview||0)+(jira?.readyForQA||0)+(jira?.inQA||0)} (${jira?.reviewPercent || 0}%)` },
                { title: '🚫 Blocked', value: `${jira?.blocked || 0} (${jira?.blockedPercent || 0}%)` },
                { title: '📅 GTM Launch', value: `${gtmDays} days remaining — July 12, 2026` },
              ]
            },
            jira?.blockedTickets?.length > 0 ? {
              type: 'Container',
              items: [
                { type: 'TextBlock', text: '🚨 Top Blockers', weight: 'Bolder', color: 'Attention' },
                ...jira.blockedTickets.slice(0,4).map(t => ({
                  type: 'TextBlock',
                  text: `• ${t.key} — ${t.summary.substring(0,55)}${t.summary.length>55?'...':''} (${t.assignee.split(' ')[0]})`,
                  size: 'Small', wrap: true, spacing: 'None'
                }))
              ]
            } : null,
          ].filter(Boolean),
          actions: [{
            type: 'Action.OpenUrl',
            title: 'Open Jira Board',
            url: `https://miwayz.atlassian.net/jira/software/projects/MICT/boards`
          }]
        }
      }]
    };
  } else if (type === 'gtm') {
    // GTM countdown card
    card = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: `🚀 MiWayz GTM Countdown`, weight: 'Bolder', size: 'Large', color: 'Accent' },
            { type: 'TextBlock', text: `**${gtmDays} days** until Colombo launch — July 12, 2026`, size: 'Medium', wrap: true },
            { type: 'TextBlock', text: `Sprint progress: ${jira?.donePercent || 0}% done · ${jira?.blocked || 0} blocked · ${jira?.total || 0} total tickets`, isSubtle: true, wrap: true }
          ]
        }
      }]
    };
  } else if (type === 'blockers') {
    // Blockers only card
    const blockers = jira?.blockedTickets || [];
    card = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: `🚨 Active Blockers — ${jira?.sprintName || 'Sprint 29'}`, weight: 'Bolder', size: 'Medium', color: 'Attention' },
            { type: 'TextBlock', text: `${blockers.length} blocked tickets as of ${now}`, isSubtle: true },
            ...blockers.map(t => ({
              type: 'Container',
              style: 'attention',
              items: [
                { type: 'TextBlock', text: `**${t.key}** — ${t.summary.substring(0,60)}`, wrap: true, size: 'Small' },
                { type: 'TextBlock', text: `Assigned to: ${t.assignee}`, isSubtle: true, size: 'Small', spacing: 'None' }
              ],
              spacing: 'Small'
            }))
          ],
          actions: [{
            type: 'Action.OpenUrl',
            title: 'Open Jira Board',
            url: `https://miwayz.atlassian.net/jira/software/projects/MICT/boards`
          }]
        }
      }]
    };
  } else {
    // Custom message
    const { message } = req.body;
    card = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: '🟠 M.I.R.A. · MiWayz Command', weight: 'Bolder', color: 'Accent' },
            { type: 'TextBlock', text: message || 'Update from MIRA', wrap: true }
          ]
        }
      }]
    };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('Teams webhook error:', err);
      return res.status(response.status).json({ error: 'Teams webhook failed: ' + response.status });
    }
    console.log(`Teams card sent: ${type}`);
    res.json({ success: true, type });
  } catch (err) {
    console.error('Teams error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── DYNAMIC WIDGET: Sprint Comparison ── */
app.get('/api/sprint/:sprintId', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  const base = process.env.JIRA_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  async function jiraGet(path) {
    const r = await fetch(`${base}${path}`, { headers: { 'Authorization': auth, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    return r.json();
  }
  try {
    const sprintId = req.params.sprintId;
    const fields = 'summary,status,issuetype,assignee,priority';
    let issues = [], startAt = 0, total = Infinity;
    while (startAt < total) {
      const data = await jiraGet(`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=${fields}`);
      total = data.total ?? data.issues.length;
      issues = issues.concat(data.issues || []);
      if (!data.issues || data.issues.length === 0) break;
      startAt += data.issues.length;
      if (startAt >= total) break;
    }
    const counts = { done:0, inProgress:0, inReview:0, blocked:0, toDo:0, total:0 };
    issues.forEach(i => {
      const b = bucketForStatus(i.fields?.status?.name||'');
      if (b === 'excluded') return;
      counts.total++;
      if (b === 'done') counts.done++;
      else if (b === 'inProgress') counts.inProgress++;
      else if (b === 'codeReview' || b === 'readyForQA' || b === 'inQA') counts.inReview++;
      else if (b === 'blocked') counts.blocked++;
      else counts.toDo++;
    });
    counts.donePercent = Math.round((counts.done/Math.max(counts.total,1))*100);
    counts.blockedPercent = Math.round((counts.blocked/Math.max(counts.total,1))*100);
    res.json({ sprintId, ...counts });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ── DYNAMIC WIDGET: Sprint Search by Name ── */
app.get('/api/sprint/search/:name', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  const base = process.env.JIRA_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  try {
    const r = await fetch(`${base}/rest/agile/1.0/board/154/sprint?state=closed,active&maxResults=50`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });
    const data = await r.json();
    const name = req.params.name.toLowerCase();
    const sprint = (data.values||[]).find(s => s.name.toLowerCase().includes(name));
    if (!sprint) return res.status(404).json({ error: `Sprint "${req.params.name}" not found` });
    res.json({ id: sprint.id, name: sprint.name, state: sprint.state });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ── DYNAMIC WIDGET: Custom JQL ── */
app.post('/api/jql', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  let { jql, maxResults = 100 } = req.body;
  if (!jql) return res.status(400).json({ error: 'jql required' });
  const base = process.env.JIRA_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

  try {
    // Replace openSprints() / openSprints with actual active sprint ID
    // so the regular search API can handle it
    if (jql.includes('openSprints') || jql.includes('activeSprint')) {
      try {
        const sprintData = await fetch(`${base}/rest/agile/1.0/board/154/sprint?state=active`, {
          headers: { 'Authorization': auth, 'Accept': 'application/json' }
        }).then(r=>r.json());
        const sprintId = sprintData.values?.[0]?.id;
        if (sprintId) {
          jql = jql.replace(/sprint\s+in\s+openSprints\(\)/gi, `sprint = ${sprintId}`);
          jql = jql.replace(/sprint\s*=\s*openSprints\(\)/gi, `sprint = ${sprintId}`);
          jql = jql.replace(/openSprints\(\)/gi, `sprint = ${sprintId}`);
          jql = jql.replace(/activeSprint\(\)/gi, `sprint = ${sprintId}`);
          console.log('JQL resolved to:', jql);
        }
      } catch(e) { console.warn('Could not resolve sprint ID:', e.message); }
    }

    const encoded = encodeURIComponent(jql);
    const r = await fetch(`${base}/rest/api/3/search/jql?jql=${encoded}&maxResults=${maxResults}&fields=summary,status,assignee,priority,issuetype`, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' }
    });
    if (!r.ok) {
      const e = await r.text();
      console.error('Jira JQL error:', e);
      return res.status(r.status).json({ error: 'Jira error: ' + r.status, detail: e });
    }
    const data = await r.json();
    console.log(`JQL returned ${data.total} total, ${data.issues?.length} fetched`);

    const issues = (data.issues||[]).map(i => ({
      key: i.key,
      summary: i.fields?.summary||'',
      status: i.fields?.status?.name||'',
      assignee: i.fields?.assignee?.displayName||'Unassigned',
      priority: i.fields?.priority?.name||'',
      type: i.fields?.issuetype?.name||'',
      bucket: bucketForStatus(i.fields?.status?.name||''),
    }));

    // Build chart data from fetched issues (not just data.total)
    const byStatus = {}, byAssignee = {}, byType = {};
    issues.forEach(i => {
      byStatus[i.status] = (byStatus[i.status]||0)+1;
      // Shorten assignee to first name for cleaner charts
      const firstName = i.assignee.split(' ')[0];
      byAssignee[firstName] = (byAssignee[firstName]||0)+1;
      byType[i.type] = (byType[i.type]||0)+1;
    });

    res.json({
      issues,
      total: data.total ?? issues.length,
      fetched: issues.length,
      byStatus,
      byAssignee,
      byType,
      jql
    });
  } catch(err) {
    console.error('JQL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── INTENT PARSER: Detect widget commands from chat ── */
app.post('/api/intent', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!process.env.GROQ_API_KEY) return res.json({ intent: 'chat' });

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 150,
        temperature: 0,
        messages: [{
          role: 'system',
          content: `You are an intent classifier for a Jira dashboard. Current sprint is Sprint 29 (ID: 1355). Board ID is 154.
Classify the user message and respond with JSON only. No explanation.

Intents:
- sprint_compare: comparing two sprints. Extract sprint names/numbers.
- jql_widget: custom Jira filter or query. Generate the JQL.
- chart_widget: wants a chart. Generate JQL and chart type (pie/bar/donut).
- standup: wants standup report or daily standup.
- burndown: wants burndown chart for current sprint.
- briefing: wants morning briefing or daily briefing.
- chat: general question, not a widget request.

Examples:
"compare sprint 27 and 28" -> {"intent":"sprint_compare","sprints":["Sprint 27","Sprint 28"]}
"show blocked tickets for Jaliya" -> {"intent":"jql_widget","jql":"project=MICT AND sprint = 1355 AND status=Blocked AND assignee='Jaliya Lamahewa'","title":"Blocked - Jaliya"}
"show me a pie chart of ticket status" -> {"intent":"chart_widget","jql":"project=MICT AND sprint = 1355","chartType":"pie","groupBy":"status","title":"Sprint Status"}
"bar chart of tickets by assignee" -> {"intent":"chart_widget","jql":"project=MICT AND sprint = 1355","chartType":"bar","groupBy":"assignee","title":"Tickets by Assignee"}
"pie chart by assignee" -> {"intent":"chart_widget","jql":"project=MICT AND sprint = 1355","chartType":"pie","groupBy":"assignee","title":"Tickets by Assignee"}
"donut chart ticket types" -> {"intent":"chart_widget","jql":"project=MICT AND sprint = 1355","chartType":"donut","groupBy":"type","title":"Ticket Types"}
"generate standup" -> {"intent":"standup"}
"show burndown" -> {"intent":"burndown"}
"morning briefing" -> {"intent":"briefing"}
"what is the sprint status" -> {"intent":"chat"}`
        }, { role: 'user', content: text }]
      })
    });
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content?.trim()||'{"intent":"chat"}';
    const clean = raw.replace(/```json|```/g,'').trim();
    res.json(JSON.parse(clean));
  } catch(e) { res.json({ intent: 'chat' }); }
});

/* ── STANDUP GENERATOR ── */
app.get('/api/standup', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  const base = process.env.JIRA_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  async function jiraGet(path) {
    const r = await fetch(`${base}${path}`, { headers: { 'Authorization': auth, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    return r.json();
  }
  try {
    // Get active sprint issues
    const sprintData = await jiraGet('/rest/agile/1.0/board/154/sprint?state=active');
    const sprint = sprintData.values[0];
    const fields = 'summary,status,assignee,updated,created,priority';
    const data = await jiraGet(`/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=200&fields=${fields}`);
    const issues = data.issues || [];

    // Yesterday boundary
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0,0,0,0);

    const squads = {
      'Squad 1': ['Ashfak','Jaliya','Kukeenthan','Sujanthan','Umar','Nadee'],
      'Squad 2': ['Chethana','Husni','Yuvanshan','Dilip','Kasuni'],
      'Squad 3': ['Sineth','Thanuja','Thajun','Vishagan','Oneli'],
    };

    const standup = {};
    Object.keys(squads).forEach(sq => { standup[sq] = { done: [], inProgress: [], blocked: [], updatedYesterday: [] }; });

    issues.forEach(issue => {
      const assignee = issue.fields?.assignee?.displayName || '';
      const firstName = assignee.split(' ')[0];
      const status = issue.fields?.status?.name || '';
      const bucket = bucketForStatus(status);
      const updated = new Date(issue.fields?.updated);
      const summary = issue.fields?.summary?.substring(0,55) || '';
      const key = issue.key;

      let squad = null;
      for (const [sq, members] of Object.entries(squads)) {
        if (members.some(m => firstName.includes(m) || assignee.includes(m))) { squad = sq; break; }
      }
      if (!squad) return;

      if (bucket === 'done') standup[squad].done.push({ key, summary, assignee: firstName });
      else if (bucket === 'inProgress') standup[squad].inProgress.push({ key, summary, assignee: firstName });
      else if (bucket === 'blocked') standup[squad].blocked.push({ key, summary, assignee: firstName });
      if (updated >= yesterday) standup[squad].updatedYesterday.push({ key, summary, status, assignee: firstName });
    });

    // Build text summary for MIRA to speak
    const gtmDays = Math.max(0, Math.ceil((new Date('2026-07-12') - new Date()) / 86400000));
    let summary = 'Sprint ' + sprint.name + ' Standup. ' + gtmDays + ' days to GTM. ';
    for (const [sq, sqData] of Object.entries(standup)) {
      summary += sq + ': ' + sqData.done.length + ' done, ' + sqData.inProgress.length + ' in progress, ' + sqData.blocked.length + ' blocked. ';
      if (sqData.updatedYesterday.length > 0) summary += sqData.updatedYesterday.length + ' tickets updated yesterday. ';
    }

    res.json({ sprint: sprint.name, gtmDays, standup, summary, generatedAt: new Date().toISOString() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ── BURNDOWN DATA ── */
app.get('/api/burndown', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  const base = process.env.JIRA_BASE_URL;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  async function jiraGet(path) {
    const r = await fetch(`${base}${path}`, { headers: { 'Authorization': auth, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    return r.json();
  }
  try {
    const sprintData = await jiraGet('/rest/agile/1.0/board/154/sprint?state=active');
    const sprint = sprintData.values[0];
    const startDate = new Date(sprint.startDate);
    const endDate = new Date(sprint.endDate);
    const today = new Date();

    // Fetch all issues with creation and resolution dates
    const fields = 'summary,status,resolutiondate,created,statuscategorychangedate';
    const data = await jiraGet(`/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=300&fields=${fields}`);
    const issues = data.issues || [];
    const total = issues.length;

    // Build daily burndown -- count remaining (not done) per day
    const days = [];
    const current = new Date(startDate);
    current.setHours(0,0,0,0);
    const end = new Date(Math.min(today.getTime(), endDate.getTime()));

    while (current <= end) {
      const dayEnd = new Date(current);
      dayEnd.setHours(23,59,59,999);
      // Count issues NOT done by end of this day
      const remaining = issues.filter(issue => {
        const resDate = issue.fields?.resolutiondate || issue.fields?.statuscategorychangedate;
        const bucket = bucketForStatus(issue.fields?.status?.name || '');
        if (bucket !== 'done') return true; // still open
        if (!resDate) return false;
        return new Date(resDate) > dayEnd; // resolved after this day
      }).length;
      days.push({
        date: current.toLocaleDateString('en-GB', { day:'numeric', month:'short' }),
        remaining,
        ideal: Math.round(total * (1 - (current - startDate) / (endDate - startDate)))
      });
      current.setDate(current.getDate() + 1);
    }

    // Project remaining days (ideal line only)
    const projCurrent = new Date(today);
    projCurrent.setDate(projCurrent.getDate() + 1);
    while (projCurrent <= endDate) {
      days.push({
        date: projCurrent.toLocaleDateString('en-GB', { day:'numeric', month:'short' }),
        remaining: null, // no actual data yet
        ideal: Math.round(total * (1 - (projCurrent - startDate) / (endDate - startDate)))
      });
      projCurrent.setDate(projCurrent.getDate() + 1);
    }

    res.json({
      sprint: sprint.name,
      total,
      done: issues.filter(i => bucketForStatus(i.fields?.status?.name||'') === 'done').length,
      days,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ── DAILY BRIEFING ── */
app.get('/api/briefing', async (req, res) => {
  if (!process.env.JIRA_API_TOKEN) return res.status(500).json({ error: 'Jira not configured' });
  try {
    // Pull live Jira data (use cache if fresh)
    const jiraRes = await fetch(`http://localhost:${process.env.PORT||3001}/api/jira`);
    const jira = await jiraRes.json();
    const standupRes = await fetch(`http://localhost:${process.env.PORT||3001}/api/standup`);
    const standup = await standupRes.json();

    const today = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
    const gtmDays = jira.gtmDays || 0;

    // Build briefing text
    const briefing = {
      date: today,
      gtmDays,
      sprintName: jira.sprintName,
      sprintGoal: jira.sprintGoal,
      total: jira.total,
      done: jira.done,
      donePercent: jira.donePercent,
      blocked: jira.blocked,
      inProgress: jira.inProgress,
      blockedTickets: jira.blockedTickets || [],
      standup: standup.standup,
      speech: `Good morning Thoshan. Today is ${today}. You have ${gtmDays} days until the Colombo GTM launch.
${jira.sprintGoal ? 'Sprint goal: ' + jira.sprintGoal + '.' : ''}
${jira.sprintName} has ${jira.total} tickets. ${jira.done} are done, that is ${jira.donePercent} percent.
${jira.blocked > 0 ? `There are ${jira.blocked} blocked tickets that need your attention.` : 'No blockers today, great work team.'}
${jira.blockedTickets?.[0] ? 'Top blocker is ' + jira.blockedTickets[0].key + ' assigned to ' + jira.blockedTickets[0].assignee.split(' ')[0] + '.' : ''}
Have a productive day.`
    };
    res.json(briefing);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  M.I.R.A. command online`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Brain:       Groq · llama-3.3-70b ${process.env.GROQ_API_KEY ? '✓' : '✗ (add GROQ_API_KEY)'}`);
  console.log(`  Fallback:    Ollama · ${OLLAMA_MODEL}`);
  console.log(`  Jira:        ${process.env.JIRA_EMAIL || 'not configured'}`);
  console.log(`  ElevenLabs:  ${process.env.ELEVENLABS_API_KEY ? 'connected ✓' : 'not configured'}`);
  console.log(`  MS Teams:    ${process.env.TEAMS_WEBHOOK_URL ? 'connected ✓' : 'not configured'}\n`);
});

function miraSystem(jira) {
  const liveData = jira && jira.total > 0 ? `
CURRENT SPRINT DATA (${jira.sprintName || 'Sprint 29'}) — from Jira:
- Sprint Goal: ${jira.sprintGoal || 'Not set'}
- Total tickets: ${jira.total}
- Done: ${jira.done} (${jira.donePercent}%)
- In Progress: ${jira.inProgress}
- In Review (Code Review + Ready for QA + In QA): ${(jira.codeReview||0)+(jira.readyForQA||0)+(jira.inQA||0)} (${jira.reviewPercent}%)
- Blocked: ${jira.blocked} (${jira.blockedPercent}%)
- To Do: ${jira.toDo}
- GTM days remaining: ${jira.gtmDays}
- Top blocked tickets: ${jira.blockedTickets?.slice(0,3).map(t => t.key + ' (' + t.assignee.split(' ')[0] + ')').join(', ') || 'none'}
` : `No live Jira data. GTM days remaining: ${Math.max(0,Math.ceil((new Date('2026-07-12')-new Date())/864e5))}`;

  return `You are MIRA, an AI command assistant for Thoshan Rathnayake, Product Owner at MiWayz — a Sri Lankan ride-hailing startup launching in Colombo on July 12 2026.

STRICT RULES — follow every one:
- "Sprint" always means a Jira software development sprint, never a physical run
- You are a read-only assistant — you CANNOT send messages, emails, Teams messages, or contact anyone
- If asked to contact or check with someone, say clearly: "I am not able to send messages or contact team members directly."
- Do not invent ticket numbers, statuses, or product features
- Do not use markdown bold (**text**), asterisks, or (Reference: ...) tags — plain text only
- No em dashes

CORRECT TEAM ROLES:
- Chathura: Head of Engineering
- Thoshan Rathnayake: Product Owner
- Shanilka: Senior Business Analyst (Senior BA) — NOT QA
- Nimeshika Mandakini: Business Analyst (BA)
- Gimantha: Designer
- Umar Muwahid: QA Lead (Squad 1)
- Dilip Vengadesan: QA Lead (Squad 2)
- Nadee Prabha, Kasuni Piyumanthi, Oneli Visakya: QA Engineers
- Jaliya, Ashfak, Kukeenthan, Sujanthan: Squad 1 devs
- Chethana, Husni, Yuvanshan: Squad 2 devs
- Sineth, Thanuja, Thajun: Squad 3 devs

${liveData}

Reply in plain text only. Max 3 sentences. No bullet points unless specifically asked.`;
}
