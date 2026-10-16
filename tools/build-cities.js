#!/usr/bin/env node
'use strict';
/**
 * Builds server/data/cities.json: every US place of 50,000 people or more (and each state's largest) with its typical rents, from the US Census
 * Bureau's American Community Survey (5-year estimates, public domain), for the city pages (/in/<state>/<city>) and
 * the fair-rent check (/fair). Nothing here is fetched at run time: the service reads the committed file.
 *
 *   node tools/build-cities.js <dir>        # <dir> holds the four files below, as downloaded
 *
 * The files (keyless downloads; the Census API itself now wants a key):
 *   https://www2.census.gov/programs-surveys/acs/summary_file/<year>/table-based-SF/data/5YRData/acsdt5y<year>-b25031.dat
 *     B25031 Median gross rent by bedrooms (E001 all, E002 no bedroom … E007 five or more), with margins of error
 *   …/acsdt5y<year>-b01003.dat                    B01003 Total population
 *   …/acsdt5y<year>-b25077.dat                    B25077 Median value of owner-occupied homes (owners' estimate), for OpenVibe.Homes
 *   …/table-based-SF/documentation/Geos<year>5YR.txt   names and state codes (summary level 160 = place)
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/<year>_Gazetteer/<year>_Gaz_place_national.zip (unzipped)
 *     each place's internal point (latitude, longitude)
 *
 * Gross rent is contract rent plus the utilities the renter pays. A median the Census does not publish (too few
 * renters) is null, never filled in; the top code ($3,501, "3,500 or more") is kept as `top`.
 */
const fs = require('fs');
const path = require('path');

const YEAR = 2024;
const MIN_POPULATION = 50000;
const KEYS = ['all', 'studio', 'b1', 'b2', 'b3', 'b4', 'b5'];
const TOP = 3501;

// Consolidated city-counties and other places whose Census name is not what people call them.
const DISPLAY = {
    'Nashville-Davidson': 'Nashville', 'Louisville/Jefferson County': 'Louisville', 'Urban Honolulu': 'Honolulu',
    'Lexington-Fayette': 'Lexington', 'Augusta-Richmond County': 'Augusta', 'Athens-Clarke County': 'Athens',
    'San Buenaventura (Ventura)': 'Ventura', 'Macon-Bibb County': 'Macon', 'Columbus city (balance)': 'Columbus',
};
const SUFFIX = / (city|town|village|CDP|borough|municipality|zona urbana|city \(balance\)|unified government \(balance\)|consolidated government \(balance\)|urban county|metro government \(balance\)|metropolitan government \(balance\))$/;

const slug = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function rows(file, sep = '|') {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const head = lines.shift().split(sep).map((h) => h.trim());
    return lines.map((l) => { const c = l.split(sep); const o = {}; head.forEach((h, i) => { o[h] = (c[i] || '').trim(); }); return o; });
}
const num = (v) => (/^-?\d+$/.test(v) && Number(v) >= 0 ? Number(v) : null);

function main(dir) {
    const f = (name) => path.join(dir, name);
    const pop = new Map();
    for (const r of rows(f(`acsdt5y${YEAR}-b01003.dat`))) if (r.GEO_ID.startsWith('1600000US')) pop.set(r.GEO_ID, num(r.B01003_E001));
    const names = new Map();
    for (const r of rows(f(`Geos${YEAR}5YR.txt`))) if (r.SUMLEVEL === '160') names.set(r.GEO_ID, { name: r.NAME, state: r.STUSAB });
    const value = new Map();
    for (const r of rows(f(`acsdt5y${YEAR}-b25077.dat`))) if (r.GEO_ID.startsWith('1600000US')) value.set(r.GEO_ID, { e: num(r.B25077_E001), m: num(r.B25077_M001) });
    const point = new Map();
    for (const r of rows(f(`${YEAR}_Gaz_place_national.txt`), '\t')) point.set(`1600000US${r.GEOID}`, { lat: Number(r.INTPTLAT), lon: Number(r.INTPTLONG) });

    // Every state has a page: a state with no place of MIN_POPULATION keeps its largest place (Vermont, West Virginia).
    const rentRows = rows(f(`acsdt5y${YEAR}-b25031.dat`)).filter((r) => pop.get(r.GEO_ID) && names.get(r.GEO_ID));
    const largest = new Map();
    for (const r of rentRows) {
        const st = names.get(r.GEO_ID).state; const best = largest.get(st);
        if (!best || pop.get(r.GEO_ID) > pop.get(best)) largest.set(st, r.GEO_ID);
    }
    const keep = new Set([...largest.values()]);
    const cities = [];
    for (const r of rentRows) {
        const p = pop.get(r.GEO_ID);
        if (p < MIN_POPULATION && !keep.has(r.GEO_ID)) continue;
        const n = names.get(r.GEO_ID);
        const raw = n.name.split(',')[0];
        let city = raw.replace(SUFFIX, '');
        city = DISPLAY[city] || DISPLAY[raw] || city;
        const kind = raw.endsWith(' CDP') ? 'cdp' : 'city';
        const rent = {}; const moe = {}; const top = [];
        KEYS.forEach((k, i) => {
            const e = num(r[`B25031_E00${i + 1}`]); const m = num(r[`B25031_M00${i + 1}`]);
            rent[k] = e; moe[k] = e == null ? null : m;
            if (e === TOP) top.push(k);
        });
        const pt = point.get(r.GEO_ID) || {};
        cities.push({
            id: r.GEO_ID.slice(9), name: city, state: n.state, kind, population: p,
            lat: Number.isFinite(pt.lat) ? Math.round(pt.lat * 1e4) / 1e4 : null, lon: Number.isFinite(pt.lon) ? Math.round(pt.lon * 1e4) / 1e4 : null,
            rent, moe, ...(top.length ? { top } : {}),
            // Median home value: null when unpublished; the Census top code ($2,000,001: "$2,000,000 or more") is kept as is.
            value: (value.get(r.GEO_ID) || {}).e ?? null, valueMoe: (value.get(r.GEO_ID) || {}).e == null ? null : (value.get(r.GEO_ID) || {}).m ?? null,
        });
    }
    // Slugs: the name within its state; a second place with the same name in a state gets its Census id.
    cities.sort((a, b) => b.population - a.population);
    const seen = new Set();
    for (const c of cities) {
        let s = slug(c.name);
        if (seen.has(`${c.state}/${s}`)) s = `${s}-${c.id}`;
        seen.add(`${c.state}/${s}`);
        c.slug = s;
    }
    const out = {
        source: {
            name: 'U.S. Census Bureau, American Community Survey 5-year estimates', years: `${YEAR - 4}–${YEAR}`, table: 'B25031 (median gross rent by bedrooms), B25077 (median home value), B01003 (population)',
            url: 'https://www.census.gov/programs-surveys/acs', licence: 'public domain', built: new Date().toISOString().slice(0, 10),
            note: 'Gross rent is contract rent plus the utilities the renter pays; home value is the owners\' own estimate of what their home would sell for. Medians the Census does not publish are null; 3501 (rent) and 2000001 (value) are its top codes.',
        },
        minPopulation: MIN_POPULATION,
        cities,
    };
    fs.writeFileSync(path.join(__dirname, '..', 'server', 'data', 'cities.json'), JSON.stringify(out) + '\n');
    console.log(`server/data/cities.json: ${cities.length} places (${cities.filter((c) => c.kind === 'cdp').length} census-designated), ${new Set(cities.map((c) => c.state)).size} states`);
}

if (require.main === module) {
    if (!process.argv[2]) { console.error('usage: node tools/build-cities.js <dir with the ACS and gazetteer files>'); process.exit(2); }
    main(process.argv[2]);
}
