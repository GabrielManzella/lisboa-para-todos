# Lisboa Para Todos

An AI walking guide for travellers with limited mobility in Lisbon. Describe who is walking; the app picks an accessibility profile, checks today's weather, chooses stops from a checked list, routes them with gentle slopes and the city's free lifts, and reads a short story aloud at each stop.

## How it works

`POST /api/plan` runs five steps:

1. **Profile** (LLM via Groq): the description becomes archetypes; the server applies the strictest limits.
2. **Weather** (Open-Meteo): wind, rain, heat and cold flags for the walk.
3. **Stops** (LLM): only ids from `data/stops.json` and `data/lifts.json` are accepted.
4. **Route** (OpenRouteService, wheelchair profile with elevation): we compute slope per ~20 m and colour it.
5. **Stories** (LLM): one story and access tip per stop.

## Run it

```bash
npm install
cp .env.example .env   # add your keys
npm start              # http://127.0.0.1:3000
```

`.env`:

```
GROQ_API_KEY=...
ORS_API_KEY=...
# optional
# GROQ_MODEL=  (optional: the server picks an available model automatically)
PORT=3000
```

## Data

`data/stops.json` and `data/lifts.json` hold the places the AI may choose. Every entry with `"verify": true` still needs its coordinates and accessibility notes checked on site or on a reliable source.

## Credits

Routing: openrouteservice © HeiGIT · Map data © OpenStreetMap contributors · Weather: Open-Meteo · LLM: Groq.
