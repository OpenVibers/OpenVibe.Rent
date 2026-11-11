'use strict';
/** Owner ask 81: the listing results and the saved searches use the kit's empty state with a real next action. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const kim = t.network.addUser('rent-empty');
        await check('a listing search with no match draws the kit empty state', async () => {
            const r = await t.get('/listings?q=zzzznotalisting');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No listing matches those filters'));
            assert.ok(r.text.includes('Clear the filters'));
            assert.match(r.text, /kit\.css/);
        });
        await check('a person with no saved search draws the kit empty state', async () => {
            const r = await t.get('/saved', { as: kim });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No saved searches yet'));
            assert.ok(r.text.includes('Search the listings'));
            assert.match(r.text, /kit\.css/);
        });
    } finally { await t.close(); }
    done();
})();
