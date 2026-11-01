'use strict';
/**
 * Price-move words are text, not fills: the status fill colours read 2:1 on a light theme (Daylight's white),
 * so up and down use the theme's readable --warning-text / --success-text pair.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'cities.css'), 'utf8');
assert.match(css, /\.rent-move strong\.rent-move-up \{ color: var\(--warning-text,/);
assert.match(css, /\.rent-move strong\.rent-move-down \{ color: var\(--success-text,/);
assert.ok(
    !/\.rent-move strong\.rent-move-(up|down) \{ color: var\(--(warning|success),/.test(css),
    'no price-move word uses the fill colour'
);
console.log('move colours: the status text pair is used');
