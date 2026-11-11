// Lisboa Para Todos — backend
// One endpoint, POST /api/plan: profile (LLM) -> weather (Open-Meteo) ->
// stop selection (LLM, only from our data) -> route + slopes (OpenRouteService) -> stories (LLM)

import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';

const PORT = process.env.PORT || 3000;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const ORS_BASE = process.env.ORS_BASE || 'https://api.heigit.org/openrouteservice';

const STOPS = JSON.parse(await readFile(new URL('./data/stops.json', import.meta.url), 'utf8'));
const LIFTS = JSON.parse(await readFile(new URL('./data/lifts.json', import.meta.url), 'utf8'));
const STARTS = JSON.parse(await readFile(new URL('./data/starts.json', import.meta.url), 'utf8'));

// Limits per archetype (our defaults; see the functional spec)
const ARCHETYPES = {
  wheelchair:        { label: 'wheelchair user',             max_slope: 6,  avoid_steps: true,  avoid_cobbles: true,  max_km: 3,   rest_every_m: 800 },
  older_visitor:     { label: 'older visitor',               max_slope: 8,  avoid_steps: true,  avoid_cobbles: false, max_km: 1.5, rest_every_m: 400 },
  family_stroller:   { label: 'family with a stroller',      max_slope: 8,  avoid_steps: true,  avoid_cobbles: false, max_km: 2,   rest_every_m: 600 },
  visually_impaired: { label: 'visually impaired traveller', max_slope: 10, avoid_steps: false, avoid_cobbles: false, max_km: 3,   rest_every_m: 800 },
  none:              { label: 'traveller',                   max_slope: 12, avoid_steps: false, avoid_cobbles: false, max_km: 4,   rest_every_m: 1000 }
};

const LANGS = { en: 'English', pt: 'Portuguese (European)', it: 'Italian', es: 'Spanish' };

// ---------- helpers ----------

function haversine(a, b) {
  // a, b = [lon, lat]
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function askJSON(system, user, maxTokens = 1200) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.3,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      if (attempt === 0 && r.status >= 500) continue;
      throw new Error(`LLM error ${r.status}: ${body}`);
    }
    const j = await r.json();
    try {
      return JSON.parse(j.choices[0].message.content);
    } catch {
      if (attempt === 1) throw new Error('LLM returned invalid JSON');
    }
  }
}

// ---------- 1. profile ----------

const PROFILE_PROMPT = `You are an accessibility planner for walking tours in Lisbon.
Classify each traveller described by the user into exactly one archetype from:
wheelchair, older_visitor, family_stroller, visually_impaired, none (no mobility or sight limitation).
A person using a walker, crutches or a cane, or who tires easily, is older_visitor unless they use a wheelchair.
A baby or toddler in a pushchair means family_stroller.
If the description is unclear, choose the safer (more limited) archetype and say so in the summary.
Return only JSON: {"archetypes": ["..."], "narration_style": "short phrase", "summary": "one plain sentence starting with 'Planning for'"}`;

async function buildProfile(who) {
  const ai = await askJSON(PROFILE_PROMPT, `Travellers: ${who}`, 300);
  let types = (ai.archetypes || []).filter(t => ARCHETYPES[t]);
  if (!types.length) types = ['older_visitor'];
  const limited = types.filter(t => t !== 'none');
  const use = limited.length ? limited : ['none'];
  const pick = key => use.map(t => ARCHETYPES[t][key]);
  return {
    archetypes: types,
    max_slope: Math.min(...pick('max_slope')),
    avoid_steps: pick('avoid_steps').some(Boolean),
    avoid_cobbles: pick('avoid_cobbles').some(Boolean),
    max_km: Math.min(...pick('max_km')),
    rest_every_m: Math.min(...pick('rest_every_m')),
    narration_style: ai.narration_style || 'warm and practical',
    summary: ai.summary || `Planning for a ${ARCHETYPES[use[0]].label}`
  };
}

// ---------- 2. weather ----------

async function getWeather(durationMin) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=38.71&longitude=-9.14' +
    '&hourly=wind_gusts_10m,precipitation_probability,precipitation,apparent_temperature' +
    '&forecast_days=2&timezone=GMT';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Weather error ${r.status}`);
  const j = await r.json();
  const nowHour = new Date().toISOString().slice(0, 13); // e.g. 2026-11-11T13
  const start = Math.max(0, j.hourly.time.findIndex(t => t.slice(0, 13) === nowHour));
  const end = start + Math.max(1, Math.ceil(durationMin / 60)) + 1;
  const slice = key => j.hourly[key].slice(start, end).filter(v => v !== null);

  const gust = Math.max(...slice('wind_gusts_10m'));
  const rainProb = Math.max(...slice('precipitation_probability'));
  const rain = Math.max(...slice('precipitation'));
  const tMax = Math.max(...slice('apparent_temperature'));
  const tMin = Math.min(...slice('apparent_temperature'));

  const flags = [];
  if (gust > 70) flags.push('storm');
  else if (gust > 50) flags.push('wind');
  if (rainProb > 50 || rain > 0.2) flags.push('rain');
  if (tMax > 30) flags.push('heat');
  if (tMin < 8) flags.push('cold');

  const parts = [];
  if (flags.includes('storm')) parts.push(`Storm-force gusts up to ${Math.round(gust)} km/h: indoor stops only, and consider a shorter walk`);
  else if (flags.includes('wind')) parts.push(`Gusts up to ${Math.round(gust)} km/h: we skipped exposed viewpoints`);
  if (flags.includes('rain')) parts.push('Rain likely: wet stone is slippery, so we kept slopes gentler and added covered stops');
  if (flags.includes('heat')) parts.push(`Feels like ${Math.round(tMax)} °C: shade and water stops added`);
  if (flags.includes('cold')) parts.push(`Feels like ${Math.round(tMin)} °C: a warm café stop added`);
  const summary = parts.length ? parts.join('. ') + '.' :
    `Good walking weather: gusts up to ${Math.round(gust)} km/h, ${Math.round(tMin)}–${Math.round(tMax)} °C.`;

  return { summary, flags, gust_kmh: Math.round(gust), rain_prob: rainProb, feels_like: [Math.round(tMin), Math.round(tMax)] };
}

// ---------- 3. stop selection ----------

const STOPS_PROMPT = `You plan an accessible walking tour in Lisbon.
You may choose ONLY from the candidate stops and lifts listed, by id. Never invent places.
Respect the traveller's limits and the weather flags. Prefer stops whose step_free value is "yes".
Pick 3 to 5 stops that match the interests and fit the time available (walking plus visit_minutes),
in a sensible walking order starting from the start point (use distance_from_start_m).
Add a lift id when the route goes up to the castle area, to avoid a steep climb.
Return only JSON: {"stops": [{"id": "...", "why": "one short sentence"}], "lifts": ["..."], "warnings": ["..."]}`;

async function selectStops(profile, weather, interests, durationMin, start) {
  let candidates = STOPS.filter(s => !(weather.flags.includes('storm') && !s.indoor));
  if (weather.flags.includes('wind') || weather.flags.includes('storm')) candidates = candidates.filter(s => !s.exposed);
  if (profile.avoid_steps) candidates = candidates.filter(s => s.step_free !== 'no');

  const startPt = [start.lon, start.lat];
  const list = candidates.map(s => ({
    id: s.id, name: s.name, area: s.area, themes: s.themes, step_free: s.step_free,
    indoor: s.indoor, visit_minutes: s.visit_minutes,
    distance_from_start_m: Math.round(haversine(startPt, [s.lon, s.lat]))
  }));
  const lifts = LIFTS.map(l => ({ id: l.id, name: l.name, free: l.free }));

  const user = JSON.stringify({
    limits: { max_slope_pct: profile.max_slope, avoid_steps: profile.avoid_steps, max_walk_km: profile.max_km },
    weather_flags: weather.flags, interests, minutes_available: durationMin,
    start: start.label, candidate_stops: list, lifts
  });

  const ai = await askJSON(STOPS_PROMPT, user, 600);
  const byId = Object.fromEntries(candidates.map(s => [s.id, s]));
  let chosen = (ai.stops || []).filter(s => byId[s.id]).slice(0, 5)
    .map(s => ({ ...byId[s.id], why: s.why || '' }));
  // dedupe
  chosen = chosen.filter((s, i) => chosen.findIndex(x => x.id === s.id) === i);
  if (!chosen.length) {
    chosen = list.sort((a, b) => a.distance_from_start_m - b.distance_from_start_m).slice(0, 3)
      .map(s => ({ ...byId[s.id], why: 'Close to your start point.' }));
  }
  const liftIds = (ai.lifts || []).filter(id => LIFTS.some(l => l.id === id));
  return { stops: chosen, liftIds, warnings: (ai.warnings || []).slice(0, 3) };
}

// Insert each chosen lift where it adds the least walking
function insertLifts(points, liftIds) {
  const seq = [...points];
  // chained lifts (links_to) go in chain order, the second right after the first
  const ordered = [...new Set(liftIds)].sort((a, b) =>
    LIFTS.find(l => l.id === a).links_to === b ? -1 : LIFTS.find(l => l.id === b).links_to === a ? 1 : 0);
  for (const id of ordered) {
    const lift = LIFTS.find(l => l.id === id);
    const bottom = [lift.bottom_lon, lift.bottom_lat], top = [lift.top_lon, lift.top_lat];
    const prevLift = LIFTS.find(l => l.links_to === id);
    const prevIdx = prevLift ? seq.findIndex(p => p.id === prevLift.id) : -1;
    if (prevIdx >= 0) {
      seq.splice(prevIdx + 1, 0, { type: 'lift', id: lift.id, name: lift.name, from: bottom, to: top });
      continue;
    }
    let best = -1, bestCost = Infinity;
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1].to || seq[i - 1].at, next = seq[i].from || seq[i].at;
      const cost = haversine(prev, bottom) + haversine(top, next) - haversine(prev, next);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    if (best > 0) seq.splice(best, 0, { type: 'lift', id: lift.id, name: lift.name, from: bottom, to: top });
  }
  return seq;
}

// ---------- 4. route + slopes ----------

function allowedIncline(maxSlope) {
  const steps = [3, 6, 10, 15];
  return steps.filter(s => s <= maxSlope).pop() || 3;
}

async function orsLeg(a, b, profile, mode) {
  const body = { coordinates: [a, b], elevation: true, instructions: false };
  if (mode === 'wheelchair') {
    body.options = { profile_params: { restrictions: { maximum_incline: allowedIncline(profile.max_slope) } } };
    if (profile.avoid_steps) body.options.avoid_features = ['steps'];
  } else if (profile.avoid_steps) {
    body.options = { avoid_features: ['steps'] };
  }
  const profileName = mode === 'wheelchair' ? 'wheelchair' : 'foot-walking';
  const r = await fetch(`${ORS_BASE}/v2/directions/${profileName}/geojson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.ORS_API_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Route error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.features[0].geometry.coordinates; // [lon, lat, ele]
}

async function routeLeg(a, b, profile) {
  try {
    return { coords: await orsLeg(a, b, profile, 'wheelchair'), mode: 'wheelchair' };
  } catch (e) {
    console.warn('wheelchair leg failed, retrying on foot:', e.message);
    return { coords: await orsLeg(a, b, profile, 'foot'), mode: 'foot' };
  }
}

// Split a route into ~20 m chunks and colour each by slope.
// Short leftover chunks are merged into the previous one so elevation noise
// over a few metres does not show up as a fake 40% spike.
function slopeSegments(coords, limit) {
  const red = Math.min(8, limit);
  const chunks = [];
  let chunk = [coords[0]], dist = 0;
  for (let i = 1; i < coords.length; i++) {
    dist += haversine(coords[i - 1], coords[i]);
    chunk.push(coords[i]);
    if (dist >= 20 || i === coords.length - 1) {
      if (dist < 10 && chunks.length) {
        const prev = chunks[chunks.length - 1];
        prev.pts.push(...chunk.slice(1));
        prev.dist += dist;
      } else {
        chunks.push({ pts: chunk, dist });
      }
      chunk = [coords[i]];
      dist = 0;
    }
  }
  return chunks.map(({ pts, dist }) => {
    const rise = (pts[pts.length - 1][2] ?? 0) - (pts[0][2] ?? 0);
    const slope = dist >= 5 ? Math.abs(rise / dist) * 100 : 0;
    const color = slope < 5 ? 'green' : slope <= red ? 'amber' : 'red';
    return { coords: pts.map(c => [c[1], c[0]]), slope_pct: Math.round(slope * 10) / 10, color, length_m: Math.round(dist) };
  });
}

async function buildRoute(start, stops, liftIds, profile) {
  const points = [{ type: 'start', at: [start.lon, start.lat] },
    ...stops.map(s => ({ type: 'stop', id: s.id, at: [s.lon, s.lat] }))];
  const seq = insertLifts(points, liftIds);

  const segments = [], lifts = [];
  let distance = 0, usedFallback = false;
  let cursor = seq[0].at;
  for (let i = 1; i < seq.length; i++) {
    const p = seq[i];
    const target = p.type === 'lift' ? p.from : p.at;
    if (haversine(cursor, target) > 15) {
      const leg = await routeLeg(cursor, target, profile);
      if (leg.mode !== 'wheelchair') usedFallback = true;
      const segs = slopeSegments(leg.coords, profile.max_slope);
      segments.push(...segs);
      distance += segs.reduce((n, s) => n + s.length_m, 0);
    }
    if (p.type === 'lift') {
      lifts.push({ id: p.id, name: p.name, coords: [[p.from[1], p.from[0]], [p.to[1], p.to[0]]] });
      cursor = p.to;
    } else {
      cursor = p.at;
    }
  }
  const steepest = segments.reduce((m, s) => (s.slope_pct > (m?.slope_pct ?? -1) ? s : m), null);
  return {
    segments, lifts,
    distance_m: Math.round(distance),
    max_slope_pct: steepest ? steepest.slope_pct : 0,
    steepest_at: steepest ? steepest.coords[0] : null,
    used_fallback: usedFallback
  };
}

// ---------- 5. stories ----------

const STORY_PROMPT = `You are a warm local guide in Lisbon.
For each stop, write a story that takes 60 to 90 seconds to read aloud, in the language and narration style given.
Use only well-known history and facts; if you are unsure of a fact, leave it out.
Then give one practical accessibility tip based only on the stop's note; if the note is empty, suggest checking the entrance on arrival.
Return only JSON: {"stories": [{"id": "...", "story": "...", "tip": "..."}]}`;

async function writeStories(stops, profile, lang) {
  const user = JSON.stringify({
    language: LANGS[lang] || 'English',
    narration_style: profile.narration_style,
    stops: stops.map(s => ({ id: s.id, name: s.name, themes: s.themes, note: s.note || '' }))
  });
  try {
    const ai = await askJSON(STORY_PROMPT, user, 2500);
    const byId = Object.fromEntries((ai.stories || []).map(s => [s.id, s]));
    return stops.map(s => ({ id: s.id, story: byId[s.id]?.story || '', tip: byId[s.id]?.tip || s.note || '' }));
  } catch (e) {
    console.warn('stories failed:', e.message);
    return stops.map(s => ({ id: s.id, story: '', tip: s.note || '' }));
  }
}

// ---------- API ----------

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.get('/api/health', (req, res) => res.json({ ok: true, model: GROQ_MODEL }));
app.get('/api/starts', (req, res) => res.json(STARTS));

app.post('/api/plan', async (req, res) => {
  const t0 = Date.now();
  try {
    const who = String(req.body.who || '').slice(0, 500).trim();
    const interests = (Array.isArray(req.body.interests) ? req.body.interests : []).slice(0, 8).map(String);
    const durationMin = Math.min(300, Math.max(30, Number(req.body.duration_min) || 120));
    const lang = LANGS[req.body.lang] ? req.body.lang : 'en';
    const s = req.body.start || {};
    const start = Number.isFinite(s.lat) && Number.isFinite(s.lon)
      ? { lat: s.lat, lon: s.lon, label: String(s.label || 'your location').slice(0, 60) }
      : STARTS[0];
    if (!who) return res.status(400).json({ error: 'Tell us who is walking today.' });

    const [profile, weather] = await Promise.all([
      buildProfile(who),
      getWeather(durationMin).catch(e => {
        console.warn('weather failed:', e.message);
        return { summary: 'Weather forecast unavailable right now.', flags: [] };
      })
    ]);
    if (weather.flags.includes('rain')) {
      profile.max_slope = Math.max(3, profile.max_slope - 2);
      profile.avoid_cobbles = true;
    }

    const sel = await selectStops(profile, weather, interests, durationMin, start);
    const [route, stories] = await Promise.all([
      buildRoute(start, sel.stops, sel.liftIds, profile),
      writeStories(sel.stops, profile, lang)
    ]);

    const warnings = [...sel.warnings];
    if (route.max_slope_pct > profile.max_slope) {
      warnings.push(`One section reaches about ${route.max_slope_pct}%, above your ${profile.max_slope}% limit. It is marked in red: take it slowly or ask for help.`);
    }
    if (route.used_fallback) warnings.push('Part of the route uses walking paths without full wheelchair data. Check the red sections.');

    res.json({
      profile, weather, start,
      stops: sel.stops.map(s => {
        const st = stories.find(x => x.id === s.id) || {};
        return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, why: s.why, indoor: s.indoor, story: st.story, tip: st.tip };
      }),
      route, warnings,
      ms: Date.now() - t0
    });
  } catch (e) {
    console.error('plan failed:', e);
    res.status(502).json({ error: 'We could not plan the walk right now. Please try again in a minute.' });
  }
});

app.listen(PORT, '127.0.0.1', () => console.log(`Lisboa Para Todos on http://127.0.0.1:${PORT}`));
