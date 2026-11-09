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
    jsBrotliKB: 89.5, // 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 5,   // 5 the short home (2026-10-29): + /shared/kit.css (numbers strip, search pill, folds) and /shared/room.css (cards, rails); 3 (app.css, the cached /shared/showcase.css, css/home.css)
    cssRawKB: 115.4, // 115.4 with openvibe-shared 4.149.0 (2026-11-08: the menu has tabs at the top; the phone's menu button is the orb of 4.148.0); 115.3 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 114.4 with openvibe-shared 4.107.3 (2026-11-03: a custom room picture sits under the text on phones); 113.7 with openvibe-shared 4.103.0 (2026-11-02: the puzzle glyph, two-line sidebar rows, boost lets parsed pages go, eight solids) (2026-11-02); 112.3 with 2026-11-02: Shared 4.93.2 (labels kit, counted footer folds) (2026-11-01); 111.5 with 2026-11-01: openvibe-shared 4.91.0 (card faces, audio-only player, busy buttons) (2026-11-01); 110.6 with 2026-11-01: openvibe-shared 4.86.0 (2026-11-01); 109.2 with 2026-11-01: the city bars (2026-11-01); 107.4 with 2026-11-01: phone table cards (2026-11-01); 104.8 with openvibe-shared 4.82.0: the motion tokens in kit.css and room.css (2026-11-01); 102.7 with openvibe-shared 4.81.0: shape and elevation tokens in kit.css and room.css (2026-11-01); 98.3 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 94.8 with openvibe-shared 4.62.0: the shared sidebar in kit.css, the glyphs and their fonts (2026-10-31); 89.6 the phone home (2026-10-30: the fold rules for the questions and the other OpenVibe places); 78.3 the short home (2026-10-29): kit.css 25.6 + room.css 15.7 KB (the shared numbers, search, folds, cards and rails; home.css shrank to what the homes still draw): the page shed 10 of its 14.6 phone screens; 37 openvibe-shared 4.26.1 (hero visual); 31.5 with Shared 4.13.0 (2026-10-26: account links); 25.5 with the home's cards, ranks, chips and questions; 19.4 before
    cssBrotliKB: 26,   // 25.6 with openvibe-shared 4.107.3 (2026-11-03: a custom room picture sits under the text on phones); 25.2 with 2026-11-02: openvibe-shared 4.100.1 (the conversation kit's parts, date covers, room CSS) (2026-11-02); 24.6 with 2026-11-01: openvibe-shared 4.86.0 (2026-11-01); 24.3 with 2026-11-01: the city bars (2026-11-01); 23.6 with 2026-11-01: sign-in prompt layout (2026-11-01); 23.2 with openvibe-shared 4.82.0: the motion tokens in kit.css and room.css (2026-11-01); 22.7 with openvibe-shared 4.81.0: shape and elevation tokens in kit.css and room.css (2026-11-01); 20.8 with openvibe-shared 4.62.0: the shared sidebar in kit.css, the glyphs and their fonts (2026-10-31); 20.0 the phone home (2026-10-30: the fold rules for the questions and the other OpenVibe places); 17.4 the short home (2026-10-29): kit.css and room.css; 8.1 openvibe-shared 4.26.1 (hero visual); 7 with Shared 4.13.0 (2026-10-26: account links); 5.9; 4.6 before
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
