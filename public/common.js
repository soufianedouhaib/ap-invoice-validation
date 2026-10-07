/* Shared helpers and page chrome. Every page loads this first, then its own
   script, which calls AP.boot(options, onReady). */
(function () {
  'use strict';

  var THEME_KEY = 'ap-theme';
  try {
    var savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.setAttribute('data-theme', savedTheme);
  } catch (e) { /* storage unavailable */ }

  var ROLE_LABEL = { clerk: 'AP Clerk', approver: 'AP Approver', admin: 'Admin' };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Read as text first, then parse: a platform 413/502 returns an HTML page,
  // and the status code is what the user needs to see.
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'X-Requested-With': 'ap-console' };
    var body = opts.body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin' })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (res.status === 401 && !opts.allow401) {
            goLogin();
            throw new Error('Please sign in.');
          }
          if (!res.ok) {
            var msg = (data && data.error) || ('Request failed (' + res.status + (res.status === 413 ? ': file too large for the server' : '') + ').');
            var err = new Error(msg);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      });
  }

  function goLogin() {
    var here = location.pathname + location.search;
    location.href = '/login.html' + (here && here !== '/' && here.indexOf('login') === -1 ? '?next=' + encodeURIComponent(here) : '');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtAgo(iso) {
    if (!iso) return '—';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  function fmtDuration(fromIso, toIso) {
    if (!fromIso || !toIso) return '—';
    var s = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  var STATUS = {
    IN_PROGRESS: ['Processing', 'info'],
    PENDING: ['Queued', 'info'],
    WAITING: ['Processing', 'info'],
    UNKNOWN: ['Processing', 'info'],
    WAITING_REVIEW: ['Awaiting AP Approver', 'warn'],
    COMPLETED: ['Completed', 'ok'],
    FAILED: ['Failed', 'bad'],
    TIMED_OUT: ['Timed out', 'bad'],
    CANCELLED: ['Cancelled', 'bad'],
  };

  function statusPill(status) {
    var s = STATUS[status] || [status || 'Unknown', ''];
    return '<span class="pill ' + s[1] + '">' + esc(s[0]) + '</span>';
  }

  function statusBucket(status) {
    if (status === 'COMPLETED') return 'completed';
    if (status === 'WAITING_REVIEW') return 'review';
    if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED') return 'failed';
    return 'progress';
  }

  // ---------- minimal, escape-first Markdown renderer ----------

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  function markdown(src) {
    if (src === null || src === undefined) return '';
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    function isTableSep(l) { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l); }
    function cells(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { var lvl = Math.min(h[1].length + 1, 4); out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '</tbody></table></div>');
        continue;
      }
      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + markdown(q.join('\n')) + '</blockquote>');
        continue;
      }
      if (/^\s*([-*+▸•]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*+▸•]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+▸•]|\d+[.)])\s+/, ''));
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|([-*+▸•]|\d+[.)])\s+)/.test(lines[i]) &&
             !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  // ---------- readable view of an arbitrary JSON value ----------

  var ACRONYMS = { po: 'PO', gr: 'GR', id: 'ID', url: 'URL', vat: 'VAT', trn: 'TRN', sku: 'SKU', grn: 'GRN', iban: 'IBAN', aed: 'AED', usd: 'USD' };
  function humanKey(k) {
    var s = String(k).replace(/^workflow_(input|output)_/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    s = s.split(' ').map(function (w) { return ACRONYMS[w] || w; }).join(' ');
    return s.replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  function fmtNum(v) {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  function scalar(v) {
    if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return esc(fmtNum(v));
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !isNaN(new Date(s))) return '<span class="nowrap">' + esc(fmtDate(s)) + '</span>';
    if (/^[a-z]+(_[a-z]+)+$/.test(s)) return esc(humanKey(s));
    if (/^https?:\/\//.test(s)) return '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(s.length > 60 ? s.slice(0, 57) + '…' : s) + '</a>';
    return esc(s);
  }

  function jsonView(v, depth) {
    depth = depth || 0;
    if (typeof v === 'string') {
      var t = v.trim();
      if ((t.charAt(0) === '{' || t.charAt(0) === '[') && depth < 4) {
        try { return jsonView(JSON.parse(t), depth); } catch (e) { /* not JSON */ }
      }
      if (v.length > 140 || v.indexOf('\n') !== -1) return '<div class="md">' + markdown(v) + '</div>';
      return scalar(v);
    }
    if (Array.isArray(v)) {
      if (!v.length) return '<span class="muted">None</span>';
      var allObj = v.every(isPlainObj);
      if (allObj && depth < 4) {
        var cols = [];
        v.forEach(function (row) { Object.keys(row).forEach(function (k) { if (cols.indexOf(k) === -1) cols.push(k); }); });
        var simple = cols.length <= 8 && v.every(function (row) { return cols.every(function (k) { return row[k] === null || typeof row[k] !== 'object'; }); });
        if (simple) {
          var numCol = {};
          cols.forEach(function (k) { numCol[k] = v.every(function (row) { return row[k] === null || row[k] === undefined || typeof row[k] === 'number' || /^-?[\d,]+(\.\d+)?$/.test(String(row[k])); }); });
          return '<div class="table-wrap"><table><thead><tr>' + cols.map(function (k) { return '<th' + (numCol[k] ? ' class="num"' : '') + '>' + esc(humanKey(k)) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + v.map(function (row) {
              return '<tr>' + cols.map(function (k) { return '<td' + (numCol[k] ? ' class="num"' : '') + '>' + scalar(row[k]) + '</td>'; }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>';
        }
      }
      return '<div class="stack">' + v.map(function (x) { return '<div class="nest">' + jsonView(x, depth + 1) + '</div>'; }).join('') + '</div>';
    }
    if (isPlainObj(v)) {
      var keys = Object.keys(v);
      if (!keys.length) return '<span class="muted">Empty</span>';
      return '<dl>' + keys.map(function (k) {
        var val = v[k];
        var parsed = val;
        if (typeof val === 'string' && /^\s*[[{]/.test(val)) { try { parsed = JSON.parse(val); } catch (e) { parsed = val; } }
        var wide = (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object') || (isPlainObj(parsed) && Object.keys(parsed).length > 3) ||
          (typeof parsed === 'string' && (parsed.length > 140 || parsed.indexOf('\n') !== -1));
        var nested = parsed && typeof parsed === 'object';
        var cls = wide ? ' class="wide"' : '';
        return '<dt' + cls + '>' + esc(humanKey(k)) + '</dt><dd' + cls + '>' + (nested ? '<div class="nest">' + jsonView(parsed, depth + 1) + '</div>' : jsonView(parsed, depth + 1)) + '</dd>';
      }).join('') + '</dl>';
    }
    return scalar(v);
  }

  function renderValue(v) {
    var raw;
    try { raw = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch (e) { raw = String(v); }
    return '<div class="jv">' + jsonView(v, 0) + '</div>' +
      (v && typeof v === 'object' ? '<details class="raw"><summary>Show raw JSON</summary><pre>' + esc(raw) + '</pre></details>' : '');
  }

  // ---------- chrome ----------

  function navLinks(user) {
    var links = [{ href: '/', label: 'Cases', key: 'cases' }];
    if (user.role === 'clerk' || user.role === 'admin') links.push({ href: '/submit.html', label: 'New submission', key: 'submit' });
    if (user.role === 'approver' || user.role === 'admin') links.push({ href: '/reviews.html', label: 'Reviews', key: 'reviews', badge: true });
    if (user.role === 'admin') links.push({ href: '/users.html', label: 'Users', key: 'users' });
    links.push({ href: '/settings.html', label: 'Settings', key: 'settings' });
    return links;
  }

  function renderChrome(me, active) {
    var user = me.user;
    var header = document.createElement('header');
    header.className = 'topbar';
    header.innerHTML =
      '<div class="topbar-inner">' +
        '<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">AP</span><span>Invoice Validation</span></a>' +
        '<nav class="nav" aria-label="Main">' + navLinks(user).map(function (l) {
          return '<a href="' + l.href + '"' + (l.key === active ? ' class="active" aria-current="page"' : '') + '>' + esc(l.label) +
            (l.badge ? '<span class="badge-count" id="review-badge" hidden></span>' : '') + '</a>';
        }).join('') + '</nav>' +
        '<div class="userbox">' +
          '<div class="who"><strong>' + esc(user.name) + '</strong><span>' + esc(ROLE_LABEL[user.role] || user.role) + '</span></div>' +
          '<button class="icon-btn" type="button" id="theme-toggle" title="Switch light / dark" aria-label="Switch light or dark theme">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg></button>' +
          '<button class="btn small" type="button" id="logout-btn">Sign out</button>' +
        '</div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    if (me.setupWarnings && me.setupWarnings.length) {
      var b = document.createElement('div');
      b.className = 'setup-banner';
      b.innerHTML = '<div class="inner"><strong>Setup incomplete:</strong> missing ' + esc(me.setupWarnings.join(', ')) +
        '. <a href="/settings.html">See Settings</a>. Environment changes only apply after the next Vercel deploy.</div>';
      header.insertAdjacentElement('afterend', b);
    }

    var footer = document.createElement('footer');
    footer.className = 'site';
    footer.textContent = 'AP Invoice Validation console · runs the Opus “AP Invoice Validation” workflow';
    document.body.appendChild(footer);

    document.getElementById('logout-btn').addEventListener('click', function () {
      api('/api/logout', { method: 'POST', allow401: true }).then(function () { location.href = '/login.html'; }, function () { location.href = '/login.html'; });
    });
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    });

    if (user.role === 'approver' || user.role === 'admin') refreshReviewBadge();
  }

  function refreshReviewBadge() {
    var el = document.getElementById('review-badge');
    if (!el) return;
    api('/api/reviews').then(function (d) {
      var n = (d && d.pending ? d.pending.length : 0);
      el.textContent = n;
      el.hidden = n === 0;
    }, function () { /* leave as is */ });
  }

  // Every page: ask /api/me first and render nothing until it answers, so a
  // signed-out visitor never sees a flash of a screen they are about to lose.
  function boot(options, onReady) {
    document.body.classList.add('booting');
    api('/api/me', { allow401: true }).then(function (me) {
      if (!me || !me.user) return goLogin();
      if (options.roles && options.roles.indexOf(me.user.role) === -1) {
        location.href = '/';
        return;
      }
      renderChrome(me, options.active);
      document.body.classList.remove('booting');
      onReady(me.user, me);
    }, function (err) {
      document.body.classList.remove('booting');
      var main = document.querySelector('main');
      if (main) main.innerHTML = '<div class="alert bad"><strong>Could not load the console.</strong>' + esc(err.message) + '</div>';
    });
  }

  function showError(el, err) {
    if (!el) return;
    el.innerHTML = esc(err && err.message ? err.message : String(err));
    el.hidden = false;
  }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }

  window.AP = {
    esc: esc, api: api, boot: boot, fmtDate: fmtDate, fmtAgo: fmtAgo, fmtDuration: fmtDuration,
    statusPill: statusPill, statusBucket: statusBucket, markdown: markdown, renderValue: renderValue,
    humanKey: humanKey, showError: showError, qs: qs, ROLE_LABEL: ROLE_LABEL, refreshReviewBadge: refreshReviewBadge,
  };
})();
