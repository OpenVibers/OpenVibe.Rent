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
    jsRawKB: 324,   // 323.2 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 264.3 with Shared 4.13.0 (2026-10-26: account links); 239.8
    jsBrotliKB: 80,   // 79.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 56.5
    cssFiles: 5,   // 5 the short home (2026-10-29): + /shared/kit.css (numbers strip, search pill, folds) and /shared/room.css (cards, rails); 3 (app.css, the cached /shared/showcase.css, css/home.css)
    cssRawKB: 90,   // 89.6 the phone home (2026-10-30: the fold rules for the questions and the other OpenVibe places); 78.3 the short home (2026-10-29): kit.css 25.6 + room.css 15.7 KB (the shared numbers, search, folds, cards and rails; home.css shrank to what the homes still draw): the page shed 10 of its 14.6 phone screens; 37 openvibe-shared 4.26.1 (hero visual); 31.5 with Shared 4.13.0 (2026-10-26: account links); 25.5 with the home's cards, ranks, chips and questions; 19.4 before
    cssBrotliKB: 20.1,   // 20.0 the phone home (2026-10-30: the fold rules for the questions and the other OpenVibe places); 17.4 the short home (2026-10-29): kit.css and room.css; 8.1 openvibe-shared 4.26.1 (hero visual); 7 with Shared 4.13.0 (2026-10-26: account links); 5.9; 4.6 before
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
