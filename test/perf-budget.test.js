'use strict';
// Size budgets for openvibe.rent's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0.
//
// Raised on 2026-10-08 for the product's home page: it is no longer the skeleton's, so the measurement moved from
// 24.9/6.2 KB to 28.4/6.5 KB (search box, latest listings, how it works, where the listings come from, cta). The
// budget keeps the same ~10% headroom over the new measurement; the other lines are unchanged.
// Raised on 2026-10-22 for the curated home (the owner's "rich content on the home page"): counts, the kinds, the 12
// largest cities' rents, the cheapest and dearest big cities, every state, every site searched, HUD links, Homes, the
// product's questions, and ItemList + FAQPage JSON-LD. Measured 49.3/10.8 KB HTML and 25.5/5.9 KB CSS with one more
// file (css/home.css); the budgets keep about 10% headroom over that.
// Raised on 2026-10-29 for the short home (a taste and a door: the search first, rails, folds, a launcher; 14.6 -> 4.2
// screens at 390 px): the shared kit's stylesheets (kit.css, room.css) and their markup, measured 62.2 KB HTML and
// 78.3/17.4 KB CSS in 5 files; the budgets keep about 10% headroom over that.
const BUDGETS = {
    htmlRawKB: 68,   // 62.2 the short home (2026-10-29): the kit's cards (an icon each), folds and search pill around the same cities, states and sites, now folded; 55.4 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 49.3 on 2026-10-22 (the curated home); 31.0 before
    htmlBrotliKB: 14,   // 12.1 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 10.8 on 2026-10-22; 8.1 on 2026-10-16 (Rent by city: the largest cities' rents where an empty "posted here" was); 7.4 before
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 376.7, // 376.7: measured 368.7 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 89.8, // 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 5,   // 5 the short home (2026-10-29): + /shared/kit.css (numbers strip, search pill, folds) and /shared/room.css (cards, rails); 3 (app.css, the cached /shared/showcase.css, css/home.css)
    cssRawKB: 124.9, // 124.9: measured 119.9 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 27.8, // 27.8: measured 26.6 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', RENT_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (RENT_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
