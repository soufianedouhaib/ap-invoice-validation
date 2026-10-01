(function () {
  'use strict';
  var esc = AP.esc;
  var cases = [];
  var filter = 'all';
  var term = '';

  var BUCKETS = [
    { key: 'all', label: 'All cases' },
    { key: 'progress', label: 'Processing' },
    { key: 'review', label: 'Awaiting review' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
  ];

  AP.boot({ active: 'cases' }, function (user) {
    if (user.role === 'clerk') document.getElementById('scope-text').textContent = 'Invoice packs you have submitted, most recent first.';
    document.getElementById('new-btn').hidden = !(user.role === 'clerk' || user.role === 'admin');
    document.getElementById('search').addEventListener('input', function (e) { term = e.target.value.trim().toLowerCase(); render(); });
    load();
    setInterval(load, 30000);
  });

  function load() {
    AP.api('/api/cases').then(function (d) {
      cases = d.cases || [];
      document.getElementById('error').hidden = true;
      render();
    }, function (err) { AP.showError(document.getElementById('error'), err); });
  }

  function matches(c) {
    if (filter !== 'all' && AP.statusBucket(c.status) !== filter) return false;
    if (!term) return true;
    var hay = [c.reference, c.jobId, c.summary.vendor, c.summary.invoiceNumber, c.submittedBy && c.submittedBy.name,
      c.files.invoice && c.files.invoice.name].join(' ').toLowerCase();
    return hay.indexOf(term) !== -1;
  }

  function render() {
    var counts = { all: cases.length, progress: 0, review: 0, completed: 0, failed: 0 };
    cases.forEach(function (c) { counts[AP.statusBucket(c.status)]++; });
    document.getElementById('stats').innerHTML = BUCKETS.map(function (b) {
      return '<button type="button" class="stat' + (filter === b.key ? ' active' : '') + '" data-key="' + b.key + '" aria-pressed="' + (filter === b.key) + '">' +
        '<span class="label">' + esc(b.label) + '</span><span class="value">' + counts[b.key] + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.stat'), function (el) {
      el.addEventListener('click', function () { filter = el.getAttribute('data-key'); render(); });
    });

    var rows = cases.filter(matches);
    document.getElementById('count-text').textContent = rows.length === cases.length ? '' : rows.length + ' of ' + cases.length + ' shown';
    var wrap = document.getElementById('table-wrap');
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty">' + (cases.length ? 'No cases match this filter.' : 'No cases yet. Submissions will appear here.') + '</div>';
      return;
    }
    wrap.innerHTML = '<table><thead><tr><th>Case</th><th>Vendor</th><th class="num">Amount</th><th>Status</th><th>Submitted by</th><th>Submitted</th><th class="num">Duration</th></tr></thead><tbody>' +
      rows.map(function (c) {
        var title = c.reference || c.summary.invoiceNumber || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
        return '<tr class="clickable" data-id="' + esc(c.jobId) + '" tabindex="0">' +
          '<td><strong>' + esc(title) + '</strong><span class="sub mono">Job ' + esc(c.jobId) + '</span></td>' +
          '<td>' + esc(c.summary.vendor || '—') + '</td>' +
          '<td class="num">' + esc(c.summary.submittedTotal || '—') + '</td>' +
          '<td>' + AP.statusPill(c.status) + (c.review && c.review.status === 'submitted' ? '<span class="sub">Reviewed by ' + esc(c.review.reviewedBy && c.review.reviewedBy.name) + '</span>' : '') + '</td>' +
          '<td>' + esc(c.submittedBy ? c.submittedBy.name : '—') + '</td>' +
          '<td>' + esc(AP.fmtDate(c.submittedAt)) + '</td>' +
          '<td class="num">' + esc(c.completedAt ? AP.fmtDuration(c.submittedAt, c.completedAt) : '—') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
    Array.prototype.forEach.call(wrap.querySelectorAll('tr.clickable'), function (tr) {
      function open() { location.href = '/case.html?id=' + encodeURIComponent(tr.getAttribute('data-id')); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
    });
  }
})();
