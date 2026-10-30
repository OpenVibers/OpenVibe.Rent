'use strict';

/**
 * BLS CPI rent of primary residence, read from OpenVibe.Sources (source bls-cpi-rent, category housing), never from
 * BLS. Sources streams BLS's published CPI flat file under its robots and terms checks and keeps one item per matching
 * series and month; Rent follows Sources' change feed from its own cursor and keeps one point per series and month in
 * rent_cpi_points, so a city page can show a dated trend line beside HUD's Fair Market Rent.
 *
 * The series are the US city average (CUUR0000SEHA) and the 19 largest metro rent series BLS publishes in that file.
 * A city maps to a BLS metro by the area name's own cities and states ("New York-Newark-Jersey City, NY-NJ-PA"); a city
 * BLS does not publish a rent series for shows the national line and says so. The 12-month change is the latest index
 * against the same month a year earlier, never a guess from a shorter run.
 *
 * BLS asks to be cited and says it cannot vouch for the data once they leave BLS.gov: NOTE says both wherever a figure
 * shows. Pulls 35 seconds after start and then every six hours. Off without OV_SOURCES_INTERNAL_URL and the OAuth
 * client secret (a test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'bls-cpi-rent';
const CURSOR = 'sources.housing.rentcpi.after';
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 35 * 1000;
const NOTE = 'Rent of primary residence CPI from the U.S. Bureau of Labor Statistics (public domain). BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.';
const BLS_URL = 'https://data.bls.gov/timeseries/';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const NATIONAL = { series: 'CUUR0000SEHA', name: 'US city average' };
const METROS = [
    { series: 'CUURS12ASEHA', name: 'New York-Newark-Jersey City, NY-NJ-PA' },
    { series: 'CUURS49ASEHA', name: 'Los Angeles-Long Beach-Anaheim, CA' },
    { series: 'CUURS23ASEHA', name: 'Chicago-Naperville-Elgin, IL-IN-WI' },
    { series: 'CUURS37ASEHA', name: 'Dallas-Fort Worth-Arlington, TX' },
    { series: 'CUURS37BSEHA', name: 'Houston-The Woodlands-Sugar Land, TX' },
    { series: 'CUURS35BSEHA', name: 'Miami-Fort Lauderdale-West Palm Beach, FL' },
    { series: 'CUURS35CSEHA', name: 'Atlanta-Sandy Springs-Roswell, GA' },
    { series: 'CUURS12BSEHA', name: 'Philadelphia-Camden-Wilmington, PA-NJ-DE-MD' },
    { series: 'CUURS35ASEHA', name: 'Washington-Arlington-Alexandria, DC-VA-MD-WV' },
    { series: 'CUURS11ASEHA', name: 'Boston-Cambridge-Newton, MA-NH' },
    { series: 'CUURS24ASEHA', name: 'Minneapolis-St.Paul-Bloomington, MN-WI' },
    { series: 'CUURS23BSEHA', name: 'Detroit-Warren-Dearborn, MI' },
    { series: 'CUURS48ASEHA', name: 'Phoenix-Mesa-Scottsdale, AZ' },
    { series: 'CUURS48BSEHA', name: 'Denver-Aurora-Lakewood, CO' },
    { series: 'CUURS49BSEHA', name: 'San Francisco-Oakland-Hayward, CA' },
    { series: 'CUURS49DSEHA', name: 'Seattle-Tacoma-Bellevue, WA' },
    { series: 'CUURS49ESEHA', name: 'San Diego-Carlsbad, CA' },
    { series: 'CUURA104SEHA', name: 'Pittsburgh, PA' },
    { series: 'CUURA210SEHA', name: 'Cleveland-Akron, OH' },
];
const BY_SERIES = new Map([NATIONAL, ...METROS].map((m) => [m.series, m]));

const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const monthKey = (year, period) => Number(year) * 12 + Number(String(period).slice(1)) - 1;

/** A city of the Rent list → the BLS metro area whose own name lists that city and state, or null. */
function metroFor(city) {
    if (!city || !city.name || !city.state) return null;
    const name = norm(city.name);
    const state = String(city.state).toUpperCase();
    for (const metro of METROS) {
        const [cities, states] = metro.name.split(',');
        if (!cities || !states) continue;
        if (!states.trim().split('-').includes(state)) continue;
        if (cities.split('-').map(norm).includes(name)) return metro;
    }
    return null;
}

/** A Sources item → a rent_cpi_points row, or null when it is not a series and month this trend uses. */
function rowOf(item) {
    if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'rent_cpi') return null;
    const f = item.fields || {};
    const series = text(f.series_id, 20);
    if (!series || !BY_SERIES.has(series)) return null;
    const year = Number(f.year);
    const period = text(f.period, 3);
    const value = Number(f.value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
    if (!/^M(0[1-9]|1[0-2])$/.test(period || '')) return null;
    if (!Number.isFinite(value) || value <= 0 || value > 100000) return null;
    return {
        series_id: series,
        year,
        period,
        value: Math.round(value * 1000) / 1000,
        item_id: String(item.id || ''),
        revision: Number(item.revision) || 1,
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
}

function pointOf(row) {
    return { year: Number(row.year), period: row.period, value: Number(row.value), month: monthKey(row.year, row.period), label: `${MONTHS[Number(row.period.slice(1)) - 1]} ${row.year}` };
}

/** The latest point and the 12-month change, with the points a trend line draws (up to the last 13 months). */
function trendOf(rows) {
    const points = rows.map(pointOf).sort((a, b) => a.month - b.month);
    if (!points.length) return null;
    const latest = points[points.length - 1];
    const earlier = points.find((p) => p.month === latest.month - 12) || null;
    const change_pct = earlier && earlier.value ? Math.round((latest.value / earlier.value - 1) * 1000) / 10 : null;
    return {
        points: points.slice(-13),
        latest,
        earlier,
        change_pct,
        series: rows[0].series_id,
    };
}

function phrasing(area, trend) {
    if (!trend) return null;
    const month = trend.latest.label;
    if (trend.change_pct == null) return `BLS's rent index for ${area} stands at ${trend.latest.value} for ${month}; a 12-month change needs the same month a year earlier.`;
    const verb = trend.change_pct > 0 ? 'rose' : trend.change_pct < 0 ? 'fell' : 'was unchanged';
    const amount = trend.change_pct === 0 ? '' : ` ${Math.abs(trend.change_pct).toFixed(1)}%`;
    return `Rents in ${area} ${verb}${amount} in the last year (BLS CPI, ${month}).`;
}

function createRentCpi({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'housing' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'rent', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let bySeries = new Map();
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'rent_cpi') return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM rent_cpi_points WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        await t.query(`INSERT INTO rent_cpi_points (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (series_id, year, period) DO UPDATE SET ${cols.filter((c) => !['series_id', 'year', 'period'].includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE rent_cpi_points.item_id <> EXCLUDED.item_id OR rent_cpi_points.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    async function load() {
        const rows = await s.db.many('SELECT series_id, year, period, value, item_id, revision, retrieved_at FROM rent_cpi_points');
        const grouped = new Map();
        for (const row of rows) {
            if (!BY_SERIES.has(row.series_id)) continue;
            if (!grouped.has(row.series_id)) grouped.set(row.series_id, []);
            grouped.get(row.series_id).push(row);
        }
        bySeries = new Map([...grouped.entries()].map(([series, list]) => [series, trendOf(list)]));
        return bySeries.size;
    }

    /** Follow Sources' change feed to its end. Never throws: the caller is a timer or a test. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        try {
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            stats.pulls++;
            stats.applied += out.applied;
            stats.removed += out.removed;
            stats.last_at = s.iso();
            stats.last_error = null;
            await load();
            if (out.applied || out.removed) log.log(`[RentCpi] ${out.applied} BLS rent points updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = text(err && err.message, 300);
            log.warn(`[RentCpi] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    /** A trend for one series: the latest point, its 12-month change and the line's points; null when unread. */
    function forSeries(series) {
        const trend = bySeries.get(series);
        if (!trend) return null;
        const def = BY_SERIES.get(series);
        return { series, area: def.name, ...trend, text: phrasing(def.name, trend), url: `${BLS_URL}${series}` };
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        load,
        forSeries,
        metroFor,
        /** The national line and, where BLS publishes one, the city's metro line; the metro line is the one quoted. */
        trendForCity(city) {
            const national = forSeries(NATIONAL.series);
            const metro = metroFor(city);
            const local = metro ? forSeries(metro.series) : null;
            const picked = local || national;
            if (!picked) return null;
            return {
                scope: local ? 'metro' : 'national',
                area: picked.area,
                text: picked.text,
                series: picked.series,
                url: picked.url,
                points: picked.points,
                latest: picked.latest,
                change_pct: picked.change_pct,
                national,
                metro: local,
            };
        },
        start() {
            load().catch(() => { /* the first pull loads it */ });
            if (!client || timer) return;
            first = setTimeout(() => { pull(); }, FIRST_MS);
            timer = setInterval(() => { pull(); }, EVERY_MS);
            if (first.unref) first.unref();
            if (timer.unref) timer.unref();
        },
        stop() {
            if (first) clearTimeout(first);
            if (timer) clearInterval(timer);
            first = null;
            timer = null;
        },
    };
}

module.exports = { createRentCpi, rowOf, trendOf, metroFor, phrasing, METROS, NATIONAL, NOTE, BLS_URL, SOURCE_KEY };
