// Lisboa Para Todos — frontend
const $ = id => document.getElementById(id);
const VOICE_LANG = { en: 'en-GB', pt: 'pt-PT', it: 'it-IT', es: 'es-ES' };
const COLORS = { green: '#1E7B3A', amber: '#A65F00', red: '#B3261E', lift: '#1F4E8C' };

let starts = [];
let myLocation = null;
let map = null;
let lastLang = 'en';

// ---------- start points ----------
fetch('/api/starts').then(r => r.json()).then(list => {
  starts = list;
  $('start').innerHTML = '';
  list.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = s.label;
    $('start').appendChild(o);
  });
});

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Your browser cannot share its location.', true);
  setStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(pos => {
    myLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'your location' };
    let o = $('start').querySelector('option[value="me"]');
    if (!o) {
      o = document.createElement('option');
      o.value = 'me';
      o.textContent = 'My location';
      $('start').prepend(o);
    }
    $('start').value = 'me';
    setStatus('Location set.');
  }, () => setStatus('We could not get your location. Pick a start point instead.', true), { timeout: 10000 });
});

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

// ---------- submit ----------
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const who = $('who').value.trim();
  if (!who) { setStatus('Tell us who is walking today.', true); $('who').focus(); return; }

  const interests = [...document.querySelectorAll('input[name=interest]:checked')].map(i => i.value);
  const duration = Number(document.querySelector('input[name=duration]:checked').value);
  const startSel = $('start').value;
  const start = startSel === 'me' && myLocation ? myLocation : starts[Number(startSel)] || starts[0];
  lastLang = $('lang').value;

  $('go').disabled = true;
  setStatus('Planning your walk: reading your needs, checking the weather, finding gentle streets…');
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ who, interests, duration_min: duration, start, lang: lastLang })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Something went wrong.');
    setStatus('');
    render(data);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('go').disabled = false;
  }
});

$('edit').addEventListener('click', () => {
  speechSynthesis.cancel();
  $('result').hidden = true;
  $('form').hidden = false;
  $('who').focus();
});

// ---------- render ----------
function render(d) {
  $('form').hidden = true;
  $('result').hidden = false;

  const p = d.profile;
  $('profileSummary').textContent = p.summary;
  $('profileLimits').textContent =
    `${p.avoid_steps ? 'No stairs' : 'Stairs allowed'} · slopes up to ${p.max_slope}% · max ${p.max_km} km · a rest every ${p.rest_every_m} m`;
  $('weather').textContent = d.weather.summary;

  const km = d.route.distance_m / 1000;
  const speedKmh = p.max_km <= 1.5 ? 2 : 2.5;
  $('statDist').textContent = `${km.toFixed(1)} km`;
  $('statTime').textContent = `${Math.max(5, Math.round((km / speedKmh) * 60))} min`;
  $('statSlope').textContent = `${Math.round(d.route.max_slope_pct)}%`;
  $('statLifts').textContent = String(d.route.lifts.length);

  const ul = $('warnings');
  ul.innerHTML = '';
  d.warnings.forEach(w => { const li = document.createElement('li'); li.textContent = w; ul.appendChild(li); });

  drawMap(d);
  drawStops(d.stops);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function drawMap(d) {
  if (map) map.remove();
  map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  const bounds = [];
  d.route.segments.forEach(s => {
    const dash = s.color === 'amber' ? '12 6' : s.color === 'red' ? '3 7' : null;
    L.polyline(s.coords, { color: COLORS[s.color], weight: s.color === 'red' ? 8 : 7, dashArray: dash, opacity: 0.95 })
      .bindTooltip(`${s.slope_pct}% slope`).addTo(map);
    bounds.push(...s.coords);
  });
  d.route.lifts.forEach(l => {
    L.polyline(l.coords, { color: COLORS.lift, weight: 4, dashArray: '6 6' }).bindTooltip(l.name).addTo(map);
    bounds.push(...l.coords);
  });

  const icon = (text, cls) => L.divIcon({ className: '', html: `<div class="num-marker ${cls}">${text}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  L.marker([d.start.lat, d.start.lon], { icon: icon('S', 'start'), title: `Start: ${d.start.label}` }).addTo(map);
  bounds.push([d.start.lat, d.start.lon]);
  d.stops.forEach((s, i) => {
    L.marker([s.lat, s.lon], { icon: icon(String(i + 1), ''), title: s.name }).addTo(map);
    bounds.push([s.lat, s.lon]);
  });
  map.fitBounds(bounds, { padding: [24, 24] });
}

function drawStops(stops) {
  const ol = $('stops');
  ol.innerHTML = '';
  stops.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'stop';

    const head = document.createElement('div');
    head.className = 'stop-head';
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = String(i + 1);
    const txt = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = s.name;
    const why = document.createElement('p');
    why.className = 'muted';
    why.textContent = s.why;
    txt.append(h3, why);
    head.append(num, txt);
    li.appendChild(head);

    if (s.story) {
      const story = document.createElement('p');
      story.textContent = s.story;
      li.appendChild(story);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'listen';
      btn.textContent = '▶ Listen';
      btn.setAttribute('aria-label', `Listen to the story of ${s.name}`);
      btn.addEventListener('click', () => toggleSpeech(btn, `${s.name}. ${s.story} ${s.tip || ''}`));
      li.appendChild(btn);
    }
    if (s.tip) {
      const tip = document.createElement('p');
      tip.className = 'tip';
      const b = document.createElement('strong');
      b.textContent = 'Access tip: ';
      tip.append(b, document.createTextNode(s.tip));
      li.appendChild(tip);
    }
    ol.appendChild(li);
  });
}

// ---------- speech ----------
let speakingBtn = null;
function toggleSpeech(btn, text) {
  if (speakingBtn === btn) {
    speechSynthesis.cancel();
    btn.textContent = '▶ Listen';
    speakingBtn = null;
    return;
  }
  speechSynthesis.cancel();
  if (speakingBtn) speakingBtn.textContent = '▶ Listen';
  const u = new SpeechSynthesisUtterance(text);
  u.lang = VOICE_LANG[lastLang] || 'en-GB';
  u.rate = 0.95;
  u.onend = () => { btn.textContent = '▶ Listen'; if (speakingBtn === btn) speakingBtn = null; };
  speakingBtn = btn;
  btn.textContent = '■ Stop';
  speechSynthesis.speak(u);
}
