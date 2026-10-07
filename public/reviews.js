(function () {
  'use strict';
  var esc = AP.esc;
  var me = null;

  AP.boot({ active: 'reviews', roles: ['approver', 'admin'] }, function (user) {
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
      AP.refreshReviewBadge();
    }, function (err) { AP.showError(document.getElementById('error'), err); });
  }

  function remaining(r) {
    var left = r.timeoutMinutes - r.ageMinutes;
    if (left <= 0) return '<span class="pill bad plain">Past time limit</span>';
    var txt = left >= 60 ? Math.floor(left / 60) + ' h ' + (left % 60) + ' min left' : left + ' min left';
    if (left <= 3) return '<span class="pill bad plain">' + txt + '</span>';
    return '<span class="pill warn plain">' + txt + '</span>';
  }

  function renderPending(list) {
    var wrap = document.getElementById('pending-wrap');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">Nothing is waiting for review.</div>';
      return;
    }
    wrap.innerHTML = '<table><thead><tr><th>Case</th><th>Submitted by</th><th>Received</th><th>Time limit</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        var c = r.case;
        var title = c ? (c.reference || (c.files.invoice && c.files.invoice.name) || 'Invoice pack') : 'Case not linked yet';
        var own = c && c.submittedBy && c.submittedBy.email === me.email;
        return '<tr class="clickable" data-id="' + esc(r.id) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">' + (c ? 'Job ' + esc(c.jobId) : 'Review ' + esc(r.id.slice(0, 12))) + '</span></td>' +
          '<td>' + esc(c && c.submittedBy ? c.submittedBy.name : '—') + (own ? '<span class="sub">You — another approver must decide</span>' : '') + '</td>' +
          '<td>' + esc(AP.fmtAgo(r.receivedAt)) + '<span class="sub">' + esc(AP.fmtDate(r.receivedAt)) + '</span></td>' +
          '<td>' + remaining(r) + '</td>' +
          '<td class="num"><a class="btn small primary" href="/review.html?id=' + encodeURIComponent(r.id) + '">Review</a></td>' +
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
    wrap.innerHTML = '<table><thead><tr><th>Case</th><th>Decision</th><th>Reviewed by</th><th>Case status</th></tr></thead><tbody>' +
      list.map(function (c) {
        var r = c.review || {};
        var title = c.reference || c.summary.invoiceNumber || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        var decision = r.status === 'expired' ? '<span class="pill bad plain">Expired unanswered</span>' : esc(truncate(r.response || '', 90));
        return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Job ' + esc(c.jobId) + '</span></td>' +
          '<td class="pre-line" style="max-width:360px">' + decision + '</td>' +
          '<td>' + esc(r.reviewedBy ? r.reviewedBy.name : '—') + '<span class="sub">' + esc(AP.fmtDate(r.reviewedAt)) + '</span></td>' +
          '<td>' + AP.statusPill(c.status) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    bindRows(wrap, function (tr) { return '/case.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); });
  }

  function renderNotDelivered(list) {
    document.getElementById('nd-card').hidden = !list.length;
    var wrap = document.getElementById('nd-wrap');
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<table><thead><tr><th>Case</th><th>Submitted by</th><th>Waiting at</th><th>Since</th></tr></thead><tbody>' +
      list.map(function (c) {
        var s = c.atReviewStep || {};
        var title = c.reference || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Job ' + esc(c.jobId) + '</span></td>' +
          '<td>' + esc(c.submittedBy ? c.submittedBy.name : '—') + '</td>' +
          '<td>' + esc(s.node || '—') + '<span class="sub">' + esc(s.opusStatus || '') + '</span></td>' +
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
