'use strict';
/**
 * "Affordable housing near you" — the two upstream services (Nominatim + HUD ArcGIS), the six layers, and the
 * page and API. The upstream fetch is injected through opts.housingFetchImpl (the sandbox has no network or loopback
 * to reach Nominatim/HUD), and the DB cache is the real migrated housing_geo_cache table.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const places = require('../server/housing/places');
const { buildArcGisUrl } = require('../server/housing/upstream');

const nominatimUs = require('./fixtures/housing/nominatim-us.json');
const nominatimCa = require('./fixtures/housing/nominatim-ca.json');
const nominatimSeattle = require('./fixtures/housing/nominatim-seattle.json');
const ph = require('./fixtures/housing/public-housing.json');
const lihtc = require('./fixtures/housing/lihtc.json');
const mf = require('./fixtures/housing/multifamily.json');
const pha = require('./fixtures/housing/housing-authority.json');
const counsel = require('./fixtures/housing/counseling.json');

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const def = (kind) => places.LAYERS.find((l) => l.kind === kind);
const norm = (kind, fixture) => places.normalizeFeature(fixture.features[0], def(kind));

let failHud = false;
const calls = [];
const mockFetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.toString());
    if (u.pathname.endsWith('/search')) {
        const q = u.searchParams.get('q') || '';
        if (/fail/i.test(q)) return jsonResponse({ error: 'boom' }, 500);
        if (/seattle/i.test(q)) return jsonResponse(nominatimSeattle);
        return jsonResponse(/toronto|montreal/i.test(q) ? nominatimCa : nominatimUs);
    }
    if (u.pathname.includes('/query')) {
        if (failHud) return jsonResponse({ error: { message: 'the service is unavailable' } }, 500);
        if (u.pathname.includes('Public_Housing_Developments')) return jsonResponse(ph);
        if (u.pathname.includes('/LIHTC/')) return jsonResponse(lihtc);
        if (u.pathname.includes('MULTIFAMILY_PROPERTIES_ASSISTED')) return jsonResponse(mf);
        if (u.pathname.includes('Public_Housing_Authorities')) return jsonResponse(pha);
        if (u.pathname.includes('Housing_Counseling_Agencies')) return jsonResponse(counsel);
    }
    return jsonResponse({ features: [] });
};

(async () => {
    // ── Unit: geocoding and bounding-box clipping ─────────────
    await check('bounding-box: a small place keeps its own box', () => {
        const box = places.envelopeFor({ lat: 38.9, lon: -77.0, bbox: [38.8, 39.0, -77.1, -76.9] }, 50);
        assert.deepStrictEqual(box, { xmin: -77.1, ymin: 38.8, xmax: -76.9, ymax: 39.0 });
    });

    await check('bounding-box: a bigger place is clipped to ~50 km around its centre', () => {
        // A country-sized box must be ignored in favour of a 50 km box centred on the place.
        const box = places.envelopeFor({ lat: 39.0, lon: -98.0, bbox: [25.0, 49.0, -124.0, -67.0] }, 50);
        const half = 25 / 111.32;
        assert.ok(box.ymin < 39.0 && box.ymax > 39.0, 'latitude is centred on the place');
        assert.ok(box.xmin < -98.0 && box.xmax > -98.0, 'longitude is centred on the place');
        assert.ok(Math.abs((box.ymax - box.ymin) / 2 - half) < 0.001, 'the box is at most 50 km across');
    });

    await check('bounding-box: no usable box gives a 50 km box around the point', () => {
        const box = places.envelopeFor({ lat: 38.9, lon: -77.0, bbox: null }, 50);
        const half = 25 / 111.32;
        assert.ok(box.ymin < 38.9 && box.ymax > 38.9);
        assert.ok(Math.abs((box.ymax - box.ymin) / 2 - half) < 0.001);
    });

    // ── Unit: the ArcGIS query URL ────────────────────────────
    await check('the ArcGIS query URL carries the layer, envelope and only the fields used', () => {
        const base = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services';
        const url = new URL(buildArcGisUrl(base, 'Public_Housing_Developments', 0, { xmin: -77.1, ymin: 38.8, xmax: -76.9, ymax: 39.0 }, ['OBJECTID', 'PROJECT_NAME', 'LAT', 'LON']));
        assert.strictEqual(url.pathname, '/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Developments/FeatureServer/0/query');
        assert.strictEqual(url.searchParams.get('where'), '1=1');
        assert.strictEqual(url.searchParams.get('geometryType'), 'esriGeometryEnvelope');
        assert.strictEqual(url.searchParams.get('spatialRel'), 'esriSpatialRelIntersects');
        assert.strictEqual(url.searchParams.get('inSR'), '4326');
        assert.strictEqual(url.searchParams.get('outSR'), '4326');
        assert.strictEqual(url.searchParams.get('returnGeometry'), 'true');
        assert.strictEqual(url.searchParams.get('resultRecordCount'), '500');
        assert.strictEqual(url.searchParams.get('f'), 'json');
        assert.strictEqual(url.searchParams.get('outFields'), 'OBJECTID,PROJECT_NAME,LAT,LON');
        assert.deepStrictEqual(JSON.parse(url.searchParams.get('geometry')), { xmin: -77.1, ymin: 38.8, xmax: -76.9, ymax: 39.0, spatialReference: { wkid: 4326 } });
    });

    // ── Unit: normalisation of each layer ─────────────────────
    await check('normalises public housing developments', () => {
        const r = norm('public_housing', ph);
        assert.strictEqual(r.kind, 'public_housing');
        assert.strictEqual(r.id, 'hud-ph-7685');
        assert.strictEqual(r.name, 'WHEELER CREEK');
        assert.strictEqual(r.address, '900 Varney St SE');
        assert.strictEqual(r.city, 'Washington');
        assert.strictEqual(r.state, 'DC');
        assert.strictEqual(r.zip, '20032');
        assert.strictEqual(r.lat, 38.835227);
        assert.strictEqual(r.lon, -76.992088);
        assert.strictEqual(r.phone, '2025351500');
        assert.deepStrictEqual(r.units, { total: 100, low_income: null });
        assert.strictEqual(r.extra.authority, 'D.C  Housing Authority');
        assert.strictEqual(r.extra.rent_per_month, 411);
        assert.strictEqual(r.source_url, places.SOURCE.url);
    });

    await check('normalises LIHTC properties', () => {
        const r = norm('lihtc', lihtc);
        assert.strictEqual(r.kind, 'lihtc');
        assert.strictEqual(r.id, 'hud-lihtc-DCB20152001');
        assert.strictEqual(r.name, 'BRIGHTWOOD COMMUNITIES');
        assert.strictEqual(r.phone, null);
        assert.deepStrictEqual(r.units, { total: 141, low_income: 127 });
        assert.strictEqual(r.extra.year_placed, '2015');
    });

    await check('normalises HUD-assisted multifamily properties', () => {
        const r = norm('multifamily', mf);
        assert.strictEqual(r.kind, 'multifamily');
        assert.strictEqual(r.id, 'hud-mf-800022227');
        assert.strictEqual(r.name, 'Graystone Village');
        assert.strictEqual(r.phone, null);
        assert.deepStrictEqual(r.units, { total: 34, low_income: 34 });
        assert.strictEqual(r.extra.property_category, 'Insured-Subsidized');
        assert.strictEqual(r.extra.expiration_date, '2039-09-19');
    });

    await check('normalises public housing authorities, taking the position from the geometry', () => {
        const r = norm('housing_authority', pha);
        assert.strictEqual(r.kind, 'housing_authority');
        assert.strictEqual(r.id, 'hud-pha-300');
        assert.strictEqual(r.name, 'Springfield Housing Authority');
        assert.strictEqual(r.lat, 43.2984);
        assert.strictEqual(r.lon, -72.4807);
        assert.strictEqual(r.phone, '8028854905');
        assert.deepStrictEqual(r.units, { total: 0, low_income: null });
        assert.strictEqual(r.extra.section8_units, 196);
    });

    await check('normalises housing counselling agencies', () => {
        const r = norm('counseling', counsel);
        assert.strictEqual(r.kind, 'counseling');
        assert.strictEqual(r.id, 'hud-counsel-400');
        assert.strictEqual(r.name, 'INLAND FAIR HOUSING AND MEDIATION BOARD');
        assert.strictEqual(r.phone, '909-984-2254');
        assert.deepStrictEqual(r.units, { total: null, low_income: null });
        assert.strictEqual(r.extra.services, 'Mortgage Delinquency and Default Resolution Counseling');
        assert.strictEqual(r.extra.website, 'http://www.ifhmb.com/');
    });

    await check('normalises HUD homes for sale (SF_REO): padded street fields, ZIP, case number, HUD Homestore link', () => {
        const r = places.normalizeFeature({ attributes: { OBJECTID: 9, CASE_NUM: '011-662347', STREET_NUM: '2220 ', DIRECTION_PREFIX: null, STREET_NAME: 'E TUSCALOOSA A                ', ADDRESS: '2220 E TUSCALOOSA A                ', CITY: 'GADSDEN', STATE_CODE: 'AL', DISPLAY_ZIP_CODE: 5904, DATE_ACQUIRED: 1713225600000, DATE_CLOSED: null }, geometry: { x: -86.03811, y: 34.028436 } }, def('hud_home'));
        assert.strictEqual(r.kind, 'hud_home');
        assert.strictEqual(r.id, 'hud-reo-011-662347');
        assert.strictEqual(r.name, '2220 E TUSCALOOSA A');
        assert.strictEqual(r.zip, '05904', 'a numeric ZIP keeps its leading zero');
        assert.strictEqual(r.extra.case_number, '011-662347');
        assert.strictEqual(r.extra.acquired, '2024-04-16T00:00:00.000Z');
        assert.strictEqual(r.extra.homestore_url, 'https://www.hudhomestore.gov/searchresult?citystate=GADSDEN%2C%20AL');
        assert.deepStrictEqual([r.lat, r.lon], [34.028436, -86.03811]);
        assert.ok(places.KINDS.includes('hud_home'));
        assert.match(places.KIND_DESCRIPTIONS.hud_home, /snapshot \(March 2026\)/);
    });

    await check('a missing value stays null, never invented', () => {
        const r = places.normalizeFeature({ attributes: { OBJECTID: 1, PROJECT_NAME: 'X', TOTAL_UNITS: 12 }, geometry: { x: -77, y: 38 } }, def('public_housing'));
        assert.strictEqual(r.address, null);
        assert.strictEqual(r.city, null);
        assert.strictEqual(r.phone, null);
        assert.strictEqual(r.extra.authority, null);
        assert.strictEqual(r.extra.rent_per_month, null);
        assert.strictEqual(r.extra.last_updated, null);
        assert.deepStrictEqual(r.units, { total: 12, low_income: null });
    });

    await check('results sort nearest first', () => {
        const features = [
            { attributes: { OBJECTID: 1, PROJECT_NAME: 'Far', LAT: 39.0, LON: -77.0 }, geometry: { x: -77.0, y: 39.0 } },
            { attributes: { OBJECTID: 2, PROJECT_NAME: 'Near', LAT: 38.9, LON: -77.0 }, geometry: { x: -77.0, y: 38.9 } },
        ];
        const results = places.elementsToResults(features, def('public_housing'), { lat: 38.9, lon: -77.0 }, 10);
        assert.strictEqual(results[0].name, 'Near');
        assert.strictEqual(results[1].name, 'Far');
        assert.ok(results[0].distance_km < results[1].distance_km);
    });

    // ── Integration: the page and the API with an injected fetch ──
    const t = await boot({ housingFetchImpl: mockFetch });
    try {
        await check('the API geocodes the place and returns the normalised results with attribution', async () => {
            const r = await t.get('/api/v1/housing?q=Washington');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            const body = r.json();
            assert.strictEqual(body.in_us, true);
            assert.strictEqual(body.location.name, 'Washington, District of Columbia, United States');
            assert.deepStrictEqual(body.kinds, places.KINDS);
            assert.strictEqual(body.counts.total, 5);
            assert.strictEqual(body.results.length, 5);
            assert.strictEqual(body.attribution.text, places.ATTRIBUTION.text);
            assert.ok(body.results.every((x) => typeof x.distance_km === 'number'));
        });

        await check('the cache: a second request for the same place does not fetch again', async () => {
            const before = calls.length;
            const r = await t.get('/api/v1/housing?q=Washington');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(calls.length, before, 'no new upstream calls on a cached answer');
        });

        await check('the page signed out shows the results, each kind\'s explanation and the attribution', async () => {
            const r = await t.get('/housing?q=Washington');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.match(r.text, /action="\/housing"/);
            assert.ok(r.text.includes('Wheeler Creek'), 'a public housing result is on the page');
            assert.ok(r.text.includes('Brightwood Communities'), 'a LIHTC result is on the page');
            assert.ok(r.text.includes('Springfield Housing Authority'), 'a housing authority is on the page');
            assert.match(r.text, /Public housing: homes owned by a local housing authority/);
            assert.ok(r.text.includes('Source: U.S. Department of Housing and Urban Development (HUD), public domain'));
            assert.ok(r.text.includes('https://hudgis-hud.opendata.arcgis.com/'));
            assert.ok(r.text.includes('covers the United States'));
            assert.ok(r.text.includes('availability must be confirmed'));
        });

        await check('a place outside the United States answers the honest US-only state, never a fetch to HUD', async () => {
            const before = calls.length;
            const api = await t.get('/api/v1/housing?q=Toronto');
            assert.strictEqual(api.status, 200);
            const body = api.json();
            assert.strictEqual(body.in_us, false);
            assert.deepStrictEqual(body.results, []);
            assert.strictEqual(body.counts.total, 0);
            assert.ok(!calls.slice(before).some((u) => u.includes('/query')), 'no HUD query for a non-US place');

            const page = await t.get('/housing?q=Toronto');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('HUD data covers the United States only'));
        });

        await check('an upstream failure is a clear state, never a 500', async () => {
            const api = await t.get('/api/v1/housing?q=fail');
            assert.strictEqual(api.status, 502);
            assert.strictEqual(api.json().code, 'housing.place.upstream');

            const page = await t.get('/housing?q=fail');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('could not reach the place service right now'));
        });

        await check('a HUD failure says it could not reach HUD right now', async () => {
            failHud = true;
            try {
                const page = await t.get('/housing?q=Seattle');
                assert.strictEqual(page.status, 200);
                assert.ok(page.text.includes('could not reach HUD right now'));
            } finally {
                failHud = false;
            }
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
