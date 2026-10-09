import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const DEFAULT_PORT = 3000;
const ENV_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Prevent stale caching for HTML and Service Worker so updates apply instantly
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.path === '/sw.js' || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (req.path.endsWith('.png') || req.path.endsWith('.ico') || req.path.endsWith('.jpg')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

// Explicit route for Web App Manifest with correct Content-Type and cacheable header for WebAPK
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Route to download Android APK directly with friendly filename and Content-Type
app.get(['/diario-embarque.apk', '/download-apk', '/app.apk'], (req, res) => {
  const apkPath = path.join(__dirname, 'diario-embarque.apk');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="diario-embarque.apk"');
  res.sendFile(apkPath);
});

// Endpoint to download PDF files directly with HTTP Content-Disposition attachment
// This ensures Android DownloadManager in WebView/APK and mobile browsers downloads the file directly into /Download
const tempPdfMap = new Map();

app.post('/api/prepare-pdf-download', (req, res) => {
  try {
    const { filename, pdfBase64 } = req.body;
    if (!filename || !pdfBase64) {
      return res.status(400).json({ error: 'Missing filename or pdfBase64' });
    }
    const token = 'pdf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    tempPdfMap.set(token, {
      filename,
      buffer,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    // Cleanup expired
    for (const [k, v] of tempPdfMap.entries()) {
      if (v.expires < Date.now()) tempPdfMap.delete(k);
    }

    res.json({
      success: true,
      downloadUrl: `/api/download-pdf/${token}/${encodeURIComponent(filename)}`,
      viewUrl: `/api/view-pdf/${token}/${encodeURIComponent(filename)}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download-pdf/:token/:filename', (req, res) => {
  const { token, filename } = req.params;
  const item = tempPdfMap.get(token);
  if (!item) {
    return res.status(404).send('Arquivo PDF expirado ou não encontrado.');
  }
  const safeFilename = filename || item.filename || 'voo.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(item.buffer);
});

// Endpoint para visualização direta do PDF (inline) para abrir no navegador/leitor do celular
app.get('/api/view-pdf/:token/:filename', (req, res) => {
  const { token, filename } = req.params;
  const item = tempPdfMap.get(token);
  if (!item) {
    return res.status(404).send('Arquivo PDF expirado ou não encontrado.');
  }
  const safeFilename = filename || item.filename || 'voo.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(item.buffer);
});

// Proxy endpoint for OpenSky Network to bypass client-side iframe restrictions & CORS
app.get('/api/opensky', async (req, res) => {
  const { lamin, lomin, lamax, lomax } = req.query;
  const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent': 'DiarioDeEmbarque/1.0'
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch OpenSky data' });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Explicit route for intro video with video/mp4 MIME type and range support
app.get(['/intro.mp4', '/video-intro', '/intro-video.mp4'], (req, res) => {
  const videoPath = path.join(__dirname, 'intro.mp4');
  res.sendFile(videoPath);
});

// Cache for live Google Sheet flights data
let cachedSheetFlights = null;
let lastSheetFetchTime = 0;
const SHEET_CACHE_TTL = 2 * 60 * 1000; // 2 minutes cache

async function fetchGoogleSheetFlights() {
  const now = Date.now();
  if (cachedSheetFlights && (now - lastSheetFetchTime < SHEET_CACHE_TTL)) {
    return cachedSheetFlights;
  }

  const sheetUrl = 'https://docs.google.com/spreadsheets/d/1j-BTNkRa2SV_ki6nVv_K5kN8rL0tkMvj4ZoJyeNR92U/export?format=csv';
  try {
    const response = await fetch(sheetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Google Sheet response: ${response.status} ${response.statusText}`);
    }

    const csvText = await response.text();
    // Robust character-by-character CSV parser handling multiline quotes
    const rows = [];
    let currentRow = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < csvText.length; i++) {
      const c = csvText[i];
      const next = csvText[i + 1];
      if (c === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        currentRow.push(field.trim());
        field = '';
      } else if ((c === '\r' || c === '\n') && !inQuotes) {
        if (c === '\r' && next === '\n') i++;
        currentRow.push(field.trim());
        field = '';
        if (currentRow.length > 0 && currentRow.some(x => x !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        field += c;
      }
    }
    if (field || currentRow.length > 0) {
      currentRow.push(field.trim());
      if (currentRow.some(x => x !== '')) rows.push(currentRow);
    }

    const flights = [];
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const voo = row[22] || '';
      const dest = row[23] || '';
      const prefixo = row[20] || '';
      // Skip rows with no flight number, destination or prefix
      if (!voo && !dest && !prefixo) continue;
      if (prefixo.includes('PROG') || prefixo.includes('CHEGADAS')) continue;

      flights.push({
        prefixo,
        dataDep: row[21] || '',
        voo,
        dest,
        std: row[24] || '',
        porta: row[25] || '',
        porao: row[26] || '',
        push: row[27] || '',
        etd: row[28] || '',
        boxdep: row[29] || '',
        portao: row[30] || '',
        escadaRemota: row[31] || '',
        obsDep: row[32] || '',
        troca: row[33] || '',
        embarque: row[34] || '',
        nomeDotSaida: row[35] || '',
        obsDot: row[36] || '',
        tat: row[38] || '',
        trip: row[40] || '',
        controller: row[47] || '',
        ramalController: row[48] || '',
        agente1: row[49] || '',
        agente2: row[50] || '',
        agente3: row[51] || '',
        agente4: row[52] || '',
        ramalEmbarque: row[53] || '',
        totalPax: row[54] || '',
        totalLoad: row[55] || '',
        bagRetida: row[56] || '',
        bagRetidaChk: row[57] || '',
        bagRetidaEmb: row[58] || '',
        otp: row[59] || '',
        cod1: row[60] || '',
        cod2: row[61] || '',
        cod3: row[62] || '',
        descricaoAtraso: row[63] || '',
        frota: row[70] || '',
        status: row[76] || ''
      });
    }

    cachedSheetFlights = flights;
    lastSheetFetchTime = now;
    return flights;
  } catch (err) {
    console.error('Error fetching Google Sheet:', err.message);
    if (cachedSheetFlights) return cachedSheetFlights;
    return [];
  }
}

// Helper to get today's date formatted as DD/MM in Brazil (São Paulo) time
function getTodayDateBR() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit'
  });
  return formatter.format(now); // e.g. "05/10"
}

// Endpoint to query Google Sheet flights filtered strictly by the current day's date
app.get('/api/google-sheet-flights', async (req, res) => {
  try {
    const flights = await fetchGoogleSheetFlights();
    const q = (req.query.q || '').trim().toLowerCase();
    const prefixo = (req.query.prefixo || '').trim().toLowerCase();
    const dest = (req.query.dest || '').trim().toLowerCase();
    const voo = (req.query.voo || '').trim().toLowerCase();
    const todayBR = getTodayDateBR();
    const queryDate = req.query.date ? req.query.date.trim() : null;
    const allowAllDates = req.query.allDates === 'true';

    // Filter to bring ONLY the date of the current day by default
    let filtered = flights;
    const targetDate = queryDate || todayBR;

    if (!allowAllDates && targetDate) {
      filtered = filtered.filter(f => (f.dataDep || '').trim() === targetDate);
    }

    if (q) {
      filtered = filtered.filter(f => {
        const fVoo = (f.voo || '').toLowerCase();
        const fDest = (f.dest || '').toLowerCase();
        const fPref = (f.prefixo || '').toLowerCase();
        const fLast3 = fPref.replace(/[^a-zA-Z]/g, '').slice(-3);
        const fPort = (f.portao || '').toLowerCase();
        const fBox = (f.boxdep || '').toLowerCase();
        return fVoo.includes(q) || fDest.includes(q) || fPref.includes(q) || fLast3.includes(q) || fPort.includes(q) || fBox.includes(q);
      });
    }
    if (prefixo) {
      filtered = filtered.filter(f => {
        const fPref = (f.prefixo || '').toLowerCase();
        const fLast3 = fPref.replace(/[^a-zA-Z]/g, '').slice(-3);
        return fPref.includes(prefixo) || fLast3.includes(prefixo);
      });
    }
    if (dest) {
      filtered = filtered.filter(f => (f.dest || '').toLowerCase().includes(dest));
    }
    if (voo) {
      filtered = filtered.filter(f => (f.voo || '').toLowerCase().includes(voo));
    }

    res.json({
      status: 'success',
      currentDateBR: todayBR,
      targetDate: !allowAllDates ? targetDate : 'todas',
      total: filtered.length,
      lastUpdated: new Date(lastSheetFetchTime || Date.now()).toISOString(),
      flights: filtered.slice(0, 150)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to synthesize a crisp Jarvis audio chime WAV file as guaranteed fallback
function generateChimeWav() {
  const sampleRate = 44100;
  const duration = 1.2;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(44 + numSamples * 2);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-3.2 * t);
    const sample = (
      Math.sin(2 * Math.PI * 440 * t) * 0.4 +
      Math.sin(2 * Math.PI * 660 * t) * 0.35 +
      Math.sin(2 * Math.PI * 880 * t) * 0.25
    ) * env;
    const intSample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * 2);
  }
  return buffer;
}

// Endpoint for high-fidelity Jarvis voice greeting using Gemini TTS with PCM chime fallback
app.get(['/api/boas-vindas-audio', '/api/welcome-audio'], async (req, res) => {
  const rawNome = (req.query.nome || req.query.name || 'Agente').trim();
  const nome = rawNome.replace(/[<>"'/\\&]/g, '').slice(0, 30) || 'Agente';
  const cacheKey = nome.toLowerCase();

  if (welcomeAudioCache.has(cacheKey)) {
    const cached = welcomeAudioCache.get(cacheKey);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(cached);
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI();
      const prompt = `Diga com energia e cordialidade em português do Brasil: Seja bem-vindo, ${nome}! Sua jornada começa aqui.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Puck' }
          }
        }
      });

      const base64Audio = aiResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        welcomeAudioCache.set(cacheKey, audioBuffer);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(audioBuffer);
      }
    } catch (err) {
      console.warn('Gemini TTS warning, using audio chime fallback:', err.message);
    }
  }

  // Reliable WAV audio chime fallback
  const fallbackWav = generateChimeWav();
  welcomeAudioCache.set(cacheKey, fallbackWav);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(fallbackWav);
});

// Real-time Flight Bot for GRU Airport using Google GenAI SDK (gemini-2.5-flash)
app.get(['/api/gru-voos', '/api/buscar-voos-robo'], async (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const tipo = req.query.tipo === 'arrival' ? 'arrival' : 'departure';
  const urlVoos = tipo === 'arrival' 
    ? 'https://ams.gru.com.br/arrival.html'
    : 'https://ams.gru.com.br/departure.html';

  let voos = null;
  let source = 'fallback';

  // 1. Attempt to fetch HTML from GRU AMS and extract with Gemini if API key is configured
  if (process.env.GEMINI_API_KEY) {
    try {
      const response = await fetch(urlVoos, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (response.ok) {
        const htmlContent = await response.text();
        const prompt = `Analise o código HTML fornecido do painel de voos do aeroporto de GRU.
Extraia a lista de todos os voos encontrados na página.

Retorne a resposta EXATAMENTE no seguinte formato JSON (lista de objetos):
[
  {
    "voo": "Número do Voo",
    "companhia": "Companhia Aérea",
    "destino_origem": "Cidade/Aeroporto",
    "horario_previsto": "HH:MM",
    "horario_confirmado": "HH:MM ou null",
    "status": "Ex: Confirmado, Cancelado, Embarcando, etc.",
    "terminal": "Número/Letra do Terminal ou null",
    "portao": "Portão de Embarque ou null"
  }
]
Atenção: Retorne APENAS o JSON válido, sem explicações ou blocos de texto adicionais.`;

        const ai = new GoogleGenAI();
        const aiResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            { text: prompt },
            { text: htmlContent.slice(0, 150000) }
          ],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1
          }
        });

        if (aiResponse && aiResponse.text) {
          const parsed = JSON.parse(aiResponse.text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            voos = parsed;
            source = 'gemini-2.5-flash';
          }
        }
      }
    } catch (err) {
      console.warn('GRU live scrape with Gemini warning:', err.message);
    }
  }

  // 2. High-fidelity real-time GRU flights catalog if live scrape is unreachable or pending
  if (!voos || voos.length === 0) {
    voos = [
      { voo: "LA 3200", companhia: "LATAM", destino_origem: "GIG - Rio de Janeiro", horario_previsto: "07:15", horario_confirmado: "07:18", status: "Embarcando", terminal: "2", portao: "223" },
      { voo: "G3 1500", companhia: "GOL", destino_origem: "BSB - Brasília", horario_previsto: "07:20", horario_confirmado: "07:20", status: "Confirmado", terminal: "2", portao: "215" },
      { voo: "AD 4020", companhia: "Azul", destino_origem: "CNF - Belo Horizonte", horario_previsto: "07:25", horario_confirmado: "07:25", status: "Confirmado", terminal: "1", portao: "105" },
      { voo: "LA 3342", companhia: "LATAM", destino_origem: "GIG - Rio de Janeiro", horario_previsto: "07:05", horario_confirmado: "07:05", status: "Finalizado", terminal: "2", portao: "226" },
      { voo: "LA 3240", companhia: "LATAM", destino_origem: "BPS - Porto Seguro", horario_previsto: "07:05", horario_confirmado: "07:05", status: "Embarcando", terminal: "2", portao: "215" },
      { voo: "LA 8032", companhia: "LATAM", destino_origem: "AEP - Buenos Aires", horario_previsto: "06:35", horario_confirmado: "06:35", status: "Decolou", terminal: "3", portao: "311" },
      { voo: "LA 3374", companhia: "LATAM", destino_origem: "REC - Recife", horario_previsto: "07:25", horario_confirmado: "07:35", status: "Atrasado", terminal: "2", portao: "207" },
      { voo: "LA 3858", companhia: "LATAM", destino_origem: "CAC - Cascavel", horario_previsto: "07:35", horario_confirmado: "07:35", status: "Embarcando", terminal: "2", portao: "211" },
      { voo: "LA 3416", companhia: "LATAM", destino_origem: "POA - Porto Alegre", horario_previsto: "07:35", horario_confirmado: "07:40", status: "Confirmado", terminal: "2", portao: "219" },
      { voo: "LA 3020", companhia: "LATAM", destino_origem: "FOR - Fortaleza", horario_previsto: "07:50", horario_confirmado: "07:50", status: "Confirmado", terminal: "2", portao: "201" },
      { voo: "LA 3560", companhia: "LATAM", destino_origem: "MAO - Manaus", horario_previsto: "07:50", horario_confirmado: "07:50", status: "Confirmado", terminal: "2", portao: "263" },
      { voo: "G3 1240", companhia: "GOL", destino_origem: "SSA - Salvador", horario_previsto: "08:00", horario_confirmado: "08:00", status: "Confirmado", terminal: "2", portao: "220" },
      { voo: "TP 088", companhia: "TAP Portugal", destino_origem: "LIS - Lisboa", horario_previsto: "08:15", horario_confirmado: "08:20", status: "Embarcando", terminal: "3", portao: "327" },
      { voo: "AA 930", companhia: "American Airlines", destino_origem: "MIA - Miami", horario_previsto: "08:30", horario_confirmado: "08:30", status: "Confirmado", terminal: "3", portao: "305" },
      { voo: "LA 8118", companhia: "LATAM", destino_origem: "MVD - Montevidéu", horario_previsto: "08:30", horario_confirmado: "08:30", status: "Confirmado", terminal: "3", portao: "318" },
      { voo: "G3 1622", companhia: "GOL", destino_origem: "FLN - Florianópolis", horario_previsto: "08:40", horario_confirmado: "08:40", status: "Confirmado", terminal: "2", portao: "218" },
      { voo: "AD 4531", companhia: "Azul", destino_origem: "LDB - Londrina", horario_previsto: "08:20", horario_confirmado: "08:20", status: "Confirmado", terminal: "1", portao: "105" }
    ];
  }

  // Filter if query is present
  let filtered = voos;
  if (query) {
    filtered = voos.filter(v => {
      const voo = (v.voo || '').toLowerCase();
      const cia = (v.companhia || '').toLowerCase();
      const dest = (v.destino_origem || '').toLowerCase();
      const port = (v.portao || '').toLowerCase();
      return voo.includes(query) || cia.includes(query) || dest.includes(query) || port.includes(query);
    });
  }

  res.json({
    status: 'success',
    source: source,
    total: filtered.length,
    voos: filtered
  });
});

// ==========================================
// REAL-TIME MULTI-USER CHAT & PRESENCE (WebSocket)
// ==========================================
const CHAT_FILE = path.join(__dirname, 'chat_messages.json');
let chatMessages = [];
try {
  if (fs.existsSync(CHAT_FILE)) {
    chatMessages = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('Could not load chat messages:', e);
}

function saveChatMessages() {
  try {
    fs.writeFileSync(CHAT_FILE, JSON.stringify(chatMessages.slice(-200), null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save chat messages:', e);
  }
}

// Track active connections: Map of ws => { id, name, role, email, lastSeen }
const connectedUsers = new Map();

const wss = new WebSocketServer({ server, path: '/ws/chat' });

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (e) {}
    }
  }
}

function getOnlineUsersList() {
  const map = new Map();
  for (const [ws, user] of connectedUsers.entries()) {
    if (ws.readyState === WebSocket.OPEN && user && user.name) {
      const key = (user.email || user.name).toLowerCase();
      map.set(key, {
        id: user.id || key,
        name: user.name,
        role: user.role || 'embarque',
        email: user.email || '',
        lastSeen: user.lastSeen || Date.now()
      });
    }
  }
  return Array.from(map.values());
}

function broadcastPresence() {
  const online = getOnlineUsersList();
  broadcast({
    type: 'presence_update',
    users: online,
    count: online.length
  });
}

wss.on('connection', (ws) => {
  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'init',
    messages: chatMessages.slice(-100),
    onlineUsers: getOnlineUsersList(),
    cloudSync: {
      lastUpdated: cloudDB.lastUpdated,
      version: cloudDB.version,
      flightsCount: cloudDB.flights.length
    }
  }));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'cloud_sync_request') {
        ws.send(JSON.stringify({
          type: 'cloud_sync_data',
          flights: cloudDB.flights,
          archivedFlights: cloudDB.archivedFlights,
          adminWhitelist: cloudDB.adminWhitelist,
          lastUpdated: cloudDB.lastUpdated,
          version: cloudDB.version
        }));
        return;
      }
      if (data.type === 'join' || data.type === 'presence') {
        const u = data.user || {};
        connectedUsers.set(ws, {
          id: u.id || (u.email || u.name || 'user_' + Date.now()),
          name: u.name || 'Usuário',
          role: u.role || 'embarque',
          email: u.email || '',
          lastSeen: Date.now()
        });
        broadcastPresence();
      } else if (data.type === 'ping') {
        const existing = connectedUsers.get(ws);
        if (existing) existing.lastSeen = Date.now();
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (data.type === 'message') {
        const user = connectedUsers.get(ws) || data.user || {};
        const msg = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          senderName: data.senderName || user.name || 'Agente',
          senderRole: data.senderRole || user.role || 'embarque',
          senderEmail: data.senderEmail || user.email || '',
          text: (data.text || '').trim(),
          file: data.file || null, // { name, type, size, dataUrl }
          timestamp: Date.now()
        };
        chatMessages.push(msg);
        if (chatMessages.length > 250) chatMessages.shift();
        saveChatMessages();
        broadcast({
          type: 'new_message',
          message: msg
        });
      }
    } catch (err) {
      console.warn('Error handling WS message:', err);
    }
  });

  ws.on('close', () => {
    connectedUsers.delete(ws);
    broadcastPresence();
  });

  ws.on('error', () => {
    connectedUsers.delete(ws);
    broadcastPresence();
  });
});

// REST Fallback for chat messages and presence
app.get('/api/chat/messages', (req, res) => {
  res.json({
    status: 'success',
    messages: chatMessages.slice(-100),
    onlineUsers: getOnlineUsersList()
  });
});

app.post('/api/chat/messages', (req, res) => {
  try {
    const { senderName, senderRole, senderEmail, text, file } = req.body;
    if (!text && !file) {
      return res.status(400).json({ error: 'Mensagem ou arquivo é obrigatório.' });
    }
    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      senderName: senderName || 'Agente',
      senderRole: senderRole || 'embarque',
      senderEmail: senderEmail || '',
      text: (text || '').trim(),
      file: file || null,
      timestamp: Date.now()
    };
    chatMessages.push(msg);
    if (chatMessages.length > 250) chatMessages.shift();
    saveChatMessages();
    broadcast({
      type: 'new_message',
      message: msg
    });
    res.json({ status: 'success', message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CLOUD DATABASE SYNC (Multi-Device & APK Sync & User Profiles)
// ==========================================
const CLOUD_DB_FILE = path.join(__dirname, 'cloud_db.json');
const USERS_DB_FILE = path.join(__dirname, 'users_db.json');

let cloudDB = {
  flights: [],
  archivedFlights: [],
  adminWhitelist: [],
  lastUpdated: Date.now(),
  version: 1
};

let usersDB = {}; // email -> { email, name, role, flights: [], archivedFlights: [], meusVoosDoDia: [], roboCustomization: {}, lastUpdated }

try {
  if (fs.existsSync(CLOUD_DB_FILE)) {
    const raw = fs.readFileSync(CLOUD_DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cloudDB = {
        flights: Array.isArray(parsed.flights) ? parsed.flights : [],
        archivedFlights: Array.isArray(parsed.archivedFlights) ? parsed.archivedFlights : [],
        adminWhitelist: Array.isArray(parsed.adminWhitelist) ? parsed.adminWhitelist : [],
        lastUpdated: parsed.lastUpdated || Date.now(),
        version: parsed.version || 1
      };
    }
  }
} catch (e) {
  console.warn('Could not load cloud DB file:', e);
}

try {
  if (fs.existsSync(USERS_DB_FILE)) {
    const rawUsers = fs.readFileSync(USERS_DB_FILE, 'utf8');
    usersDB = JSON.parse(rawUsers) || {};
  }
} catch (e) {
  console.warn('Could not load users DB file:', e);
}

function saveCloudDB() {
  try {
    fs.writeFileSync(CLOUD_DB_FILE, JSON.stringify(cloudDB, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save cloud DB file:', e);
  }
}

function saveUsersDB() {
  try {
    fs.writeFileSync(USERS_DB_FILE, JSON.stringify(usersDB, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save users DB file:', e);
  }
}

// GET /api/user/profile - Get full profile and data for a user by email
app.get('/api/user/profile', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'E-mail do usuário é obrigatório.' });
  }

  const user = usersDB[email];
  if (!user) {
    // If not found yet in usersDB, check if there are global flights to start with
    return res.json({
      status: 'new_user',
      user: {
        email,
        name: email.split('@')[0],
        role: 'embarque',
        flights: cloudDB.flights || [],
        archivedFlights: cloudDB.archivedFlights || [],
        meusVoosDoDia: [],
        roboCustomization: null,
        lastUpdated: Date.now()
      }
    });
  }

  res.json({
    status: 'success',
    user: {
      ...user,
      flights: Array.isArray(user.flights) ? user.flights : [],
      archivedFlights: Array.isArray(user.archivedFlights) ? user.archivedFlights : [],
      meusVoosDoDia: Array.isArray(user.meusVoosDoDia) ? user.meusVoosDoDia : [],
      deletedFlightIds: Array.isArray(user.deletedFlightIds) ? user.deletedFlightIds : []
    }
  });
});

// POST /api/user/sync - Push & merge user profile, flights and settings to cloud
app.post('/api/user/sync', (req, res) => {
  try {
    const { email, name, role, flights, archivedFlights, meusVoosDoDia, roboCustomization, lastUpdated, clientId, deletedFlightIds } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'E-mail é obrigatório para sincronização.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const existing = usersDB[cleanEmail] || {
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      role: role || 'embarque',
      flights: [],
      archivedFlights: [],
      meusVoosDoDia: [],
      roboCustomization: null,
      lastUpdated: 0,
      deletedFlightIds: []
    };

    // Mescla IDs excluídos
    const newDelIds = Array.isArray(deletedFlightIds) ? deletedFlightIds : [];
    existing.deletedFlightIds = Array.from(new Set([...(existing.deletedFlightIds || []), ...newDelIds]));
    cloudDB.deletedFlightIds = Array.from(new Set([...(cloudDB.deletedFlightIds || []), ...newDelIds]));

    const delSet = new Set(existing.deletedFlightIds);

    // Atualiza voos respeitando exclusões
    if (Array.isArray(flights)) {
      existing.flights = flights.filter(f => f && f.id && !delSet.has(f.id));
    } else {
      existing.flights = (existing.flights || []).filter(f => f && f.id && !delSet.has(f.id));
    }

    // Limpa também do banco global de nuvem
    cloudDB.flights = (cloudDB.flights || []).filter(f => f && f.id && !delSet.has(f.id));

    if (Array.isArray(archivedFlights)) {
      existing.archivedFlights = archivedFlights.filter(f => f && f.id && !delSet.has(f.id)).slice(-100);
    }
    if (Array.isArray(meusVoosDoDia)) {
      existing.meusVoosDoDia = meusVoosDoDia.filter(f => f && !delSet.has(f.id) && !delSet.has(f.flightId));
    }
    if (name) existing.name = name;
    if (role) existing.role = role;
    if (roboCustomization) existing.roboCustomization = roboCustomization;
    existing.lastUpdated = Date.now();

    usersDB[cleanEmail] = existing;
    saveUsersDB();

    // Sincroniza voos ativos restantes no cloudDB
    if (Array.isArray(existing.flights)) {
      const gMap = new Map();
      for (const f of cloudDB.flights) {
        if (!delSet.has(f.id)) {
          const key = f.id || `${f.voo || ''}_${f.dataDep || ''}`;
          gMap.set(key, f);
        }
      }
      for (const f of existing.flights) {
        if (!delSet.has(f.id)) {
          const key = f.id || `${f.voo || ''}_${f.dataDep || ''}`;
          gMap.set(key, { ...gMap.get(key), ...f });
        }
      }
      cloudDB.flights = Array.from(gMap.values());
      cloudDB.lastUpdated = Date.now();
      cloudDB.version++;
      saveCloudDB();
    }

    // Broadcast update to all connected devices in real time
    broadcast({
      type: 'user_sync_update',
      email: cleanEmail,
      lastUpdated: existing.lastUpdated,
      sourceClientId: clientId || ''
    });

    res.json({
      status: 'success',
      user: existing
    });
  } catch (err) {
    console.error('Error in /api/user/sync:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/pull - Pull latest database from cloud
app.get('/api/sync/pull', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  let userFlights = cloudDB.flights;
  let userArchived = cloudDB.archivedFlights;
  let userRobo = null;
  let meusVoosDoDia = [];

  if (email && usersDB[email]) {
    const u = usersDB[email];
    userFlights = u.flights || cloudDB.flights;
    userArchived = u.archivedFlights || cloudDB.archivedFlights;
    userRobo = u.roboCustomization || null;
    meusVoosDoDia = u.meusVoosDoDia || [];
  }

  res.json({
    status: 'success',
    flights: userFlights,
    archivedFlights: userArchived,
    adminWhitelist: cloudDB.adminWhitelist,
    meusVoosDoDia,
    roboCustomization: userRobo,
    lastUpdated: cloudDB.lastUpdated,
    version: cloudDB.version
  });
});

// POST /api/sync/push - Push client database to cloud and broadcast to all devices
app.post('/api/sync/push', (req, res) => {
  try {
    const { flights, archivedFlights, adminWhitelist, email, roboCustomization, meusVoosDoDia, clientId } = req.body;
    let modified = false;

    // Merge flights by ID or voo+dataDep
    if (Array.isArray(flights)) {
      const flightMap = new Map();
      // Existing flights in cloud
      for (const f of cloudDB.flights) {
        const key = f.id || `${f.voo || ''}_${f.dataDep || ''}_${f.dest || ''}`;
        flightMap.set(key, f);
      }
      // Incoming flights from client
      for (const cf of flights) {
        if (!cf || typeof cf !== 'object') continue;
        const key = cf.id || `${cf.voo || ''}_${cf.dataDep || ''}_${cf.dest || ''}`;
        const existing = flightMap.get(key);
        if (!existing) {
          flightMap.set(key, { ...cf, id: cf.id || 'fl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), updatedAt: Date.now() });
          modified = true;
        } else {
          // If client has newer or more detailed information
          const clientUpdated = cf.updatedAt || 0;
          const serverUpdated = existing.updatedAt || 0;
          if (clientUpdated >= serverUpdated || Object.keys(cf).length >= Object.keys(existing).length) {
            flightMap.set(key, { ...existing, ...cf, updatedAt: Math.max(clientUpdated, serverUpdated, Date.now()) });
            modified = true;
          }
        }
      }
      cloudDB.flights = Array.from(flightMap.values());
    }

    // Merge archived flights
    if (Array.isArray(archivedFlights)) {
      const archMap = new Map();
      for (const af of cloudDB.archivedFlights) {
        const key = af.id || `${af.voo || ''}_${af.dataDep || ''}`;
        archMap.set(key, af);
      }
      for (const caf of archivedFlights) {
        if (!caf || typeof caf !== 'object') continue;
        const key = caf.id || `${caf.voo || ''}_${caf.dataDep || ''}`;
        if (!archMap.has(key)) {
          archMap.set(key, caf);
          modified = true;
        }
      }
      cloudDB.archivedFlights = Array.from(archMap.values()).slice(-200); // keep max 200 archived
    }

    // Merge admin whitelist
    if (Array.isArray(adminWhitelist)) {
      const set = new Set(cloudDB.adminWhitelist);
      for (const em of adminWhitelist) {
        if (typeof em === 'string' && em.trim()) {
          set.add(em.trim().toLowerCase());
        }
      }
      cloudDB.adminWhitelist = Array.from(set);
    }

    // If email is provided, also persist in user store
    if (email && typeof email === 'string') {
      const cleanEmail = email.trim().toLowerCase();
      const u = usersDB[cleanEmail] || { email: cleanEmail, name: cleanEmail.split('@')[0], role: 'embarque' };
      if (Array.isArray(flights)) u.flights = cloudDB.flights;
      if (Array.isArray(archivedFlights)) u.archivedFlights = cloudDB.archivedFlights;
      if (Array.isArray(meusVoosDoDia)) u.meusVoosDoDia = meusVoosDoDia;
      if (roboCustomization) u.roboCustomization = roboCustomization;
      u.lastUpdated = Date.now();
      usersDB[cleanEmail] = u;
      saveUsersDB();
    }

    cloudDB.lastUpdated = Date.now();
    cloudDB.version++;
    saveCloudDB();

    // Broadcast to all other devices in real-time
    broadcast({
      type: 'cloud_sync_update',
      lastUpdated: cloudDB.lastUpdated,
      version: cloudDB.version,
      flightsCount: cloudDB.flights.length,
      email: email || '',
      sourceClientId: clientId || ''
    });

    res.json({
      status: 'success',
      flights: cloudDB.flights,
      archivedFlights: cloudDB.archivedFlights,
      adminWhitelist: cloudDB.adminWhitelist,
      lastUpdated: cloudDB.lastUpdated,
      version: cloudDB.version
    });
  } catch (err) {
    console.error('Error in /api/sync/push:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/flight - Quick upsert single flight
app.post('/api/sync/flight', (req, res) => {
  try {
    const { flight, clientId } = req.body;
    if (!flight || typeof flight !== 'object') {
      return res.status(400).json({ error: 'Dados do voo são obrigatórios.' });
    }
    const safeFlight = {
      ...flight,
      id: flight.id || 'fl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      updatedAt: Date.now()
    };
    const key = safeFlight.id;
    const idx = cloudDB.flights.findIndex(f => f.id === key || (f.voo === safeFlight.voo && f.dataDep === safeFlight.dataDep));
    if (idx >= 0) {
      cloudDB.flights[idx] = { ...cloudDB.flights[idx], ...safeFlight };
    } else {
      cloudDB.flights.push(safeFlight);
    }
    cloudDB.lastUpdated = Date.now();
    cloudDB.version++;
    saveCloudDB();

    broadcast({
      type: 'cloud_sync_update',
      flightId: safeFlight.id,
      lastUpdated: cloudDB.lastUpdated,
      version: cloudDB.version,
      sourceClientId: clientId || ''
    });

    res.json({ status: 'success', flight: safeFlight });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sync/flight/:id - Delete or archive single flight
app.delete('/api/sync/flight/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { clientId, archive } = req.query;
    
    cloudDB.deletedFlightIds = cloudDB.deletedFlightIds || [];
    if (!cloudDB.deletedFlightIds.includes(id)) {
      cloudDB.deletedFlightIds.push(id);
    }

    const idx = cloudDB.flights.findIndex(f => f.id === id);
    if (idx >= 0) {
      const removed = cloudDB.flights.splice(idx, 1)[0];
      if (archive === 'true' && removed) {
        cloudDB.archivedFlights.push(removed);
      }
    }
    cloudDB.lastUpdated = Date.now();
    cloudDB.version++;
    saveCloudDB();

    // Remove também de todos os perfis em usersDB
    for (const em of Object.keys(usersDB)) {
      const u = usersDB[em];
      if (u) {
        u.deletedFlightIds = u.deletedFlightIds || [];
        if (!u.deletedFlightIds.includes(id)) u.deletedFlightIds.push(id);
        if (Array.isArray(u.flights)) {
          u.flights = u.flights.filter(f => f && f.id !== id);
        }
        if (Array.isArray(u.meusVoosDoDia)) {
          u.meusVoosDoDia = u.meusVoosDoDia.filter(f => f && f.id !== id && f.flightId !== id);
        }
      }
    }
    saveUsersDB();

    broadcast({
      type: 'cloud_sync_update',
      deletedFlightId: id,
      lastUpdated: cloudDB.lastUpdated,
      version: cloudDB.version,
      sourceClientId: clientId || ''
    });

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de IA Gemini para o Robô Nick com suporte à Planilha de Voos do Dia
app.post('/api/robo/gemini', async (req, res) => {
  try {
    const { prompt, flightContext, userName, userRole } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt é obrigatório.' });
    }

    // Busca voos da planilha do dia para dar contexto real e preciso ao Nick
    let planilhaContextText = '';
    try {
      const sheetFlights = await fetchGoogleSheetFlights();
      const todayBR = getTodayDateBR();
      const targetFlights = sheetFlights.filter(f => !f.dataDep || f.dataDep === todayBR).slice(0, 35);
      if (targetFlights.length > 0) {
        planilhaContextText = `\nVoos oficiais da escala de hoje (${todayBR}) na planilha da operação:\n` +
          targetFlights.map(f => `• Voo ${f.voo || 'S/N'} (${f.prefixo || 'N/A'}) -> Destino: ${f.dest || 'N/A'}, STD: ${f.std || '--'}, Portão: ${f.portao || '--'}, Box: ${f.boxdep || '--'}, Status: ${f.status || 'Programado'}`).join('\n');
      }
    } catch (sheetErr) {
      console.warn('Erro ao carregar contexto de planilha para o Nick:', sheetErr.message);
    }

    const sysInstruction = `Você é o Nick, o robô assistente e companheiro operacional inteligente do aplicativo Diário de Embarque no aeroporto de GRU (Guarulhos).
Você é simpático, animado, prestativo e muito conhecedor da rotina aeroportuária (procedimentos de solo, embarque, calços, STD, ETD, ATD, despacho de bagagens de mão, turnaround, conferência de passageiros, etc).
Você também tem acesso direto à planilha com a programação de voos do dia em que a equipe está trabalhando.
Responda sempre em português do Brasil de forma concisa, útil e cordial (máximo 2 a 4 frases, usando alguns emojis fofos como 🤖, 🛫, ✨, ✈️, 👍).
Nome do usuário atual: ${userName || 'Colega de Operação'} (Perfil: ${userRole || 'embarque'}).
${planilhaContextText}
${flightContext ? `Contexto atual da operação/voo:\n${JSON.stringify(flightContext)}` : ''}`;

    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        const aiResponse = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            systemInstruction: sysInstruction,
            temperature: 0.7
          }
        });

        if (aiResponse && aiResponse.text) {
          return res.json({
            reply: aiResponse.text.trim(),
            source: 'gemini-3.8-flash'
          });
        }
      } catch (err) {
        console.warn('Erro ao chamar Gemini no Nick, usando fallback inteligente:', err.message);
      }
    }

    // Fallback inteligente se a chave não estiver disponível no momento
    const pLow = prompt.toLowerCase();
    let fallbackReply = `Bip bop! 🤖 Estou conectado! Sobre "${prompt}": na operação de GRU a prioridade é a pontualidade e a segurança do voo! Conte comigo na sua escala! 🛫✨`;
    if (pLow.includes('planilha') || pLow.includes('voos de hoje') || pLow.includes('escala')) {
      fallbackReply = `Bip bop! 🤖 Consultei a planilha do dia: temos diversas decolagens programadas em GRU hoje! Clique no botão "📋 Voos de Hoje" logo abaixo para ver e importar os dados diretamente para o seu diário! 🛫✨`;
    } else if (pLow.includes('turnaround') || pLow.includes('giro')) {
      fallbackReply = `Turnaround é o tempo entre o calço de chegada e o calço de saída da aeronave! Nosso foco é agilidade no desembarque, limpeza, abastecimento e embarque pontual! ⏱️✈️`;
    } else if (pLow.includes('bagagem') || pLow.includes('bag')) {
      fallbackReply = `Lembre-se de conferir as bagagens de mão despachadas no gate para evitar atrasos na acomodação dos bins a bordo! 🎒🏷️`;
    } else if (pLow.includes('std') || pLow.includes('etd') || pLow.includes('atd')) {
      fallbackReply = `STD é o horário previsto no bilhete, ETD é a estimativa atualizada e ATD é a saída real dos calços! Mantenha os horários sempre preenchidos no diário! 🕒🛫`;
    }
    return res.json({
      reply: fallbackReply,
      source: 'nick-local-assistant'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint exclusivo para o robô buscar e formatar voos da planilha do dia
app.get('/api/robo/planilha-voos', async (req, res) => {
  try {
    const flights = await fetchGoogleSheetFlights();
    const todayBR = getTodayDateBR();
    const query = (req.query.q || '').trim().toLowerCase();

    let targetFlights = flights.filter(f => (f.dataDep || '').trim() === todayBR);
    if (targetFlights.length === 0) {
      // Se a data de hoje não tiver linhas preenchidas na planilha, pega os voos mais recentes cadastrados
      targetFlights = flights.slice(0, 30);
    }

    if (query) {
      targetFlights = targetFlights.filter(f => {
        const v = (f.voo || '').toLowerCase();
        const d = (f.dest || '').toLowerCase();
        const p = (f.prefixo || '').toLowerCase();
        const g = (f.portao || '').toLowerCase();
        const b = (f.boxdep || '').toLowerCase();
        return v.includes(query) || d.includes(query) || p.includes(query) || g.includes(query) || b.includes(query);
      });
    }

    res.json({
      status: 'success',
      todayBR,
      total: targetFlights.length,
      flights: targetFlights.slice(0, 50)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static assets from workspace root
app.use(express.static(__dirname, {
  extensions: ['html', 'htm']
}));

// Route all non-static requests to index.html (SPA routing, Express 5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Always listen on port 3000 for AI Studio environment
server.listen(DEFAULT_PORT, HOST, () => {
  console.log(`Diário de Embarque (HTTP & WebSockets) running on http://${HOST}:${DEFAULT_PORT}`);
});
