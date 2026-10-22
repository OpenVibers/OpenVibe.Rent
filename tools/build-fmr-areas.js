#!/usr/bin/env node
'use strict';
/**
 * Builds server/data/city-fmr-areas.json: the HUD Fair Market Rent area each city in server/data/cities.json lies in
 * (its FMR_CODE, e.g. METRO35620MM5600 for New York), so a city page can show HUD's Fair Market Rents for it. The
 * rents themselves are not stored here: OpenVibe.Sources reads them from HUD every week (source hud-fair-market-rents,
 * identity FMR_CODE) and Rent follows it (server/housing/fair-market-rents.js). Areas change only when HUD redraws
 * them (with OMB's metro definitions, every few years), so this is run again then, not on a schedule.
 *
 *   node tools/build-fmr-areas.js                 # about 30 minutes: one point query at a time, a second apart at least
 *   node tools/build-fmr-areas.js --only-missing  # ask again only for the cities the last run left out
 *
 * Each city's internal point (the Census gazetteer's, already in cities.json) is asked of HUD's own Fair Market Rents
 * feature layer (the one Sources reads, public domain), with OpenVibe.Rent's User-Agent. A point no area contains (a
 * coastal city whose point lies on the water, like Miami Beach's) is asked again with a 3 km circle, and kept only when
 * exactly one area answers; otherwise it is left out, never guessed.
 */
const fs = require('fs');
const path = require('path');

const LAYER = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Fair_Market_Rents/FeatureServer/0/query';
const OUT = path.join(__dirname, '..', 'server', 'data', 'city-fmr-areas.json');
const UA = 'OpenVibeRent/0.1 (+https://openvibe.rent)';
const PACE_MS = 1000;

async function areaAt(lat, lon, { radiusM = 0 } = {}) {
    const url = new URL(LAYER);
    url.search = new URLSearchParams({
        geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        ...(radiusM ? { distance: String(radiusM), units: 'esriSRUnit_Meter' } : {}),
        outFields: 'FMR_CODE,FMR_AREANAME', returnGeometry: 'false', f: 'json',
    }).toString();
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
            const codes = [...new Set((body.features || []).map((f) => f.attributes.FMR_CODE))];
            if (codes.length !== 1) return null;
            const f = body.features[0];
            return { code: f.attributes.FMR_CODE, name: f.attributes.FMR_AREANAME };
        } catch (err) {
            if (attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
    }
}

async function main() {
    const { cities } = require('../server/data/cities.json');
    const onlyMissing = process.argv.includes('--only-missing');
    const before = onlyMissing ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { areas: {}, names: {} };
    const areas = { ...before.areas };
    const names = { ...before.names };
    let missing = 0;
    for (const [i, c] of cities.entries()) {
        if (areas[c.id]) continue;
        const started = Date.now();
        const a = (await areaAt(c.lat, c.lon)) || (await areaAt(c.lat, c.lon, { radiusM: 3000 }));
        if (a && /^[A-Z0-9]{6,40}$/.test(a.code)) { areas[c.id] = a.code; names[a.code] = a.name; } else { missing++; console.warn(`no area: ${c.name}, ${c.state}`); }
        if ((i + 1) % 50 === 0) console.log(`${i + 1}/${cities.length}`);
        const wait = PACE_MS - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const out = {
        source: {
            name: 'U.S. Department of Housing and Urban Development, Fair Market Rents feature layer',
            url: 'https://hudgis-hud.opendata.arcgis.com/datasets/fair-market-rents',
            licence: 'public domain (US federal government work)',
            built: new Date().toISOString().slice(0, 10),
            note: 'Each city\'s Census internal point, located in HUD\'s FMR areas. The rents come from OpenVibe.Sources (hud-fair-market-rents), not from this file.',
        },
        areas,
        names,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
    console.log(`${Object.keys(areas).length} cities in ${Object.keys(names).length} areas; ${missing} without an area → ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
