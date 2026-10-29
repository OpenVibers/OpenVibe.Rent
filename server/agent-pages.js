'use strict';
// The Markdown twins of the public pages served by this process (openvibe-shared/agent-layer): OpenVibe.Rent's
// home, everywhere, housing, the listings search and one listing, the safety note and the update log; and
// OpenVibe.Homes' home, place search, county records, mortgage calculator, homes by state and city, and update log.
//
// A twin is the page's own render: the host's page router answers the request in-process, signed out, so a twin
// cannot drift from the page a browser gets and never carries a signed-in person's view. A page behind a person
// (posting, a listing's edit form, the board, saved searches, the staff queue) or a missing listing has no twin.
const RENT_TWIN_PATH_RE = /^\/(?:everywhere|housing|listings(?:\/[^/]+)?|safety|updates)?$/;
const HOMES_TWIN_PATH_RE = /^\/(?:search|records|mortgage|updates|in(?:\/[^/]+(?:\/[^/]+)?)?)?$/;

/** A request as an anonymous browser makes it: no session, no cookies. */
function anonymousRequest(path, query, host) {
    const search = query && query.toString() ? `?${query.toString()}` : '';
    const url = `${path}${search}`;
    return {
        method: 'GET', url, originalUrl: url, path, params: {}, query: query ? Object.fromEntries(query) : {},
        headers: { accept: 'text/html', host }, cookies: {}, body: undefined, protocol: 'https', secure: true,
        ip: '127.0.0.1', ips: ['127.0.0.1'], hostname: host,
        get(name) { return this.headers[String(name || '').toLowerCase()] || ''; },
        accepts(types) {
            if (!Array.isArray(types)) return 'text/html';
            return types.some((t) => t === 'html' || t === 'text/html') ? 'html' : false;
        },
        is() { return false; },
    };
}

/** A response that keeps what the page wrote, so the twin can be built from it. */
function captureResponse() {
    return {
        statusCode: 200, headers: {}, body: null, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[String(name)] = value; return this; },
        setHeader(name, value) { this.headers[String(name)] = value; return this; },
        getHeader(name) { return this.headers[String(name)]; },
        get(name) { return this.headers[String(name)]; },
        removeHeader(name) { delete this.headers[String(name)]; },
        type(value) { this.headers['Content-Type'] = value === 'html' ? 'text/html; charset=utf-8' : String(value); return this; },
        location(url) { this.headers.Location = url; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        json(body) { this.body = JSON.stringify(body); this.headersSent = true; return this; },
        redirect(code, url) { this.statusCode = code; this.headers.Location = url; this.body = ''; this.headersSent = true; return this; },
        end(body) { if (body !== undefined) this.body = body; this.headersSent = true; return this; },
        cookie() { return this; }, clearCookie() { return this; },
    };
}

function createAgentPages({ router, host, site }) {
    const twinPathRe = site === 'homes' ? HOMES_TWIN_PATH_RE : RENT_TWIN_PATH_RE;

    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!twinPathRe.test(p)) return null;
        const req = anonymousRequest(p, query, host);
        req.viewer = { kind: 'anonymous' };
        const res = captureResponse();
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            const send = res.send.bind(res);
            res.send = (body) => { send(body); finish(); return res; };
            const redirect = res.redirect.bind(res);
            res.redirect = (code, url) => { redirect(code, url); finish(); return res; };
            try { router(req, res, () => finish()); } catch { finish(); }
            const timer = setTimeout(finish, 10000);
            if (timer.unref) timer.unref();
        });
        // A page that needs a person, a missing listing or company, or a page that is not public has no twin.
        if (res.statusCode !== 200 || res.body == null) return null;
        const html = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        if (!/^text\/html/i.test(String(res.headers['Content-Type'] || ''))) return null;
        return { html };
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, RENT_TWIN_PATH_RE, HOMES_TWIN_PATH_RE };
