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

  // A case id as people read it: no repeated "case-" prefix, and a long
  // UUID cut to its first block (the full id is on the case page).
  function shortId(id) {
    var s = String(id || '').replace(/^case-/i, '');
    return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s) ? s.slice(0, 8) : s;
  }

  // "Vendor · 2 min ago" with each part kept whole when the line wraps.
  function metaLine(parts) {
    return parts.filter(Boolean).map(function (p) { return '<span class="nowrap">' + esc(p) + '</span>'; }).join(' · ');
  }

  function fmtDuration(fromIso, toIso) {
    if (!fromIso || !toIso) return '—';
    var s = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }


  // "1433 minutes" reads as a bug; people read hours and minutes.
  function fmtRemaining(ms) {
    if (!(ms > 0)) return '0 min';
    var mins = Math.floor(ms / 60000);
    if (mins >= 60) return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min';
    if (mins >= 1) return mins + ' min ' + (Math.floor(ms / 1000) % 60) + ' s';
    return Math.ceil(ms / 1000) + ' s';
  }

  // Workflow decision codes, in words.
  var DECISION = {
    auto_approved: 'Auto-approved', auto_approve: 'Auto-approved', approved: 'Approved',
    approved_with_overrides: 'Approved with overrides', partially_approved: 'Partially approved',
    held_for_query: 'Held for vendor query', held: 'Held', on_hold: 'On hold', rejected: 'Rejected', disputed: 'Disputed'
  };
  function decisionLabel(v) {
    if (v === null || v === undefined || v === '') return null;
    var k = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (DECISION[k]) return DECISION[k];
    var t = String(v).replace(/_/g, ' ').toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Workflow prose, made to read like a person wrote it: no "item(s)", no
  // em dashes between clauses, no "(—)" for a value that is missing.
  // The workflow was first built for one client and still names it in a few
  // strings; this console is shown to others, so the name is dropped on screen.
  function brandFree(text) {
    return typeof text === 'string' ? text.replace(/\bMAF(?:[_ ]+|(?=\b))/g, '').replace(/ {2,}/g, ' ') : text;
  }

  function tidyText(text) {
    if (typeof text !== 'string') return text;
    return brandFree(text)
      .replace(/\s*\((?:—|–|-)\)/g, '')
      .replace(/(\d+(?:\.\d+)?)(\s+[A-Za-z][A-Za-z ]{0,30}?)\(s\)/g, function (m, n, word) { return n + word + (Number(n) === 1 ? '' : 's'); })
      .replace(/([A-Za-z])\(s\)/g, '$1s')
      .replace(/\s+[—–]\s+(?=[A-Za-z0-9])/g, ', ')
      .replace(/,\s*,/g, ',');
  }

  var STATUS = {
    IN_PROGRESS: ['Processing', 'info'],
    PENDING: ['Queued', 'info'],
    WAITING: ['Processing', 'info'],
    UNKNOWN: ['Processing', 'info'],
    WAITING_REVIEW: ['Awaiting approval', 'warn'],
    COMPLETED: ['Completed', 'ok'],
    FAILED: ['Did not finish', 'bad'],
    TIMED_OUT: ['Timed out', 'bad'],
    CANCELLED: ['Cancelled', 'bad'],
  };

  function statusPill(status) {
    var s = STATUS[status] || [status || 'Unknown', ''];
    return '<span class="pill ' + s[1] + '">' + esc(s[0]) + '</span>';
  }

  // A finished invoice that was held reads "Held" everywhere, not "Completed".
  function casePill(c) {
    var s = (c && c.summary) || {};
    if (c && c.status === 'COMPLETED' && (s.displayNote === 'held' || (typeof s.heldAmount === 'number' && s.heldAmount > 0 && !(s.amount > 0)))) return '<span class="pill bad">Held</span>';
    if (c && c.status === 'COMPLETED' && typeof s.heldAmount === 'number' && s.heldAmount > 0) return '<span class="pill warn">Part held</span>';
    return statusPill(c && c.status);
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
    var lines = tidyText(String(src)).replace(/\r\n?/g, '\n').split('\n');
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
    if (DECISION[s]) return esc(DECISION[s]);
    if (/^[a-z]+(_[a-z]+)+$/.test(s)) return esc(humanKey(s));
    s = tidyText(s);
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
      // Internal flags from the brief's builder ("rendered ok", an empty
      // "error") mean nothing to a reader.
      var keys = Object.keys(v).filter(function (k) {
        if (/^render(ed)?_?ok$/i.test(k)) return false;
        if (/^errors?$/i.test(k) && (v[k] === null || v[k] === '' || v[k] === false || (Array.isArray(v[k]) && !v[k].length))) return false;
        return true;
      });
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
    raw = brandFree(raw);
    return '<div class="jv">' + jsonView(v, 0) + '</div>' +
      (v && typeof v === 'object' && window.AP.me && window.AP.me.user.role === 'admin' ? '<details class="raw"><summary>Show raw JSON</summary><pre>' + esc(raw) + '</pre></details>' : '');
  }

  // ---------- chrome: the left rail ----------

  var ICONS = {
    overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="4.5" rx="1.6"/><rect x="13.5" y="11" width="7" height="9.5" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/>',
    submit: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    cases: '<path d="M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8h4.5M9 12.5h6M9 16h6"/>',
    reviews: '<path d="M9 11.5l2 2 4-4.5"/><rect x="4" y="4" width="16" height="16" rx="3"/>',
    vendors: '<path d="M4 20V9.5L12 5l8 4.5V20"/><path d="M9 20v-5.5h6V20M3 20h18"/>',
    orders: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5V6h6V3.5M8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
    payments: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 14.5h3"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-2.6-4.4"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
    support: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.5M12 16.8v.1"/>',
    signout: '<path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>',
    chevron: '<path d="M15 6l-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  };

  function icon(name) {
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // The product's own mark: a ledger page with a tick, in the brand colour.
  var PRODUCT = { name: 'Payables Hub', unit: 'Finance Shared Services', company: 'Harbourline Group' };
  function productMark(size) {
    size = size || 28;
    return '<svg class="product-mark" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true">' +
      '<rect width="32" height="32" rx="8" fill="var(--brand)"/>' +
      '<path d="M10 8.5h8.5l4 4V23a1.5 1.5 0 0 1-1.5 1.5H10A1.5 1.5 0 0 1 8.5 23V10A1.5 1.5 0 0 1 10 8.5z" fill="none" stroke="var(--on-brand)" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<path d="M12.5 17.5l2.4 2.4 4.6-5" fill="none" stroke="var(--on-brand)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // What each role sees, grouped the way a finance system is: the payables
  // work first, then the neighbouring records it reads from (read only),
  // then reporting and administration.
  function navGroups(user) {
    var r = user.role;
    var related = { title: 'Suppliers & payments', note: 'Read only', links: [
      { href: '/vendors.html', label: 'Vendors', key: 'vendors', icon: 'vendors', ro: true },
      { href: '/orders.html', label: 'Purchase orders', key: 'orders', icon: 'orders', ro: true },
      { href: '/payments.html', label: 'Payment run', key: 'payments', icon: 'payments', ro: true }
    ] };
    var insights = { title: 'Insights', links: [{ href: '/report.html', label: 'Reports', key: 'report', icon: 'report' }] };
    if (r === 'clerk') return [
      { title: 'Payables', links: [
        { href: '/overview.html', label: 'Overview', key: 'overview', icon: 'overview' },
        { href: '/submit.html', label: 'New submission', key: 'submit', icon: 'submit' },
        { href: '/', label: 'My invoices', key: 'cases', icon: 'cases' }
      ] }, related, insights,
      { title: 'Account', links: [{ href: '/settings.html', label: 'Settings', key: 'settings', icon: 'settings' }] }
    ];
    if (r === 'approver') return [
      { title: 'Payables', links: [
        { href: '/reviews.html', label: 'Approvals', key: 'reviews', icon: 'reviews', badge: true },
        { href: '/overview.html', label: 'Overview', key: 'overview', icon: 'overview' },
        { href: '/', label: 'Invoices', key: 'cases', icon: 'cases' }
      ] }, related, insights,
      { title: 'Account', links: [{ href: '/settings.html', label: 'Settings', key: 'settings', icon: 'settings' }] }
    ];
    return [
      { title: 'Payables', links: [
        { href: '/overview.html', label: 'Overview', key: 'overview', icon: 'overview' },
        { href: '/', label: 'Invoices', key: 'cases', icon: 'cases' },
        { href: '/submit.html', label: 'New submission', key: 'submit', icon: 'submit' },
        { href: '/reviews.html', label: 'Approvals', key: 'reviews', icon: 'reviews', badge: true }
      ] }, related, insights,
      { title: 'Administration', links: [
        { href: '/users.html', label: 'Users', key: 'users', icon: 'users' },
        { href: '/settings.html', label: 'Settings', key: 'settings', icon: 'settings' }
      ] }
    ];
  }

  // ---------- Report a problem ----------
  // One button everywhere. It writes the email for the person: the failure
  // reason, the process, org, execution and case ids, and it offers a
  // screenshot of the page to attach (a mailto link cannot attach files).

  var supportContext = null; // a page may register function () -> Promise<details>
  function setSupportContext(fn) { supportContext = fn; }

  function baseDetails(me) {
    var s = me.support || {};
    return { workflowId: s.workflowId, orgId: s.orgId || null };
  }

  function line(label, value) { return value ? label + ': ' + value : null; }

  function supportEmail(me, d, shotName) {
    var subject = PRODUCT.name + (d.caseId ? ' – case ' + d.caseId : '') +
      (d.failed ? ' did not finish' + (d.failedAt ? ' at ' + d.failedAt : '') : d.status ? ' (' + d.status.toLowerCase().replace(/_/g, ' ') + ')' : ', question');
    var parts = [
      'Hello support team,', '',
      d.reason ? 'What went wrong: ' + d.reason : 'Describe the issue here:',
      d.failedAt ? 'Stopped at step: ' + d.failedAt : null,
      d.warnings && d.warnings.length ? 'Messages from the document readers:\n' + d.warnings.map(function (w) { return '  - ' + w; }).join('\n') : null,
      '',
      line('Workflow ID', d.workflowId ? d.workflowId + (d.workflowVersion ? ' (version ' + d.workflowVersion + ')' : '') : null),
      'Org ID: ' + (d.orgId || 'not set'),
      d.workspace ? 'Workspace ID: ' + d.workspace.id : null,
      line('Execution ID', d.executionId),
      line('Execution reference ID', d.executionReferenceId),
      line('Case ID', d.caseId ? d.caseId + (d.reference ? ' (reference ' + d.reference + ')' : '') : null),
      line('Review execution ID', d.reviewExecutionId),
      line('Status', d.status),
      line('Submitted', d.submittedAt ? new Date(d.submittedAt).toISOString() + (d.submittedBy ? ' by ' + d.submittedBy : '') : null),
      line('Finished', d.finishedAt ? new Date(d.finishedAt).toISOString() : null),
      '',
      'Reported by: ' + me.user.name + ' <' + me.user.email + '>',
      'Page: ' + location.href,
      'When: ' + new Date().toISOString(),
      shotName ? 'Screenshot: attached (' + shotName + ')' : 'Screenshot: please see attachment',
    ].filter(function (x) { return x !== null; });
    var body = parts.join('\n');
    if (body.length > 1800) body = body.slice(0, 1790) + '\n…';
    return 'mailto:' + ((me.support && me.support.email) || '') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.html2canvas) return resolve();
      var sc = document.createElement('script');
      sc.src = src; sc.onload = resolve; sc.onerror = function () { reject(new Error('Screenshot tool could not load.')); };
      document.head.appendChild(sc);
    });
  }

  function takeScreenshot(name) {
    document.body.classList.remove('nav-open');
    return loadScript('/vendor/html2canvas.min.js').then(function () {
      return window.html2canvas(document.body, {
        scale: Math.min(2, window.devicePixelRatio || 1),
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        ignoreElements: function (el) { return el.id === 'support-modal' || el.classList.contains('side-scrim') || el.id === 'chart-tip'; },
        windowWidth: document.documentElement.clientWidth,
      });
    }).then(function (canvas) {
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
          resolve();
        }, 'image/png');
      });
    });
  }

  function openSupport() {
    var me = window.AP.me;
    if (!me) return;
    var old = document.getElementById('support-modal');
    if (old) old.remove();
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.id = 'support-modal';
    back.innerHTML = '<div class="modal support-modal" role="dialog" aria-modal="true" aria-labelledby="support-title">' +
      '<h2 id="support-title">Report a problem</h2>' +
      '<p class="muted small" style="margin:-6px 0 14px">The email to the support team is written for you, with the technical details they need. A mailto link cannot attach files, so download the screenshot first and attach it to the email.</p>' +
      '<dl class="kv" id="support-details"><dt>Details</dt><dd>Gathering…</dd></dl>' +
      '<div class="alert bad" id="support-error" hidden style="margin-top:12px"></div>' +
      '<div class="support-steps">' +
        '<button type="button" class="btn" id="support-shot"><span class="step-n">1</span>Download screenshot</button>' +
        '<a class="btn primary" id="support-mail" href="#"><span class="step-n">2</span>Open email</a>' +
      '</div>' +
      '<div class="actions"><button type="button" class="btn small" id="support-copy">Copy details</button><button type="button" class="btn small" id="support-close">Close</button></div>' +
      '</div>';
    document.body.appendChild(back);
    var close = function () { back.remove(); };
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.getElementById('support-close').addEventListener('click', close);
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });

    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    var details = baseDetails(me);
    var shotName = 'payables-hub-' + stamp + '.png';
    var mail = document.getElementById('support-mail');

    function render(d) {
      details = d;
      shotName = 'payables-hub-' + (d.caseId ? 'case-' + d.caseId + '-' : '') + stamp + '.png';
      // The technical ids (workflow, org, execution) go in the email only.
      var rows = [
        ['What went wrong', d.reason], ['Stopped at', d.failedAt],
        ['Invoice', d.reference], ['Case', d.caseId ? shortId(d.caseId) : null],
      ].filter(function (r) { return r[1]; });
      if (!rows.length) rows.push(['Details', 'Describe the problem in the email. The technical details support needs are added for you.']);
      document.getElementById('support-details').innerHTML = rows.map(function (r) {
        var v = String(r[1]);
        return '<dt>' + esc(r[0]) + '</dt><dd' + (r[0] === 'Case' ? ' class="mono"' : '') + '>' + esc(v) + '</dd>';
      }).join('');
      mail.href = supportEmail(me, d, shotName);
    }
    render(details);
    (supportContext ? supportContext() : Promise.resolve(null)).then(function (d) {
      if (d) render(Object.assign({}, details, d));
    }, function (err) { AP.showError(document.getElementById('support-error'), err); });

    document.getElementById('support-shot').addEventListener('click', function () {
      var b = this;
      b.disabled = true;
      var label = b.innerHTML;
      b.textContent = 'Capturing…';
      takeScreenshot(shotName).then(function () {
        b.innerHTML = '<span class="step-n">✓</span>Screenshot saved';
        b.disabled = false;
      }, function (err) {
        b.innerHTML = label;
        b.disabled = false;
        AP.showError(document.getElementById('support-error'), new Error(err.message + ' Use your own screenshot tool instead.'));
      });
    });
    document.getElementById('support-copy').addEventListener('click', function () {
      var text = decodeURIComponent(mail.href.split('&body=')[1] || '');
      var b = this;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { b.textContent = 'Copied'; }, function () { b.textContent = 'Copy failed'; });
    });
  }

  // ---------- chrome: the sidebar ----------
  // Open and labelled by default. On a wide screen the chevron folds it to
  // an icon strip (remembered); on a narrow screen it is a drawer behind the
  // menu button in the top bar.

  var SIDE_KEY = 'ph-sidebar';
  function setCollapsed(next) {
    document.body.classList.toggle('side-collapsed', Boolean(next));
    var t = document.getElementById('side-toggle');
    if (t) {
      t.setAttribute('aria-expanded', next ? 'false' : 'true');
      t.setAttribute('aria-label', next ? 'Expand the menu' : 'Collapse the menu');
      t.title = next ? 'Expand the menu' : 'Collapse the menu';
    }
    try { localStorage.setItem(SIDE_KEY, next ? 'collapsed' : 'open'); } catch (e) { /* private window */ }
  }
  function setDrawer(open) {
    document.body.classList.toggle('nav-open', Boolean(open));
    var m = document.getElementById('menu-btn');
    if (m) m.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderChrome(me, active) {
    var user = me.user;
    document.body.classList.add('has-sidebar');
    var scrim = document.createElement('div');
    scrim.className = 'side-scrim';
    document.body.appendChild(scrim);

    var top = document.createElement('header');
    top.className = 'topbar';
    top.innerHTML = '<button type="button" class="icon-btn" id="menu-btn" aria-controls="sidebar" aria-expanded="false" aria-label="Open the menu">' + icon('menu') + '</button>' +
      '<a class="topbar-brand" href="' + esc(me.home || '/') + '">' + productMark(24) + '<span>' + PRODUCT.name + '</span></a>';
    document.body.insertBefore(top, document.body.firstChild);

    var rail = document.createElement('aside');
    rail.className = 'sidebar';
    rail.id = 'sidebar';
    rail.setAttribute('aria-label', 'Main');
    rail.innerHTML =
      '<div class="side-head">' +
        '<a class="brand-lockup" href="' + esc(me.home || '/') + '" title="' + PRODUCT.name + '">' + productMark(28) +
          '<span class="label">' + PRODUCT.name + '<small>' + PRODUCT.unit + '</small></span></a>' +
        '<button type="button" class="side-toggle" id="side-toggle" aria-expanded="true" aria-label="Collapse the menu" title="Collapse the menu">' + icon('chevron') + '</button>' +
        '<button type="button" class="side-close icon-btn" id="side-close" aria-label="Close the menu">' + icon('close') + '</button>' +
      '</div>' +
      '<nav class="side-nav">' + navGroups(user).map(function (g) {
        return '<div class="nav-group"><p class="nav-title"><span>' + esc(g.title) + '</span>' + (g.note ? '<span class="nav-note">' + esc(g.note) + '</span>' : '') + '</p>' +
          g.links.map(function (l) {
            return '<a href="' + l.href + '"' + (l.key === active ? ' aria-current="page"' : '') + ' title="' + esc(l.label + (l.ro ? ' (read only)' : '')) + '">' + icon(l.icon) +
              '<span class="label">' + esc(l.label) + '</span>' + (l.badge ? '<span class="badge-count" id="review-badge" hidden></span>' : '') + '</a>';
          }).join('') + '</div>';
      }).join('') + '</nav>' +
      '<div class="side-foot">' +
        '<button type="button" class="side-link" id="theme-toggle" title="Switch light or dark">' + icon('theme') + '<span class="label">Light / dark</span></button>' +
        '<button type="button" class="side-link" id="support-btn" title="Report a problem">' + icon('support') + '<span class="label">Report a problem</span></button>' +
        '<div class="side-account" title="' + esc(user.name + ', ' + (ROLE_LABEL[user.role] || user.role)) + '"><span class="avatar">' + esc((user.name || user.email || '?').charAt(0).toUpperCase()) + '</span>' +
          '<span class="label"><span class="account-name">' + esc(user.name) + '</span><span class="account-role">' + esc(ROLE_LABEL[user.role] || user.role) + '</span></span></div>' +
        '<button type="button" class="side-out" id="logout-btn" title="Sign out">' + icon('signout') + '<span class="label">Sign out</span></button>' +
      '</div>';
    document.body.insertBefore(rail, top.nextSibling);

    if (me.setupWarnings && me.setupWarnings.length) {
      var b = document.createElement('div');
      b.className = 'setup-banner';
      b.innerHTML = '<div class="inner"><strong>Setup incomplete.</strong> Part of the connection to the matching service is not configured yet, so some features may not work. Ask IT to check the system settings.</div>';
      var main = document.querySelector('main');
      if (main) main.parentNode.insertBefore(b, main);
    }

    var footer = document.createElement('footer');
    footer.className = 'footer';
    footer.innerHTML = '<span><b>' + PRODUCT.name + '</b> · ' + PRODUCT.unit + ' · ' + PRODUCT.company + '</span>';
    document.body.appendChild(footer);

    var saved = false;
    try { saved = localStorage.getItem(SIDE_KEY) === 'collapsed'; } catch (e) { /* ignore */ }
    setCollapsed(saved);
    document.getElementById('side-toggle').addEventListener('click', function () { setCollapsed(!document.body.classList.contains('side-collapsed')); });
    document.getElementById('menu-btn').addEventListener('click', function () { setDrawer(true); });
    document.getElementById('side-close').addEventListener('click', function () { setDrawer(false); });
    scrim.addEventListener('click', function () { setDrawer(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });

    document.getElementById('support-btn').addEventListener('click', function () { setDrawer(false); openSupport(); });
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
        location.href = me.home || '/';
        return;
      }
      window.AP.me = me;
      renderChrome(me, options.active);
      document.body.classList.remove('booting');
      onReady(me.user, me);
    }, function (err) {
      document.body.classList.remove('booting');
      var main = document.querySelector('main');
      if (main) main.innerHTML = '<div class="alert bad"><strong>Could not load the page.</strong>' + esc(err.message) + '</div>';
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
    esc: esc, api: api, shortId: shortId, metaLine: metaLine, boot: boot, fmtDate: fmtDate, fmtAgo: fmtAgo, fmtDuration: fmtDuration,
    statusPill: statusPill, casePill: casePill, statusBucket: statusBucket, markdown: markdown, renderValue: renderValue,
    humanKey: humanKey, showError: showError, qs: qs, ROLE_LABEL: ROLE_LABEL, refreshReviewBadge: refreshReviewBadge,
    icon: icon, openSupport: openSupport, setSupportContext: setSupportContext, productMark: productMark, PRODUCT: PRODUCT,
    fmtRemaining: fmtRemaining, decisionLabel: decisionLabel, tidyText: tidyText, brandFree: brandFree,
  };
})();
