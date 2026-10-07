/* Report: a ribbon of figures that stays put, and chapters that slide in
   beside it. Everyone has this page; what it covers is decided by the server
   (a clerk's own invoices, or every invoice for an approver or admin), and the
   scope comes back in the payload so the headings never claim more.

   Two series throughout, approved for payment and held back, in the brand
   blue and an orange. Never green against red. The pair was checked with the
   palette validator in both modes. Colour is never the only channel: every
   series is named in a legend, bars carry figures, and the time chapter has a
   table behind it. */
(function () {
  'use strict';

  var esc = AP.esc;
  var current = null;
  var chapter = 0;
  var me = null;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var TYPE_LABEL = {
    PRICE_VARIANCE: 'Unit price above PO', QTY_INVOICE_VS_PO: 'Quantity differs from PO', QTY_INVOICE_VS_GR: 'Billed more than received',
    GR_RECEIPT_SHORT: 'Goods receipt short of PO', HEADER_TOTAL_VARIANCE: 'Invoice total above PO', VAT_VARIANCE: 'VAT amount off',
    CURRENCY_MISMATCH: 'Currency mismatch', PO_CROSS_REF_MISMATCH: 'PO reference mismatch', VENDOR_NOT_ACTIVE: 'Vendor not active',
    VENDOR_NOT_FOUND: 'Vendor not in master', INPUT_PARSE_FAILED: 'Extractor output unreadable', DOCUMENT_UNREADABLE: 'Document could not be read',
    HEADER_TOTAL_MISSING: 'Total missing', LINE_NOT_ON_PO: 'Invoiced line not on PO', LINE_NOT_RECEIVED: 'Invoiced line not received',
    LINE_ITEMS_UNPAIRABLE: 'Line items could not be paired', MATCH_ENGINE_ERROR: '3-way match error'
  };
  function niceType(t) { return TYPE_LABEL[t] || (/^[A-Z0-9_]+$/.test(t) ? AP.humanKey(t) : t); }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function fill(root, slot) { return root.querySelector('[data-slot="' + slot + '"]'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

  // ------------------------------- numbers ---------------------------------

  function money(v, ccy) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return (ccy ? ccy + ' ' : '') + Math.round(v).toLocaleString('en-US');
  }
  function moneyShort(v, ccy) {
    var a = Math.abs(v), t;
    if (a >= 1e9) t = (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    else if (a >= 1e6) t = (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    else if (a >= 1e3) t = (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    else t = String(Math.round(v));
    t = t.replace(/\.0(?=[kMB]$)/, '');
    return (ccy ? ccy + ' ' : '') + t;
  }
  function duration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
    var m = Math.floor(s / 60), r = Math.round(s - m * 60);
    if (m < 60) return r ? m + 'm ' + r + 's' : m + 'm';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  // ------------------------------ counting up ------------------------------

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  // The handle lives on the node, so changing the period mid-count cancels
  // the run in flight instead of leaving two fighting over one element.
  function tween(node, to, apply, ms) {
    if (!node) return;
    if (node._anim) cancelAnimationFrame(node._anim);
    var from = typeof node._value === 'number' ? node._value : 0;
    node._value = to;
    if (REDUCED || from === to) { apply(to); return; }
    var start = performance.now(), span = ms || 720;
    var step = function (now) {
      var t = Math.min((now - start) / span, 1);
      apply(from + (to - from) * easeOut(t));
      node._anim = t < 1 ? requestAnimationFrame(step) : null;
    };
    node._anim = requestAnimationFrame(step);
  }
  function countTo(node, to, format, ms) {
    if (!node) return;
    if (typeof to !== 'number' || !isFinite(to)) {
      if (node._anim) cancelAnimationFrame(node._anim);
      node._value = null;
      node.textContent = format(NaN);
      return;
    }
    tween(node, to, function (v) { node.textContent = format(v); }, ms);
  }
  var pct = function (v) { return isFinite(v) ? Math.round(v) + '%' : '—'; };
  var int = function (v) { return isFinite(v) ? String(Math.round(v)) : '—'; };

  // ------------------------------- periods ---------------------------------

  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function rangeFor(preset) {
    var now = new Date();
    if (preset === 'today') return { from: ymd(now), to: ymd(now) };
    if (preset === 'this-month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    if (preset === 'last-month') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
    if (preset === 'last-7') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: ymd(now) };
    if (preset === 'last-90') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), to: ymd(now) };
    return { from: '', to: '' };
  }
  function currentRange() {
    var p = $('#filter-preset').value;
    if (p === 'custom') return { from: $('#filter-from').value, to: $('#filter-to').value };
    return rangeFor(p);
  }
  function describeRange(r) {
    if (!r.from && !r.to) return 'All time';
    if (r.from && r.to) return r.from === r.to ? fmtDay(r.from) : fmtDay(r.from) + ' to ' + fmtDay(r.to);
    return r.from ? 'From ' + fmtDay(r.from) : 'Up to ' + fmtDay(r.to);
  }
  function fmtDay(key) {
    var p = String(key).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2] || 1));
    if (isNaN(d)) return key;
    return p.length === 2 ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function axisLabel(key, unit) {
    var p = String(key).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2] || 1));
    if (isNaN(d)) return key;
    return unit === 'day' ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  function query(r) {
    var q = [];
    if (r.from) q.push('from=' + encodeURIComponent(r.from));
    if (r.to) q.push('to=' + encodeURIComponent(r.to));
    return q.join('&');
  }

  // -------------------------------- ribbon ---------------------------------

  function renderRibbon(r) {
    var t = r.totals, st = r.straightThrough, c = r.currency;
    var asMoney = function (v) { return money(v, c); };
    countTo($('#k-rate'), typeof st.rate === 'number' ? st.rate * 100 : NaN, pct);
    $('#k-rate-sub').textContent = st.finished ? st.auto + ' of ' + plural(st.finished, 'finished invoice') : 'no finished invoices';
    countTo($('#k-approved'), t.approved.amount, asMoney);
    $('#k-approved-sub').textContent = plural(t.approved.count, 'invoice');
    countTo($('#k-held'), t.held.amount, asMoney);
    $('#k-held-sub').textContent = plural(t.held.count, 'invoice') + (t.partial ? ', ' + t.partial + ' partly paid' : '');
    countTo($('#k-count'), r.runs, int);
    var bits = [];
    if (st.inFlight) bits.push(st.inFlight + ' in progress');
    if (st.unfinished) bits.push(st.unfinished + ' did not finish');
    $('#k-count-sub').textContent = bits.join(', ') || (r.runs ? 'all finished' : 'none yet');

    if (me.role === 'approver') {
      $('#k-fifth-label').textContent = 'Reviews decided';
      countTo($('#k-fifth'), r.review.decided, int);
      $('#k-fifth-sub').textContent = r.review.averageTurnaroundMs !== null ? 'avg. ' + duration(r.review.averageTurnaroundMs) + ' to decide' : (st.awaiting ? st.awaiting + ' waiting now' : 'none waiting');
    } else {
      countTo($('#k-fifth'), typeof r.runtime.averageMs === 'number' ? r.runtime.averageMs : NaN, function (v) { return isFinite(v) ? duration(v) : '—'; });
      $('#k-fifth-sub').textContent = r.runtime.runs ? plural(r.runtime.runs, 'invoice') + ' timed, incl. review' : 'no timed invoices';
    }
  }

  function legendInto(host, a, b) {
    host.innerHTML = '<span class="legend-item"><span class="swatch swatch-approved"></span>' + esc(a || 'Approved for payment') + '</span>' +
      '<span class="legend-item"><span class="swatch swatch-held"></span>' + esc(b || 'Held back') + '</span>';
  }

  // ------------------------------- headline --------------------------------

  function panelHeadline(r) {
    var root = $('#tpl-headline').content.cloneNode(true);
    var t = r.totals, st = r.straightThrough, c = r.currency;
    var asMoney = function (v) { return money(v, c); };
    fill(root, 'period').textContent = describeRange(r.range) + (r.scope === 'mine' ? ' · your invoices' : ' · all invoices');
    countTo(fill(root, 'approved'), t.approved.amount, asMoney, 840);
    fill(root, 'approved-sub').textContent = 'approved for payment across ' + plural(t.approved.count, 'invoice');
    countTo(fill(root, 'held'), t.held.amount, asMoney, 840);
    fill(root, 'held-sub').textContent = 'held back or disputed across ' + plural(t.held.count, 'invoice') +
      (t.partial ? ' (' + t.partial + ' partly paid, so also counted above)' : '');

    var share = typeof st.rate === 'number' ? st.rate : null;
    var arc = fill(root, 'arc');
    var circ = 2 * Math.PI * 48;
    // A round cap on a zero-length arc still paints a dot; draw nothing instead.
    arc.style.display = share ? '' : 'none';
    tween(arc, share || 0, function (v) { var sw = v * circ; arc.setAttribute('stroke-dasharray', sw + ' ' + (circ - sw)); }, 840);
    countTo(fill(root, 'pct'), share === null ? NaN : share * 100, pct, 840);
    fill(root, 'ring-label').setAttribute('aria-label', share === null ? 'No invoice finished in this period' : Math.round(share * 100) + ' per cent of finished invoices were auto-approved');
    fill(root, 'ring-note').textContent = share === null ? 'No invoice has finished in this period yet.'
      : st.auto + ' of ' + plural(st.finished, 'finished invoice') + ' needed no approver';

    var rv = r.review;
    var excTotal = rv.exceptionsApproved + rv.exceptionsDisputed;
    var facts = fill(root, 'facts');
    [
      { k: 'Invoice value processed', v: money(t.approved.amount + t.held.amount, c), s: plural(st.finished, 'finished invoice') },
      { k: 'Exceptions decided', v: String(excTotal), s: excTotal ? rv.exceptionsApproved + ' approved, ' + rv.exceptionsDisputed + ' disputed' : 'none decided yet' },
      { k: 'Awaiting an approver', v: String(st.awaiting || 0), s: st.awaiting ? 'paused at the review step' : 'nothing waiting' },
      { k: 'Did not finish', v: plural(st.unfinished || 0, 'invoice'), s: 'no payment decision produced' }
    ].forEach(function (f) {
      var box = el('div', 'fact');
      box.innerHTML = '<span class="fact-k">' + esc(f.k) + '</span><span class="fact-v">' + esc(f.v) + '</span><span class="fact-s">' + esc(f.s) + '</span>';
      facts.appendChild(box);
    });
    return root;
  }

  // ------------------------------ over time --------------------------------

  // Grouped bars as plain SVG, sized to its box so one unit is one CSS pixel.
  function timeChart(r, width) {
    var pts = r.series.points, unit = r.series.unit;
    var W = Math.max(280, Math.min(width || 860, 1000));
    var narrow = W < 560;
    var H = narrow ? 280 : 310, padL = narrow ? 52 : 74, padR = narrow ? 10 : 16, padT = 18, padB = 40;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var peak = 0;
    pts.forEach(function (p) { peak = Math.max(peak, p.approved.amount, p.held.amount); });
    if (peak <= 0) peak = 1;
    var step = Math.pow(10, Math.floor(Math.log10(peak)));
    var top = Math.ceil(peak / step) * step;
    var slot = plotW / pts.length;
    var barW = Math.min(narrow ? 20 : 34, Math.max(3, (slot - (pts.length > 20 ? 4 : 14)) / 2));
    var gap = 2;
    var y = function (v) { return padT + plotH - (v / top) * plotH; };

    var grid = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
      var yy = y(top * f);
      return '<line class="grid-line" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>' +
        '<text class="axis-text" x="' + (padL - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(moneyShort(top * f, r.currency)) + '</text>';
    }).join('');

    // Label every Nth tick so day labels never collide.
    var every = Math.max(1, Math.ceil(pts.length / Math.floor(plotW / (narrow ? 46 : 58))));
    var tallest = pts.reduce(function (b, p, i) { var v = Math.max(p.approved.amount, p.held.amount); return v > b.v ? { v: v, i: i } : b; }, { v: -1, i: -1 });

    var bars = pts.map(function (p, i) {
      var centre = padL + slot * i + slot / 2;
      var one = function (kind, x) {
        var v = p[kind].amount;
        var h = Math.max(v > 0 ? 3 : 0, padT + plotH - y(v));
        var rr = h >= 4 ? Math.min(4, barW / 2) : h;
        return '<rect class="bar-' + kind + '" x="' + x + '" y="' + (padT + plotH - h) + '" width="' + barW + '" height="' + h + '" rx="' + rr + '" style="animation-delay:' + Math.min(i * 18, 360) + 'ms"/>' +
          '<rect class="hit" x="' + x + '" y="' + padT + '" width="' + barW + '" height="' + plotH + '" data-key="' + esc(p.key) + '" data-kind="' + kind +
          '" data-amount="' + esc(money(v, r.currency)) + '" data-count="' + p[kind].count + '"/>' +
          (i === tallest.i && v > 0 && v === tallest.v ? '<text class="value-text" x="' + (x + barW / 2) + '" y="' + (padT + plotH - h - 6) + '" text-anchor="middle">' + esc(moneyShort(v, r.currency)) + '</text>' : '');
      };
      return one('approved', centre - barW - gap / 2) + one('held', centre + gap / 2) +
        (i % every === 0 ? '<text class="axis-text" x="' + centre + '" y="' + (H - 14) + '" text-anchor="middle">' + esc(axisLabel(p.key, unit)) + '</text>' : '');
    }).join('');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Value approved against value held back, by ' + unit + '">' +
      grid + '<line class="axis-line" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"/>' + bars + '</svg>';
  }

  function panelTime(r) {
    var root = $('#tpl-time').content.cloneNode(true);
    var pts = r.series.points, unit = r.series.unit;
    legendInto(fill(root, 'legend'));
    fill(root, 'title').textContent = 'Approved against held back, ' + (unit === 'day' ? 'day by day' : 'month by month');
    fill(root, 'unit').textContent = unit === 'day' ? 'Day' : 'Month';
    var anything = pts.some(function (p) { return p.runs; });
    if (!anything) { fill(root, 'empty').hidden = false; return root; }
    fill(root, 'chart').setAttribute('data-needs-chart', '1');
    var body = fill(root, 'table');
    pts.filter(function (p) { return p.runs; }).forEach(function (p) {
      var tr = el('tr');
      tr.innerHTML = '<td>' + esc(fmtDay(p.key)) + '</td><td class="num">' + esc(money(p.approved.amount, r.currency)) + '</td><td class="num">' +
        esc(money(p.held.amount, r.currency)) + '</td><td class="num">' + p.runs + '</td>';
      body.appendChild(tr);
    });
    return root;
  }

  // -------------------------------- ranks ----------------------------------

  // Ranked rows: one track per name, approved and held side by side, each row
  // labelled with its total. Horizontal because the labels are names.
  function panelRank(opts) {
    var root = $('#tpl-rank').content.cloneNode(true);
    fill(root, 'eyebrow').textContent = opts.eyebrow;
    fill(root, 'title').textContent = opts.title;
    legendInto(fill(root, 'legend'), opts.legendA, opts.legendB);
    var rows = (opts.rows || []).filter(function (x) { return opts.a(x) + opts.b(x) > 0 || (x.runs || 0) > 0; });
    if (!rows.length) {
      var e = fill(root, 'empty');
      e.hidden = false;
      e.innerHTML = '<strong>Nothing to rank yet</strong>' + esc(opts.emptyNote);
      return root;
    }
    var peak = rows.reduce(function (n, x) { return Math.max(n, opts.a(x) + opts.b(x)); }, 0) || 1;
    var host = fill(root, 'rank');
    rows.slice(0, 8).forEach(function (x) {
      var row = el('div', 'rank-row');
      row.innerHTML = '<span class="rank-name" title="' + esc(opts.label(x)) + '">' + esc(opts.label(x)) + '</span>' +
        '<span class="rank-track">' +
        (opts.a(x) > 0 ? '<span class="rank-bar rank-approved" data-w="' + (opts.a(x) / peak * 100).toFixed(2) + '"></span>' : '') +
        (opts.b(x) > 0 ? '<span class="rank-bar rank-held" data-w="' + (opts.b(x) / peak * 100).toFixed(2) + '"></span>' : '') + '</span>' +
        '<span class="rank-value">' + esc(opts.value(x)) + '</span><span class="rank-runs">' + esc(opts.sub(x)) + '</span>';
      host.appendChild(row);
    });
    if (rows.length > 8) {
      var more = el('p', 'hint');
      more.textContent = (rows.length - 8) + ' more not shown.';
      host.appendChild(more);
    }
    return root;
  }

  function moneyRank(r, rows, eyebrow, title, emptyNote) {
    return panelRank({
      rows: rows, eyebrow: eyebrow, title: title, emptyNote: emptyNote,
      a: function (x) { return x.approved; }, b: function (x) { return x.held; },
      label: function (x) { return x.label; },
      value: function (x) { return money(x.total, r.currency); },
      sub: function (x) { return plural(x.runs, 'invoice') + (x.unfinished ? ', ' + x.unfinished + ' unfinished' : ''); }
    });
  }

  var CHAPTERS = [
    { title: 'Headline', blurb: 'The period at a glance', build: panelHeadline },
    { title: 'Over time', blurb: 'Approved against held', build: panelTime },
    { title: 'By vendor', blurb: 'Where the money goes', build: function (r) {
      return moneyRank(r, r.vendors, 'By vendor', 'Value approved and held per vendor', 'No vendor was read from the invoices in this period.');
    } },
    { title: 'Exceptions', blurb: 'What the match caught', build: function (r) {
      return panelRank({
        rows: r.exceptions, eyebrow: 'Exceptions', title: 'Exception types and how approvers decided', emptyNote: 'No exception reached an approver in this period.',
        legendA: 'Approved (paid as invoiced)', legendB: 'Disputed (held, invoice query)',
        a: function (x) { return x.approved; }, b: function (x) { return x.disputed; },
        label: function (x) { return niceType(x.label); },
        value: function (x) { return plural(x.total, 'exception'); },
        sub: function (x) { return x.approved + ' approved, ' + x.disputed + ' disputed' + (x.pending ? ', ' + x.pending + ' waiting' : ''); }
      });
    } },
    { title: 'By clerk', blurb: 'Who submitted what', when: function (r) { return r.scope !== 'mine'; }, build: function (r) {
      return moneyRank(r, r.people, 'By clerk', 'Value submitted per clerk', 'Nobody has had an invoice finish in this period.');
    } },
    { title: 'By approver', blurb: 'Who decided what', when: function (r) { return r.scope !== 'mine'; }, build: function (r) {
      return panelRank({
        rows: r.approvers, eyebrow: 'By approver', title: 'Exceptions decided per approver', emptyNote: 'No review was decided in this period.',
        legendA: 'Approved', legendB: 'Disputed',
        a: function (x) { return x.approved; }, b: function (x) { return x.disputed; },
        label: function (x) { return x.label; },
        value: function (x) { return plural(x.total, 'exception'); },
        sub: function (x) { return plural(x.runs, 'review'); }
      });
    } }
  ];
  var chapters = CHAPTERS.slice();

  function renderChapterList() {
    var host = $('#chapter-list');
    host.innerHTML = '';
    chapters.forEach(function (ch, i) {
      var b = el('button', 'chapter' + (i === chapter ? ' is-current' : ''));
      b.type = 'button';
      b.setAttribute('aria-current', i === chapter ? 'true' : 'false');
      b.innerHTML = '<span class="chapter-num">' + (i + 1) + '</span><span class="chapter-text"><span class="chapter-title">' + esc(ch.title) +
        '</span><span class="chapter-blurb">' + esc(ch.blurb) + '</span></span>';
      b.addEventListener('click', function () {
        if (chapter === i) return;
        chapter = i;
        renderChapterList();
        renderChapter();
      });
      host.appendChild(b);
    });
  }

  function renderChapter() {
    var host = $('#chapter-body');
    host.innerHTML = '';
    if (!current || !chapters[chapter]) return;
    host.appendChild(chapters[chapter].build(current));
    var chartHost = host.querySelector('[data-needs-chart]');
    if (chartHost) {
      chartHost.innerHTML = timeChart(current, Math.round(chartHost.clientWidth));
      wireTooltip(host);
    }
    // Ranked bars grow from nothing one frame after they are placed.
    var bars = host.querySelectorAll('.rank-bar[data-w]');
    var paint = function () { Array.prototype.forEach.call(bars, function (b) { b.style.width = b.getAttribute('data-w') + '%'; }); };
    if (REDUCED) paint(); else requestAnimationFrame(function () { requestAnimationFrame(paint); });
  }

  function wireTooltip(scope) {
    var tip = $('#chart-tip');
    if (!tip) { tip = el('div', 'chart-tip'); tip.id = 'chart-tip'; tip.hidden = true; document.body.appendChild(tip); }
    Array.prototype.forEach.call(scope.querySelectorAll('.hit'), function (hit) {
      hit.addEventListener('mouseenter', function (e) {
        tip.innerHTML = '<b>' + esc(fmtDay(hit.getAttribute('data-key'))) + '</b><span>' +
          (hit.getAttribute('data-kind') === 'approved' ? 'Approved for payment' : 'Held back') + '</span><span>' +
          esc(hit.getAttribute('data-amount')) + '</span><span>' + plural(Number(hit.getAttribute('data-count')), 'invoice') + '</span>';
        tip.hidden = false;
        tip.style.left = e.clientX + 14 + 'px';
        tip.style.top = e.clientY - 12 + 'px';
      });
      hit.addEventListener('mousemove', function (e) { tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY - 12 + 'px'; });
      hit.addEventListener('mouseleave', function () { tip.hidden = true; });
    });
  }

  function renderScope(r) {
    var lede = {
      clerk: 'Your invoices: how much was approved for payment, what was held back, and how long they took.',
      approver: 'Every invoice: what went straight through, what came to an approver, and how the exceptions were decided.',
      admin: 'Every invoice: value approved and held, straight-through rate, exceptions, and who submitted and decided what.'
    };
    $('#report-lede').textContent = lede[me.role] || lede.admin;
    $('#export-link').hidden = r.scope === 'mine';
    var note = $('#fx-note');
    if (r.otherCurrencyRuns) {
      note.hidden = false;
      note.textContent = 'Money figures are in ' + r.currency + '. ' + plural(r.otherCurrencyRuns, 'invoice') + ' in other currencies are counted in the totals of invoices but not in the money.';
    } else note.hidden = true;
  }

  function load() {
    var r = currentRange();
    var q = query(r);
    $('#export-link').href = '/api/export.csv' + (q ? '?' + q : '');
    AP.api('/api/report' + (q ? '?' + q : '')).then(function (report) {
      $('#report-note').hidden = true;
      current = report;
      chapters = CHAPTERS.filter(function (ch) { return !ch.when || ch.when(report); });
      if (chapter >= chapters.length) chapter = 0;
      renderScope(report);
      renderRibbon(report);
      renderChapterList();
      renderChapter();
    }, function (err) {
      $('#report-note').hidden = false;
      $('#report-note').textContent = 'The report could not be read: ' + err.message;
    });
  }

  function syncControls() {
    var custom = $('#filter-preset').value === 'custom';
    $('#custom-wrap').hidden = !custom;
    if (custom && !$('#filter-from').value) {
      var r = rangeFor('last-90');
      $('#filter-from').value = r.from;
      $('#filter-to').value = r.to;
    }
  }

  AP.boot({ active: 'report' }, function (user) {
    me = user;
    ['#filter-preset', '#filter-from', '#filter-to'].forEach(function (sel) {
      $(sel).addEventListener('change', function () { syncControls(); load(); });
    });
    syncControls();
    load();
    // Redraw the time chart at the width it is shown at.
    var lastW = 0, timer = null;
    window.addEventListener('resize', function () {
      var host = document.querySelector('[data-needs-chart]');
      if (!host || !current) return;
      var w = Math.round(host.clientWidth);
      if (Math.abs(w - lastW) < 8) return;
      lastW = w;
      clearTimeout(timer);
      timer = setTimeout(function () { host.innerHTML = timeChart(current, w); wireTooltip($('#chapter-body')); }, 120);
    });
  });
})();
