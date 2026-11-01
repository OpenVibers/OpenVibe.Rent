'use strict';

/** Escaping and small building blocks for server-rendered pages. Everything dynamic goes through esc(). */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template: interpolations are escaped unless wrapped in raw(). Arrays are joined. */
class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Raw(s);
function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => {
        out += render(v) + strings[i + 1];
    });
    return raw(out);
}
function render(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    return esc(v);
}

const code = (s) => html`<code>${s}</code>`;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An ISO timestamp as "31 Oct 2026" (UTC), or null when it is not a real date (1970 is "not given"). */
function dayText(iso) {
    const t = Date.parse(String(iso == null ? '' : iso));
    if (!Number.isFinite(t) || t <= 0 || String(iso).startsWith('1970-01-01')) return null;
    const d = new Date(t);
    return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** A date a reader reads ("31 Oct 2026"), never the raw ISO string; `datetime` keeps the machine value. */
const time = (iso) => {
    if (!iso) return '—';
    const day = dayText(iso);
    return html`<time datetime="${iso}">${day || String(iso)}</time>`;
};

/** A <table> from headers and rows of cells (cells are already html or plain values). Each cell names its column
 *  (data-label), so on a phone a wide table can show each row as a card (the site's stylesheet). */
function table(headers, rows, { cls = '', empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (typeof headers[i] === 'string' && headers[i] ? html`<td data-label="${headers[i]}">${c}</td>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
}

/** A problem as returned by Network, Events or Media — shown as it came, never softened. */
function problemBox(p, { title = 'The request failed' } = {}) {
    if (!p) return '';
    return html`<div class="problem" role="alert"><strong>${title}</strong>
<p>${p.detail || 'No detail was given.'}</p>
<p class="muted small">HTTP ${p.status || '—'} · <code>${p.code || 'unknown'}</code>${p.requestId ? html` · request <code>${p.requestId}</code>` : ''}</p></div>`;
}

const notice = (text, kind = 'info') => html`<div class="notice ${kind}" role="status">${text}</div>`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

module.exports = { esc, html, raw, Raw, render, code, time, dayText, table, problemBox, notice, csrfField, badge };
