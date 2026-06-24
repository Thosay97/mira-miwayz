# M.I.R.A. · MiWayz Command Interface
### Powered by Ollama (qwen2.5) — 100% offline, no API keys

Runs entirely on your Mac. No cloud. No cost. No org restrictions.

---

## Prerequisites
- Node.js installed (nodejs.org)
- Ollama installed with qwen2.5 pulled

Confirm Ollama is ready:
```bash
ollama list
# should show qwen2.5
```

---

## Setup (3 minutes)

### 1. Enter the folder
```bash
cd Downloads/mira-miwayz
```

### 2. Create your .env file
```bash
cp .env.example .env
```
The defaults work out of the box — no keys needed for Ollama.
Optionally add your Jira token for live sprint data.

### 3. Install dependencies
```bash
npm install
```

### 4. Make sure Ollama is running
Ollama should start automatically when you open the app.
If not, run in a separate Terminal:
```bash
ollama serve
```

### 5. Start MIRA
```bash
npm start
```

You should see:
```
  M.I.R.A. command online  [Ollama · qwen2.5]
  http://localhost:3001
  Ollama: http://localhost:11434
```

### 6. Open Chrome → http://localhost:3001 → F11 fullscreen

---

## Controls
| Action | Result |
|--------|--------|
| Click the orb | Wake MIRA / toggle mic |
| Spacebar | Wake / toggle mic |
| Say "Hey MIRA" | Auto-wake (Chrome only) |
| Type + Enter | Send command |

---

## Note on response speed
Ollama runs the model locally on your Mac's CPU/GPU.
First response may take 5-10 seconds while the model warms up.
Subsequent responses are faster.

---

## Running JARVIS and MIRA at the same time
- JARVIS runs on port 3000 → http://localhost:3000
- MIRA runs on port 3001 → http://localhost:3001
Open both in separate Chrome tabs — they run independently!

---

## File structure
```
mira-miwayz/
├── server.js        ← Node backend (Ollama proxy)
├── package.json
├── .env             ← Config (safe, no API keys needed)
├── .env.example     ← Template
├── .gitignore
└── public/
    └── index.html   ← MIRA frontend
```
