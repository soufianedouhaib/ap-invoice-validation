(function () {
  'use strict';
  var esc = AP.esc;
  var me = null;

  AP.boot({ active: 'reviews', roles: ['approver', 'admin'] }, function (user) {
    document.getElementById('pending-hint').textContent = 'Oldest first. Each review has to be answered within ' + (AP.me.reviewTimeoutMinutes || 60) + ' minutes of arriving.';
    me = user;
    load();
    setInterval(load, 15000);
  });

  function load() {
    AP.api('/api/reviews').then(function (d) {
      document.getElementById('error').hidden = true;
      renderPending(d.pending || []);
      renderDone(d.completed || []);
      renderNotDelivered(d.notDelivered || []);
      renderUnmatched(d.unmatched || []);
      AP.refreshReviewBadge();
    }, function (err) { AP.showError(document.getElementById('error'), err); });
  }

  function remaining(r) {
    var left = r.timeoutMinutes - r.ageMinutes;
    if (left <= 0) return '<span class="pill bad plain">Past time limit</span>';
    var txt = AP.fmtRemaining(left * 60000) + ' left';
    if (left <= 3) return '<span class="pill bad plain">' + txt + '</span>';
    return '<span class="pill warn plain">' + txt + '</span>';
  }

  function renderPending(list) {
    var wrap = document.getElementById('pending-wrap');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">Nothing is waiting for approval.</div>';
      return;
    }
    wrap.innerHTML = '<table><thead><tr><th>Invoice</th><th>Vendor</th><th class="num">Amount</th><th>Submitted by</th><th>Received</th><th>Time left</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        var c = r.case;
        var sm = c.summary || {};
        var title = c.reference || sm.invoiceNumber || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        var own = c.submittedBy && c.submittedBy.email === me.email;
        return '<tr class="clickable" data-id="' + esc(r.id) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Case ' + esc(AP.shortId(c.jobId)) + '</span></td>' +
          '<td>' + esc(sm.vendor || '—') + '</td>' +
          '<td class="num">' + esc(sm.displayAmount || '—') + '</td>' +
          '<td>' + esc(c.submittedBy ? c.submittedBy.name : '—') + (own ? '<span class="sub">You, so another approver decides</span>' : '') + '</td>' +
          '<td class="nowrap">' + esc(AP.fmtAgo(r.receivedAt)) + '<span class="sub">' + esc(AP.fmtDate(r.receivedAt)) + '</span></td>' +
          '<td>' + remaining(r) + '</td>' +
          '<td class="num"><a class="btn small primary" href="/review.html?id=' + encodeURIComponent(r.id) + '">Review</a></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    bindRows(wrap, function (tr) { return '/review.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
  }

  function renderUnmatched(list) {
    document.getElementById('um-card').hidden = !list.length;
    var wrap = document.getElementById('um-wrap');
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<table><thead><tr><th>Invoice</th><th>Vendor</th><th class="num">Amount</th><th>Received</th><th>Time left</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        var d = r.details || {};
        return '<tr class="clickable" data-id="' + esc(r.id) + '" tabindex="0">' +
          '<td><strong>' + esc(d.invoiceNumber || 'Invoice') + '</strong><span class="sub">Not matched to a submission</span></td>' +
          '<td>' + esc(d.vendor || '—') + '</td>' +
          '<td class="num">' + esc(d.amount || '—') + '</td>' +
          '<td class="nowrap">' + esc(AP.fmtAgo(r.receivedAt)) + '<span class="sub">' + esc(AP.fmtDate(r.receivedAt)) + '</span></td>' +
          '<td>' + remaining(r) + '</td>' +
          '<td class="num"><a class="btn small" href="/review.html?id=' + encodeURIComponent(r.id) + '">Review</a></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    bindRows(wrap, function (tr) { return '/review.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
  }

  function renderDone(list) {
    var wrap = document.getElementById('done-wrap');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">No decisions yet.</div>';
      return;
    }
    wrap.innerHTML = '<table><thead><tr><th>Invoice</th><th>Decision</th><th>Reviewed by</th><th>Case status</th></tr></thead><tbody>' +
      list.map(function (c) {
        var r = c.review || {};
        var title = c.reference || c.summary.invoiceNumber || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        var decision = r.status === 'expired' ? '<span class="pill bad plain">Expired unanswered</span>' : esc(truncate(r.response || '', 90));
        return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Case ' + esc(AP.shortId(c.jobId)) + '</span></td>' +
          '<td class="pre-line" style="max-width:360px">' + decision + '</td>' +
          '<td>' + esc(r.reviewedBy ? r.reviewedBy.name : '—') + '<span class="sub">' + esc(AP.fmtDate(r.reviewedAt)) + '</span></td>' +
          '<td>' + AP.casePill(c) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    bindRows(wrap, function (tr) { return '/case.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
  }

  function renderNotDelivered(list) {
    document.getElementById('nd-card').hidden = !list.length;
    var wrap = document.getElementById('nd-wrap');
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<table><thead><tr><th>Invoice</th><th>Submitted by</th><th>Paused at</th><th>Since</th></tr></thead><tbody>' +
      list.map(function (c) {
        var s = c.atReviewStep || {};
        var title = c.reference || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Case ' + esc(AP.shortId(c.jobId)) + '</span></td>' +
          '<td>' + esc(c.submittedBy ? c.submittedBy.name : '—') + '</td>' +
          '<td>' + esc(s.node || '—') + '</td>' +
          '<td>' + esc(AP.fmtAgo(s.since)) + '</td></tr>';
      }).join('') + '</tbody></table>';
    bindRows(wrap, function (tr) { return '/case.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function bindRows(wrap, hrefFor) {
    Array.prototype.forEach.call(wrap.querySelectorAll('tr.clickable'), function (tr) {
      tr.addEventListener('click', function (e) { if (e.target.closest('a')) return; location.href = hrefFor(tr); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') location.href = hrefFor(tr); });
    });
  }
})();
