import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8787;

const DATA_DIR = path.join(__dirname, 'data');
const carsFile = path.join(DATA_DIR, 'cars.json');

app.use(express.json({ limit: '1mb' }));

const STOPWORDS = new Set([
  'ein', 'eine', 'einen', 'einem', 'einer', 'der', 'die', 'das', 'den', 'dem', 'des',
  'und', 'oder', 'mit', 'ohne', 'fuer', 'für', 'von', 'im', 'in', 'am', 'an', 'auf',
  'auto', 'wagen', 'fahrzeug', 'suche', 'gesucht', 'bitte', 'gerne', 'soll', 'sollte',
  'unter', 'ueber', 'über', 'bis', 'max', 'maximal', 'budget', 'euro', 'eur', 'ca',
  'circa', 'etwa', 'moeglichst', 'möglichst', 'am', 'besten', 'wenn', 'fur'
]);

const FEATURE_RULES = [
  {
    name: 'Automatik',
    wish: ['automatik', 'automatic', 'automatisch', 'dsg', 'tiptronic', 'cvt'],
    positive: ['automatik', 'automatic', 'dsg', 'tiptronic', 'steptronic', 's tronic', 'stronic', 'cvt', '7g tronic', '8g tronic'],
    negative: ['schaltgetriebe', 'handschalter', 'manuell', 'manual'],
    weight: 34,
    reason: 'Automatik'
  },
  {
    name: 'Diesel',
    wish: ['diesel'],
    positive: ['diesel'],
    negative: ['benzin', 'petrol', 'hybrid', 'elektro', 'electric'],
    weight: 28,
    reason: 'Diesel'
  },
  {
    name: 'Hybrid',
    wish: ['hybrid', 'plug in', 'plug-in', 'phev', 'hev', 'mildhybrid', 'mild hybrid'],
    positive: ['hybrid', 'plug in hybrid', 'plug-in hybrid', 'phev', 'hev', 'mildhybrid', 'mild hybrid', 'vollhybrid'],
    negative: ['diesel', 'benzin', 'petrol'],
    weight: 28,
    reason: 'Hybrid-Antrieb'
  },
  {
    name: 'Familie',
    wish: ['familie', 'familienauto', 'familienwagen', 'kinder', 'kind', 'platz', 'geraeumig', 'geräumig'],
    positive: ['familienauto', 'familienwagen', 'kombi', 'variant', 'combi', 'touring', 'estate', 'wagon', 'suv', 'van', 'minivan', 'tourer', 'grandtourer', '7 sitzer'],
    weight: 18,
    reason: 'familienfreundlich'
  },
  {
    name: 'Kleinwagen',
    wish: ['kleinwagen', 'kompakt', 'stadtauto', 'city', 'klein', 'handlich'],
    positive: ['kleinwagen', 'compact', 'kompakt', 'city', 'mini', 'hatchback', 'small'],
    negative: ['van', 'minivan', 'bus'],
    weight: 18,
    reason: 'kompakt / Kleinwagen'
  }
];

let carsCache = null;

async function loadCars() {
  if (carsCache) return carsCache;
  const data = await fs.readFile(carsFile, 'utf8');
  const parsed = JSON.parse(data);
  carsCache = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cars)
      ? parsed.cars
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];
  return carsCache;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return null;

  const str = String(value).trim();
  if (!str) return null;

  const hasK = /\bk\b|tausend/i.test(str);
  const digitsOnly = str.replace(/[^\d]/g, '');
  if (!digitsOnly) return null;

  let num = Number(digitsOnly);
  if (!Number.isFinite(num)) return null;
  if (hasK && num < 1000) num *= 1000;
  return num;
}

function formatNumber(value) {
  const num = parseNumber(value);
  return num == null ? 'k. A.' : new Intl.NumberFormat('de-DE').format(num);
}

function getCarSearchBlob(car) {
  const parts = [
    car?.title, car?.make, car?.brand, car?.manufacturer, car?.model, car?.variant,
    car?.trim, car?.series, car?.body_type, car?.bodyType, car?.category, car?.vehicle_type,
    car?.fuel, car?.fuel_type, car?.fuelType, car?.engine_type, car?.transmission,
    car?.gearbox, car?.drive, car?.drivetrain, car?.description, car?.subtitle,
    car?.name, car?.equipment, car?.features, car?.highlights, car?.seats, car?.doors
  ];
  return normalizeText(parts.filter(Boolean).join(' '));
}

function hasAny(text, patterns = []) {
  return patterns.some(pattern => text.includes(normalizeText(pattern)));
}

function tokenizeWish(wish) {
  return normalizeText(wish)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3)
    .filter(token => !STOPWORDS.has(token))
    .filter(token => !/^\d+$/.test(token));
}

function parseMoneyCandidate(raw) {
  if (!raw) return null;
  let text = String(raw).trim().toLowerCase();
  const hasK = /k|tausend/.test(text);
  text = text.replace(/[^\d,\.]/g, '');
  if (!text) return null;

  if (text.includes(',') && text.includes('.')) {
    text = text.replace(/[\.,]/g, '');
  } else if (text.includes(',')) {
    const [left, right] = text.split(',');
    text = right && right.length <= 2 ? `${left}.${right}` : `${left}${right}`;
  } else if (text.includes('.')) {
    const parts = text.split('.');
    text = parts[parts.length - 1].length <= 2 ? text : parts.join('');
  }

  let num = Number(text);
  if (!Number.isFinite(num)) return null;
  if (hasK && num < 1000) num *= 1000;
  return Math.round(num);
}

function extractBudget(wish) {
  const source = normalizeText(wish).replace(/euro|eur/g, ' ').replace(/\s+/g, ' ').trim();
  let min = null;
  let max = null;

  const rangeMatch = source.match(/(\d[\d.,]*\s*(?:k|tausend)?)\s*(?:-|bis|to)\s*(\d[\d.,]*\s*(?:k|tausend)?)/i);
  if (rangeMatch) {
    min = parseMoneyCandidate(rangeMatch[1]);
    max = parseMoneyCandidate(rangeMatch[2]);
  }

  for (const pattern of [
    /(?:unter|bis|max(?:imal)?|hoechstens|höchstens|nicht mehr als)\s*(\d[\d.,]*\s*(?:k|tausend)?)/i,
    /(\d[\d.,]*\s*(?:k|tausend)?)\s*(?:oder weniger|max)/i
  ]) {
    const match = source.match(pattern);
    if (match) {
      max = parseMoneyCandidate(match[1]);
      break;
    }
  }

  for (const pattern of [
    /(?:ab|mindestens|min)\s*(\d[\d.,]*\s*(?:k|tausend)?)/i,
    /(\d[\d.,]*\s*(?:k|tausend)?)\s*(?:oder mehr|min)/i
  ]) {
    const match = source.match(pattern);
    if (match) {
      min = parseMoneyCandidate(match[1]);
      break;
    }
  }

  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max };
}

function getPriceScore(price, budget) {
  const numericPrice = parseNumber(price);
  if (numericPrice == null || (!budget.min && !budget.max)) {
    return { score: 0, reason: null, distance: Number.POSITIVE_INFINITY };
  }

  let score = 0;
  let reason = null;
  let distance = 0;

  if (budget.min != null && numericPrice < budget.min) {
    distance += budget.min - numericPrice;
    const gap = (budget.min - numericPrice) / Math.max(budget.min, 1);
    score -= gap > 0.2 ? 12 : 6;
    reason = `etwas unter Budget (${formatNumber(numericPrice)} €)`;
  }

  if (budget.max != null && numericPrice > budget.max) {
    distance += numericPrice - budget.max;
    const gap = (numericPrice - budget.max) / Math.max(budget.max, 1);
    score -= gap > 0.15 ? 25 : gap > 0.08 ? 12 : 5;
    reason = `leicht über Budget (${formatNumber(numericPrice)} €)`;
  }

  if ((budget.min == null || numericPrice >= budget.min) && (budget.max == null || numericPrice <= budget.max)) {
    score += 24;
    reason = `Preis passt ins Budget (${formatNumber(numericPrice)} €)`;
    distance = 0;
  }

  return { score, reason, distance };
}

function getFeatureScore(car, wishText, carText, rule) {
  const wishMatched = hasAny(wishText, rule.wish);
  if (!wishMatched) return { score: 0, reason: null };

  let score = 0;
  let reason = null;

  if (hasAny(carText, rule.positive)) {
    score += rule.weight;
    reason = rule.reason;
  } else if (rule.negative && hasAny(carText, rule.negative)) {
    score -= Math.round(rule.weight * 0.65);
  } else {
    score += Math.round(rule.weight * 0.15);
  }

  if (rule.name === 'Familie') {
    const seats = parseNumber(car?.seats || car?.seat_count || car?.seating_capacity);
    if (seats != null && seats >= 5) {
      score += 10;
      reason = seats >= 7 ? 'viel Platz für Familie (7+ Sitze)' : 'familienfreundlich (mind. 5 Sitze)';
    }
  }

  if (rule.name === 'Kleinwagen') {
    const seats = parseNumber(car?.seats || car?.seat_count || car?.seating_capacity);
    if (seats != null && seats <= 5) score += 4;
  }

  return { score, reason };
}

function getTokenScore(tokens, blob) {
  let score = 0;
  const matched = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (blob.includes(token)) {
      score += token.length >= 6 ? 8 : 5;
      matched.push(token);
    }
  }
  return { score, matched };
}

function buildReason(reasons, fallbackText) {
  const uniqueReasons = [...new Set(reasons.filter(Boolean))].slice(0, 4);
  if (!uniqueReasons.length) return fallbackText;
  return `Passt wegen: ${uniqueReasons.join(', ')}`;
}

function parseWish(wish) {
  const budget = extractBudget(wish);
  const rawTokens = tokenizeWish(wish);
  const wishText = normalizeText(wish);

  const keywordTokens = new Set();
  for (const rule of FEATURE_RULES) {
    if (hasAny(wishText, rule.wish)) {
      for (const token of rule.wish) {
        for (const part of normalizeText(token).split(/\s+/)) {
          if (part) keywordTokens.add(part);
        }
      }
    }
  }

  const tokens = rawTokens.filter(token => !keywordTokens.has(token));
  return { budget, tokens, wishText };
}

function scoreCar(car, parsedWish) {
  const blob = getCarSearchBlob(car);
  const reasons = [];
  let score = 0;

  const priceScore = getPriceScore(car?.price, parsedWish.budget);
  score += priceScore.score;
  if (priceScore.reason) reasons.push(priceScore.reason);

  for (const rule of FEATURE_RULES) {
    const featureScore = getFeatureScore(car, parsedWish.wishText, blob, rule);
    score += featureScore.score;
    if (featureScore.reason) reasons.push(featureScore.reason);
  }

  const tokenScore = getTokenScore(parsedWish.tokens, blob);
  score += tokenScore.score;
  if (tokenScore.matched.length) {
    reasons.push(`treffende Begriffe: ${tokenScore.matched.slice(0, 3).join(', ')}`);
  }

  const year = parseNumber(car?.year || car?.first_registration_year || car?.registration_year);
  const mileage = parseNumber(car?.mileage || car?.km || car?.kilometers);

  if (year != null) {
    if (year >= 2022) score += 5;
    else if (year >= 2019) score += 3;
  }

  if (mileage != null) {
    if (mileage <= 30000) score += 5;
    else if (mileage <= 80000) score += 2;
  }

  const sortDistance = Number.isFinite(priceScore.distance) ? priceScore.distance : Number.POSITIVE_INFINITY;

  return {
    car,
    score,
    reasons,
    sortDistance,
    year: year ?? 0,
    mileage: mileage ?? Number.POSITIVE_INFINITY,
    price: parseNumber(car?.price) ?? Number.POSITIVE_INFINITY
  };
}

function getTopMatches(cars, wish, maxResults) {
  const parsedWish = parseWish(wish);
  const desiredCount = Math.min(Math.max(Number(maxResults) || 3, 3), 5);

  const ranked = cars
    .map(car => scoreCar(car, parsedWish))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.sortDistance !== b.sortDistance) return a.sortDistance - b.sortDistance;
      if (a.price !== b.price) return a.price - b.price;
      if (b.year !== a.year) return b.year - a.year;
      return a.mileage - b.mileage;
    });

  return ranked.slice(0, Math.min(desiredCount, ranked.length)).map(({ car, reasons, score }) => ({
    id: String(car.id || car.master_id || ''),
    title: car.title || [car.make, car.model].filter(Boolean).join(' ') || 'Unbekanntes Fahrzeug',
    price: car.price,
    year: car.year,
    mileage: car.mileage,
    reason: buildReason(reasons, `Solider Match für: ${wish}`),
    match_score: score
  }));
}

function buildServer() {
  const server = new McpServer({
    name: 'rolf-vehicle-advisor',
    version: '1.0.0'
  });

  server.registerTool(
    'match_vehicles',
    {
      title: 'Fahrzeuge finden',
      description: 'Findet die besten passenden Fahrzeuge aus dem aktuellen Bestand.',
      inputSchema: {
        wish: z.string().describe('Beschreibung des gesuchten Autos'),
        max_results: z.number().int().min(1).max(5).optional().describe('Maximale Anzahl Ergebnisse')
      }
    },
    async ({ wish, max_results = 3 }) => {
      const cars = await loadCars();
      const matches = getTopMatches(cars, wish, max_results);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(matches.length ? matches : 'Keine passenden Fahrzeuge gefunden.', null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    'get_vehicle_details',
    {
      title: 'Fahrzeugdetails holen',
      description: 'Holt die vollständigen Details eines einzelnen Fahrzeugs anhand seiner ID.',
      inputSchema: {
        vehicle_id: z.string().describe('Die Fahrzeug-ID')
      }
    },
    async ({ vehicle_id }) => {
      const cars = await loadCars();
      const car = cars.find(c => String(c.id || c.master_id) === String(vehicle_id));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(car || 'Fahrzeug nicht gefunden.', null, 2)
          }
        ]
      };
    }
  );

  return server;
}

app.get('/.well-known/openai-apps-challenge', (req, res) => {
  res.type('text/plain').send('25pEUXM9DOCUb3xn91aNavnpCZS00L6__l10cGQM9oU');
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, () => {
  console.log(`Rolf MCP Server läuft auf Port ${port}`);
});
