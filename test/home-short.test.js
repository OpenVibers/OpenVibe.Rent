'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the questions and the other OpenVibe places are
 * folds, closed on a phone and open where there is room. Both stay in the page for the crawlers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the questions and the other OpenVibe places are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            for (const id of ['faq-fold', 'network-fold']) {
                assert.ok(r.text.includes(`<details class="hm-fold hm-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(r.text.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(r.text, /Which sites does it search\?/);
            assert.match(r.text, /Part of OpenVibe/);
            // The sections they replace are still there.
            assert.ok(r.text.includes('id="h-faq"'));
            assert.ok(r.text.includes('class="sc-sec sc-network"'));
        });

        await check('the CSS guard: a fold is a 44 px target and only the phone rules change the page', async () => {
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home.css'), 'utf8');
            assert.match(css, /\.hm-fold-block > summary \{[^}]*min-height: 44px/, 'a fold is a 44 px target');
            assert.match(css, /\.hm-fold-block > summary span \{ display: none; \}/, 'the "tap to open" hint is hidden where there is room');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
