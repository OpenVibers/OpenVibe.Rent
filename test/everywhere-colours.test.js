'use strict';
/**
 * The "open on the site" host line is text, not a button: --accent-text is --accent-strong in the Vibe theme (#3472d8
 * on the #131c2e card, 3.7:1), so the host mixes the accent with the body text — readable on the dark and light themes.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'everywhere.css'), 'utf8');
assert.match(
    css,
    /\.ew-host \{[^}]*color: color-mix\(in srgb, var\(--accent, #3b82f6\) 60%, var\(--text-primary, #e6edf7\)\)/,
    'the host text mixes the accent with the body text'
);
assert.ok(!/\.ew-host \{[^}]*color: var\(--accent-text/.test(css), 'the host text is not the button fill');
console.log('everywhere colours: the host text is readable on dark and light');
