'use strict';

/**
 * /board — the listings a person keeps from any site (server/board/board.js), as pages that work without JavaScript:
 * an add form (prefilled from ?url=&title= when the bookmarklet or the OpenVibe Companion extension opens it from a
 * listing's page), the listings grouped by how far the person got, and a form per listing to move, edit or remove it.
 *
 * The listing's link opens its own site in a new tab; OpenVibe.Rent never fetches it. The forms take the API's
 * budget (rent.board.write) and its same-origin rule, through pages.js's budgeted() and sameSite().
 */
const showcase = require('openvibe-shared/showcase');
const { html, raw, notice, time } = require('../render/html');
const listings = require('../listings/listings');
const board = require('../board/board');

/** The order the groups show in: what still needs doing first, the finished ones last. */
const GROUP_ORDER = ['interested', 'contacted', 'viewing', 'applied', 'rented', 'declined'];
const GROUP_TITLE = { interested: 'Interested', contacted: 'Contacted', viewing: 'Viewing booked', applied: 'Applied', rented: 'Rented', declined: 'Not for me' };

function mountBoardPages(r, { config, s, page, signedIn, requesterOf, mustSignIn, budgeted, sameSite, signInPrompt }) {
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const crumbs = [{ label: 'Home', href: '/' }, { label: 'Your board' }];
    const str = (v, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : '');

    /** The bookmarklet: opens this page with the listing the person is looking at. Shown as text to copy, never as a javascript: link. */
    const bookmarklet = () => `javascript:(()=>{open('${base()}/board?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title.slice(0,200)))})()`;

    const priceOf = (row) => (row.price == null ? null : listings.priceText({ price: row.price, currency: row.currency || 'USD', period: row.period || 'month' }));
    const periodOptions = (selected) => listings.PERIODS.map((p) => html`<option value="${p}"${p === (selected || 'month') ? raw(' selected') : ''}>${listings.PERIOD_TEXT[p]}</option>`);

    /** The add form, and the edit form inside each listing: the same fields, `id` keeps their labels apart. */
    function fields(v = {}, id = 'bd') {
        return html`<div class="field"><label for="${id}-url">Link to the listing</label>
<input id="${id}-url" name="url" type="url" inputmode="url" required maxlength="${board.LIMITS.url}" placeholder="https://…" value="${v.url || ''}"></div>
<div class="field"><label for="${id}-title">Title</label>
<input id="${id}-title" name="title" type="text" maxlength="${board.LIMITS.title}" placeholder="2-bed near the park, the one with the yard" value="${v.title || ''}"></div>
<div class="field-row">
<div class="field"><label for="${id}-price">Price</label><input id="${id}-price" name="price" type="text" inputmode="decimal" maxlength="16" placeholder="1450" value="${v.price == null ? '' : v.price}"></div>
<div class="field"><label for="${id}-period">Per</label><select id="${id}-period" name="period">${periodOptions(v.period)}</select></div>
</div>
<div class="field"><label for="${id}-place">Where</label><input id="${id}-place" name="place" type="text" maxlength="${board.LIMITS.place}" placeholder="Neighbourhood or city" value="${v.place || ''}"></div>
<div class="field"><label for="${id}-notes">Notes</label>
<textarea id="${id}-notes" name="notes" rows="3" maxlength="${board.LIMITS.notes}" placeholder="Who you talked to, when you can see it, what to ask">${v.notes || ''}</textarea></div>`;
    }

    function addForm(v, { fromPage = false } = {}) {
        return html`<section class="sc-sec bd-add${fromPage ? ' bd-add-from' : ''}" aria-labelledby="h-add">
<h2 id="h-add">${fromPage ? 'Keep this listing' : 'Keep a listing'}</h2>
${fromPage ? html`<p class="muted">From the page you were on${v.site ? html` on <b>${board.siteName(v.site)}</b>` : ''}. Add what you want to remember, then keep it.</p>` : html`<p class="muted">Paste the link to a listing on any site: Craigslist, Facebook Marketplace, Zillow, Apartments.com or anywhere else.</p>`}
<form class="search-form" method="post" action="/board">
${fields(v)}
<p><button class="sc-btn sc-primary" type="submit">Keep it on my board</button>${fromPage ? html` <a class="sc-btn" href="/board">Not now</a>` : ''}</p>
</form></section>`;
    }

    function item(row) {
        const price = priceOf(row);
        const statusId = `st-${row.id}`;
        return html`<li class="bd-item" id="${row.id}">
<div class="bd-head"><a class="bd-title" href="${row.url}" target="_blank" rel="noopener nofollow ugc">${row.title}<span class="bd-out" aria-hidden="true"> ↗</span></a>${price ? html`<b class="bd-price">${price}</b>` : ''}</div>
<div class="bd-meta"><span class="chip">${board.siteName(row.site)}</span>${row.place ? html`<span class="chip">${row.place}</span>` : ''}<span class="small muted">kept ${time(row.created_at)}${row.updated_at !== row.created_at ? html` · changed ${time(row.updated_at)}` : ''}</span></div>
${row.notes ? html`<p class="txt bd-notes">${row.notes}</p>` : ''}
<div class="bd-actions">
<form class="inline bd-move" method="post" action="/board/${row.id}"><label class="sr-only" for="${statusId}">Where you are with it</label><select id="${statusId}" name="status">${board.STATUSES.map((st) => html`<option value="${st}"${st === row.status ? raw(' selected') : ''}>${board.STATUS_TEXT[st]}</option>`)}</select> <button class="sc-btn" type="submit">Move</button></form>
<form class="inline" method="post" action="/board/${row.id}/delete"><button class="sc-btn" type="submit">Remove</button></form>
</div>
<details class="bd-edit"><summary>Edit the details</summary>
<form class="search-form" method="post" action="/board/${row.id}">${fields({ ...row, price: row.price == null ? '' : Number(row.price) }, `ed-${row.id}`)}
<p><button class="sc-btn sc-primary" type="submit">Save</button></p></form></details>
</li>`;
    }

    async function boardPage(req, res, { values = null, error = null, status = 200 } = {}) {
        const fromQuery = req.method === 'GET' && str(req.query.url) ? { url: str(req.query.url), title: str(req.query.title, 200), price: str(req.query.price, 16), place: str(req.query.place, 120) } : null;
        if (fromQuery) fromQuery.site = board.siteOf(fromQuery.url);
        if (!signedIn(req)) {
            return page(req, res, {
                title: 'Your board', crumbs, styles: [showcase.STYLESHEET], localStyles: ['css/board.css'],
                body: html`<h1>Your board</h1>
<p class="sc-lede">Keep the listings you find on any site in one list, with your notes and how far you got: interested, contacted, viewing booked, applied.</p>
${signInPrompt(fromQuery ? 'Sign in to keep this listing on your board.' : 'Your board belongs to your OpenVibe account.', req.originalUrl.slice(0, 1500))}`,
            }, 401);
        }
        const rows = await board.list(s, requesterOf(req));
        const groups = GROUP_ORDER.map((st) => ({ st, rows: rows.filter((x) => x.status === st) })).filter((g) => g.rows.length);
        const v = values || fromQuery || {};
        return page(req, res, {
            title: 'Your board', crumbs, styles: [showcase.STYLESHEET], localStyles: ['css/board.css'],
            body: html`<h1>Your board</h1>
<p class="sc-lede">The listings you found on any site, in one list: the link to each on its own site, your notes and how far you got. The listing, the messages and any payment stay on that site.</p>
${error ? notice(error, 'warn') : ''}
${fromQuery || error ? addForm(v, { fromPage: Boolean(fromQuery) }) : ''}
${rows.length ? html`<nav class="bd-summary" aria-label="Your board by status">${groups.map((g) => html`<a class="bd-tab" href="#g-${g.st}">${GROUP_TITLE[g.st]} <b>${g.rows.length}</b></a>`)}</nav>
${groups.map((g) => html`<section class="sc-sec" aria-labelledby="g-${g.st}"><h2 id="g-${g.st}">${GROUP_TITLE[g.st]} <span class="muted">${g.rows.length}</span></h2>
<ul class="bd-list">${g.rows.map(item)}</ul></section>`)}
<p class="small muted">${rows.length} of the ${board.MAX_ITEMS} listings a board holds.</p>`
        : html`<div class="bd-empty"><p><b>Nothing on your board yet.</b></p><p class="muted"><a href="/everywhere">Search every rental site</a>, open a listing on its own site, and keep it here with its link.</p></div>`}
${fromQuery || error ? '' : addForm(v)}
<section class="sc-sec" aria-labelledby="h-bm"><h2 id="h-bm">Keep listings from any site in one click</h2>
<p>Make a new bookmark in your browser and paste this as its address (URL). On a listing's page, open the bookmark: this page opens with the listing's link and title filled in.</p>
<label class="sr-only" for="bd-bookmarklet">The bookmark's address</label>
<textarea id="bd-bookmarklet" class="bd-code" rows="3" readonly spellcheck="false">${bookmarklet()}</textarea>
<p class="small muted">It sends only the page's address and title to ${base().replace(/^https?:\/\//, '')}, and only when you open it.</p></section>`,
        }, status);
    }

    r.get('/board', (req, res) => boardPage(req, res));

    r.post('/board', mustSignIn('/board'), budgeted('rent.board.write'), async (req, res) => {
        if (!sameSite(req, res, '/board')) return undefined;
        const v = board.validate(req.body || {});
        if (!v.ok) return boardPage(req, res, { values: req.body || {}, error: v.detail, status: 422 });
        const out = await board.save(s, requesterOf(req), v.item);
        if (!out.ok) return boardPage(req, res, { values: req.body || {}, error: out.detail, status: 409 });
        return res.redirect(303, `/board#${out.row.id}`);
    });

    r.post('/board/:id', mustSignIn('/board'), budgeted('rent.board.write'), async (req, res) => {
        if (!sameSite(req, res, '/board')) return undefined;
        const id = String(req.params.id || '');
        const row = board.isItemId(id) ? await board.get(s, id) : null;
        if (!row || row.subject !== requesterOf(req)) return res.redirect(303, '/board');
        const body = req.body || {};
        const v = board.validate(body, { partial: true });
        if (!v.ok) return boardPage(req, res, { error: v.detail, status: 422 });
        if (v.item.url && v.item.url !== row.url && await s.db.maybe('SELECT id FROM rent_board_items WHERE subject = $1 AND url = $2', [row.subject, v.item.url])) {
            return boardPage(req, res, { error: 'That link is already on your board.', status: 409 });
        }
        await board.update(s, row.id, v.item);
        return res.redirect(303, `/board#${row.id}`);
    });

    r.post('/board/:id/delete', mustSignIn('/board'), budgeted('rent.board.write'), async (req, res) => {
        if (!sameSite(req, res, '/board')) return undefined;
        const id = String(req.params.id || '');
        if (board.isItemId(id)) await board.remove(s, id, requesterOf(req));
        return res.redirect(303, '/board');
    });
}

module.exports = { mountBoardPages, GROUP_ORDER };
