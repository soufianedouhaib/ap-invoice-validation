(function () {
  'use strict';
  var esc = AP.esc;
  var me = null;

  AP.boot({ active: 'overview' }, function (user) {
    me = user;
    var h = new Date().getHours();
    var first = String(user.name || '').split(/\s+/)[0];
    document.getElementById('greeting').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + (first ? ', ' + first : '');
    document.getElementById('today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    var act = document.getElementById('primary-action');
    if (user.role === 'approver') { act.textContent = 'Open approvals'; act.href = '/reviews.html'; }
    else { act.innerHTML = AP.icon('submit') + 'New submission'; act.href = '/submit.html'; }
    act.hidden = false;
    if (user.role === 'clerk') {
      document.getElementById('all-link').textContent = 'My invoices';
      document.getElementById('recent-title').textContent = 'Your recent submissions';
    }
    load();
    setInterval(load, 30000);
  });

  function monthRange() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return { from: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01', to: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) };
  }

  function money(v, ccy) {
    if (typeof v !== 'number') return '—';
    return (ccy ? ccy + ' ' : '') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function load() {
    var r = monthRange();
    Promise.all([
      AP.api('/api/cases'),
      AP.api('/api/report?from=' + r.from + '&to=' + r.to).catch(function () { return null; }),
      me.role === 'clerk' ? Promise.resolve(null) : AP.api('/api/reviews').catch(function () { return null; }),
    ]).then(function (res) {
      document.getElementById('error').hidden = true;
      render(res[0].cases || [], res[1], res[2]);
    }, function (err) { AP.showError(document.getElementById('error'), err); });
  }

  function title(c) {
    return c.reference || (c.summary && c.summary.invoiceNumber) || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
  }

  function render(cases, rep, reviews) {
    var month = monthRange().from;
    var thisMonth = cases.filter(function (c) { return String(c.submittedAt).slice(0, 10) >= month; });
    var awaiting = cases.filter(function (c) { return c.status === 'WAITING_REVIEW'; });
    var unfinished = cases.filter(function (c) { return AP.statusBucket(c.status) === 'failed'; });
    var matching = cases.filter(function (c) { return AP.statusBucket(c.status) === 'progress'; });
    var held = cases.filter(function (c) {
      var s = c.summary || {};
      return c.status === 'COMPLETED' && (s.displayNote === 'held' || (typeof s.heldAmount === 'number' && s.heldAmount > 0));
    });
    var ccy = rep && rep.currency;
    var approvedAmt = rep ? rep.totals.approved.amount : null;
    var heldAmt = rep ? rep.totals.held.amount : null;
    var awaitingCount = reviews ? (reviews.pending || []).length : awaiting.length;

    var k = [
      { label: 'Submitted this month', value: String(thisMonth.length), sub: thisMonth.length === 1 ? 'invoice pack' : 'invoice packs', href: '/' },
      { label: 'Awaiting approval', value: String(awaitingCount), sub: me.role === 'clerk' ? 'with an approver' : 'waiting for a decision', href: me.role === 'clerk' ? '/?filter=review' : '/reviews.html', tone: awaitingCount ? 'warn' : '' },
      { label: 'Approved for payment', value: money(approvedAmt, ccy), sub: rep ? rep.totals.approved.count + ' this month' : '', href: '/payments.html', tone: 'ok' },
      { label: 'Held back', value: money(heldAmt, ccy), sub: rep ? rep.totals.held.count + ' this month' : '', href: '/report.html', tone: heldAmt ? 'bad' : '' },
    ];
    document.getElementById('kpis').innerHTML = k.map(function (x) {
      return '<a class="kpi' + (x.tone ? ' ' + x.tone : '') + '" href="' + x.href + '"><span class="kpi-label">' + esc(x.label) + '</span><span class="kpi-value">' + esc(x.value) + '</span><span class="kpi-sub">' + esc(x.sub) + '</span></a>';
    }).join('');

    // Most urgent first: runs to resubmit, reviews to decide (approvers), held
    // invoices to follow up, then anything still matching.
    var items = [];
    var more = [];
    // A long run of the same kind is summarised after the first three.
    function capped(list, n, label, href) {
      if (list.length > n) more.push({ n: list.length - n, label: (list.length - n) + ' more ' + label, href: href, urgent: label !== 'matching' });
      return list.slice(0, n);
    }
    capped(unfinished, 3, 'did not finish', '/?filter=failed').forEach(function (c) {
      items.push({ tone: 'bad', tag: 'Did not finish', c: c, text: 'The match stopped before a decision. Submit the pack again.',
        actions: (me.role !== 'approver' ? '<a class="btn small primary" href="/submit.html">Submit again</a>' : '') + '<a class="btn small" href="/case.html?id=' + encodeURIComponent(c.jobId) + '">View</a>' });
    });
    if (reviews) (reviews.pending || []).forEach(function (r) {
      var c = r.case;
      items.push({ tone: 'warn', tag: 'Decide', c: c, text: 'Exceptions found in the 3-way match. ' + AP.fmtRemaining(Math.max(0, (r.timeoutMinutes - r.ageMinutes) * 60000)) + ' left to decide.',
        actions: '<a class="btn small primary" href="/review.html?id=' + encodeURIComponent(r.id) + '">Review</a>' });
    });
    else awaiting.forEach(function (c) {
      items.push({ tone: 'warn', tag: 'With approver', c: c, text: 'Exceptions found; an approver is deciding. No action needed from you.',
        actions: '<a class="btn small" href="/case.html?id=' + encodeURIComponent(c.jobId) + '">View</a>' });
    });
    capped(held, 3, 'held', '/?filter=completed').forEach(function (c) {
      items.push({ tone: 'bad', tag: 'Held', c: c, text: (AP.decisionLabel(c.summary.outcome) || 'Held') + '. Follow up with the vendor before it can be paid.',
        actions: '<a class="btn small" href="/case.html?id=' + encodeURIComponent(c.jobId) + '">View</a>' });
    });
    capped(matching, 3, 'matching', '/?filter=progress').forEach(function (c) {
      items.push({ tone: 'info', tag: 'Matching', c: c, text: 'Reading the documents and running the 3-way match.',
        actions: '<a class="btn small" href="/case.html?id=' + encodeURIComponent(c.jobId) + '">View</a>' });
    });
    var urgent = items.filter(function (i) { return i.tone !== 'info'; }).length + more.reduce(function (a, m) { return a + (m.urgent ? m.n : 0); }, 0);
    var total = items.length + more.reduce(function (a, m) { return a + m.n; }, 0);
    document.getElementById('att-sub').textContent = urgent ? urgent + (urgent === 1 ? ' item needs' : ' items need') + ' action' + (total > urgent ? ', ' + (total - urgent) + ' in progress' : '') + '.' : total ? 'Nothing needs action. ' + total + ' in progress.' : 'You are all caught up.';
    var list = document.getElementById('attention');
    var moreHtml = more.map(function (m) { return '<li class="att-more"><a href="' + m.href + '">' + esc(m.label) + ' →</a></li>'; }).join('');
    list.innerHTML = items.length ? items.map(function (i) {
      var c = i.c, s = (c && c.summary) || {};
      return '<li class="att-item"><span class="pill ' + i.tone + ' plain">' + esc(i.tag) + '</span>' +
        '<div class="att-body"><strong>' + esc(c ? title(c) : 'Invoice') + '</strong>' +
          '<span class="att-meta">' + AP.metaLine([s.vendor, s.displayAmount, c && c.submittedBy && me.role !== 'clerk' ? c.submittedBy.name : null, c ? AP.fmtAgo(c.submittedAt) : null]) + '</span>' +
          '<span class="att-text">' + esc(i.text) + '</span></div>' +
        '<div class="att-actions">' + i.actions + '</div></li>';
    }).join('') + moreHtml : '<li class="att-empty">' + AP.icon('reviews') + '<span><strong>All caught up</strong>Nothing is waiting on you. New submissions and decisions will show up here.</span></li>';

    var recent = cases.slice(0, 6);
    document.getElementById('recent-sub').textContent = cases.length ? 'The latest ' + recent.length + ' of ' + cases.length + '.' : '';
    document.getElementById('recent').innerHTML = recent.length
      ? '<table class="compact"><thead><tr><th>Invoice</th><th class="num col-amount">Amount</th><th>Status</th></tr></thead><tbody>' + recent.map(function (c) {
          var s = c.summary || {};
          return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0"><td><strong>' + esc(title(c)) + '</strong><span class="sub">' + AP.metaLine([s.vendor, AP.fmtAgo(c.submittedAt)]) + '</span></td>' +
            '<td class="num nowrap col-amount">' + esc(s.displayAmount || '—') + '</td><td class="nowrap">' + AP.statusPill(c.status) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">No submissions yet.' + (me.role !== 'approver' ? ' <a href="/submit.html">Submit the first invoice pack</a>.' : '') + '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('#recent tr.clickable'), function (tr) {
      var go = function () { location.href = '/case.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
  }
})();
