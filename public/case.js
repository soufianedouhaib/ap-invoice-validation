(function () {
  'use strict';
  var esc = AP.esc;
  var id = AP.qs('id');
  var me = null;
  var timer = null;
  var TERMINAL = ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'];

  var STAGES = [
    { label: 'Read invoice, PO and goods receipt', nodes: ['invoice extractor', 'po extractor', 'gr extractor'] },
    { label: 'Vendor lookup and 3-way match', nodes: ['vendor lookup'] },
    { label: 'Exception review by an approver', nodes: ['exception presenter', 'human task', 'approver', 'review', 'off-platform', 'resolution resolver', 'apply resolutions', 'invoice query narrative'], review: true },
    { label: 'Justification summary', nodes: ['auto-approve builder', 'justification summary'] },
    { label: 'Payment object and audit trail', nodes: ['output assembly', 'output'] },
  ];

  AP.boot({ active: 'cases' }, function (user) {
    me = user;
    if (!id) {
      AP.showError(document.getElementById('error'), new Error('No case id in the link.'));
      return;
    }
    document.getElementById('crumb-id').textContent = 'Case ' + AP.shortId(id);
    // Report a problem from this page carries this case's ids and reason.
    AP.setSupportContext(function () { return AP.api('/api/cases/' + encodeURIComponent(id) + '/support'); });
    document.getElementById('failure-card').addEventListener('click', function (e) {
      if (e.target.closest('[data-support]')) AP.openSupport();
    });
    load();
  });

  function load() {
    AP.api('/api/cases/' + encodeURIComponent(id)).then(function (d) {
      render(d);
      var done = TERMINAL.indexOf(d.case.status) !== -1;
      clearTimeout(timer);
      if (!done) timer = setTimeout(load, d.case.status === 'WAITING_REVIEW' ? 10000 : 5000);
    }, function (err) {
      document.getElementById('case-title').textContent = err.status === 404 ? 'Case not found' : 'Could not load case';
      AP.showError(document.getElementById('error'), err.status === 404 ? new Error('This case does not exist or you do not have access to it.') : err);
      if (err.status !== 404) timer = setTimeout(load, 10000);
    });
  }

  function stageIndex(progress, c) {
    if (c.status === 'WAITING_REVIEW') return 2;
    if (!progress) return 0;
    var name = String(progress.runningNode || progress.nextNode || '').toLowerCase();
    for (var i = STAGES.length - 1; i >= 0; i--) {
      if (STAGES[i].nodes.some(function (n) { return name.indexOf(n) !== -1; })) return i;
    }
    return 0;
  }

  function render(d) {
    var c = d.case;
    document.getElementById('layout').hidden = false;
    document.getElementById('error').hidden = true;
    var warn = document.getElementById('refresh-warning');
    warn.hidden = !d.refreshError;
    warn.textContent = d.refreshError || '';

    var title = c.reference || c.summary.invoiceNumber || (c.files.invoice && c.files.invoice.name) || 'Invoice pack';
    document.getElementById('case-title').textContent = title;
    document.getElementById('case-sub').textContent = 'Submitted by ' + (c.submittedBy ? c.submittedBy.name : '—') + ' · ' + AP.fmtDate(c.submittedAt);
    document.getElementById('case-status').innerHTML = AP.casePill(c);

    // details
    var rows = [
      ['Case id', esc(c.jobId)],
      ['Invoice', esc(c.files.invoice ? c.files.invoice.name : '—')],
      ['Purchase order', esc(c.files.purchaseOrder ? c.files.purchaseOrder.name : '—')],
      ['Goods receipt', esc(c.files.goodsReceipt ? c.files.goodsReceipt.name : '—')],
      ['Submitted', esc(AP.fmtDate(c.submittedAt))],
      ['Finished', esc(AP.fmtDate(c.completedAt))],
    ];
    if (c.completedAt) rows.push(['Duration', esc(AP.fmtDuration(c.submittedAt, c.completedAt))]);
    if (c.note) rows.push(['Note', esc(c.note)]);
    if (c.review && c.review.reviewedBy) rows.push(['Reviewed by', esc(c.review.reviewedBy.name) + '<br><span class="muted small">' + esc(AP.fmtDate(c.review.reviewedAt)) + '</span>']);
    document.getElementById('details').innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');

    // stages
    var done = c.status === 'COMPLETED';
    var failed = ['FAILED', 'TIMED_OUT', 'CANCELLED'].indexOf(c.status) !== -1;
    var cur = stageIndex(d.progress, c);
    var failedAt = 0;
    if (failed && d.failure && d.failure.failedNodes && d.failure.failedNodes.length) {
      var fn = d.failure.failedNodes[0];
      failedAt = stageIndex({ runningNode: typeof fn === 'string' ? fn : (fn.name || fn.node_name || '') }, { status: '' });
    }
    document.getElementById('steps').innerHTML = STAGES.map(function (s, i) {
      var cls = '';
      var tag = '';
      if (done) {
        if (s.review && !c.hadReview) { cls = 'skipped'; tag = '<span class="tag">Not needed</span>'; } else cls = 'done';
      } else if (failed) {
        cls = i < failedAt ? 'done' : i === failedAt ? 'failed' : '';
        if (i === failedAt) tag = '<span class="tag">Stopped here</span>';
      } else {
        cls = i < cur ? 'done' : i === cur ? 'current' : '';
      }
      return '<li class="' + cls + '"><span class="dot"></span><span>' + esc(s.label) + tag + '</span></li>';
    }).join('');

    // progress
    var pc = document.getElementById('progress-card');
    pc.hidden = TERMINAL.indexOf(c.status) !== -1;
    if (!pc.hidden) {
      var p = d.progress || {};
      var bar = document.getElementById('progress-bar');
      var pct = p.nbNodes ? Math.min(100, Math.round((p.nbExecutedNodes || 0) / p.nbNodes * 100)) : null;
      bar.classList.toggle('indeterminate', pct === null);
      bar.firstChild.style.width = pct === null ? '' : pct + '%';
      document.getElementById('progress-text').textContent = c.status === 'WAITING_REVIEW'
        ? 'Paused: awaiting approval.'
        : (p.runningNode ? 'Running: ' + p.runningNode : 'Working…') + (p.nbNodes ? ' · ' + (p.nbExecutedNodes || 0) + ' of ' + p.nbNodes + ' steps' : '') + '. This page updates by itself.';
    }

    renderReviewBanner(c);

    // failure
    var fc = document.getElementById('failure-card');
    fc.hidden = !failed;
    if (failed) {
      var f = d.failure || {};
      var nodes = (f.failedNodes || []).map(function (n) { return typeof n === 'string' ? n : (n.name || n.node_name || n.id || JSON.stringify(n)); });
      var expired = c.review && c.review.status === 'expired';
      document.getElementById('failure-body').innerHTML =
        '<div class="alert bad"><strong>' + (c.status === 'TIMED_OUT' ? 'Timed out' : c.status === 'CANCELLED' ? 'Cancelled' : 'Did not finish') + '</strong>' +
        (expired ? 'The review was not answered within its time limit. ' : '') +
        (f.cause ? esc(f.cause.message) + ' ' : nodes.length ? 'Stopped at: ' + esc(nodes.join(', ')) + '. ' : '') +
        'Submit the invoice pack again to retry.</div>' +
        '<p class="toolbar" style="margin-top:12px">' + (me.role !== 'approver' ? '<a class="btn" href="/submit.html">Submit again</a>' : '') +
          '<button type="button" class="btn" data-support="1">Report a problem</button></p>' +
        (me.role === 'admin' ? (f.raw
          ? '<details class="raw" open><summary>Technical details (admins only)</summary><pre>' + esc(JSON.stringify(f.raw, null, 2)) + '</pre></details>'
          : '<p class="muted small" style="margin-top:12px">No technical details were recorded for this case (it stopped before details were kept). Run it again to capture them.</p>') : '');
    }

    // results
    var res = document.getElementById('results');
    res.hidden = !done;
    if (done) {
      var o = d.outputs || {};
      var s = c.summary || {};
      document.getElementById('tiles').innerHTML = [
        ['Amount', s.displayAmount ? s.displayAmount + (s.displayNote === 'held' ? ' (held)' : '') : '—'],
        ['Vendor', s.vendor || '—'],
        ['Invoice no.', s.invoiceNumber || '—'],
        ['Result', AP.decisionLabel(s.outcome) || (c.hadReview ? 'Reviewed' : 'Auto-approved')],
      ].map(function (t) { return '<div class="tile"><div class="label">' + esc(t[0]) + '</div><div class="value">' + esc(t[1]) + '</div></div>'; }).join('');
      document.getElementById('justification').innerHTML = o.justificationSummary ? AP.markdown(o.justificationSummary) : '<p class="muted">No summary was returned.</p>';
      document.getElementById('payment').innerHTML = o.paymentObject !== null && o.paymentObject !== undefined ? AP.renderValue(o.paymentObject) : '<p class="muted">Not returned.</p>';
      document.getElementById('audit').innerHTML = o.auditTrail !== null && o.auditTrail !== undefined ? AP.renderValue(o.auditTrail) : '<p class="muted">Not returned.</p>';
    }
  }

  function renderReviewBanner(c) {
    var el = document.getElementById('review-banner');
    var r = c.review;
    // Paused at the review step, but the review request has not reached the hub.
    if ((!r || r.status !== 'pending') && c.atReviewStep && !c.atReviewStep.inApp) {
      var approverView = me.role === 'approver' || me.role === 'admin';
      el.innerHTML = '<div class="alert warn"><strong>Awaiting approval</strong>' +
        'The 3-way match found exceptions, so this invoice is paused until an approver approves or disputes them' +
        ' (waiting since ' + esc(AP.fmtDate(c.atReviewStep.since)) + ').' +
        (approverView
          ? '<div style="margin-top:8px">It is paused at the <b>' + esc(c.atReviewStep.node) + '</b> step, but the review request has not reached the hub yet, so it cannot be answered here. ' +
            'If this lasts more than a few minutes, use Report a problem.</div>'
          : '<div style="margin-top:6px">You will see the decision here once it is made. No action is needed from you.</div>') +
        '</div>';
      return;
    }
    if (!r) { el.innerHTML = ''; return; }
    if (r.status === 'pending') {
      var canReview = me.role === 'approver' || me.role === 'admin';
      var own = c.submittedBy && me.email === c.submittedBy.email;
      el.innerHTML = '<div class="alert warn"><strong>Waiting for an approver</strong>' +
        'The 3-way match found exceptions. The invoice is paused until an approver approves or disputes them. Received ' + esc(AP.fmtAgo(r.receivedAt)) + '.' +
        (!canReview ? '<div style="margin-top:6px">You will see the decision here once it is made. No action is needed from you.</div>' : '') +
        (canReview && !own ? '<div style="margin-top:10px"><a class="btn primary" href="/review.html?id=' + encodeURIComponent(r.dispatchId) + '">Open review</a></div>' : '') +
        (canReview && own ? '<div style="margin-top:6px">You submitted this one, so another approver has to review it.</div>' : '') +
        '</div>';
    } else if (r.status === 'submitted') {
      el.innerHTML = '<div class="card"><div class="card-head"><div><h2>Approver decision</h2><p>' + esc((r.reviewedBy && r.reviewedBy.name) || '—') + ' · ' + esc(AP.fmtDate(r.reviewedAt)) + '</p></div></div>' +
        '<pre class="mono" style="white-space:pre-wrap;margin:0">' + esc(r.response || '') + '</pre></div>';
    } else if (r.status === 'expired') {
      el.innerHTML = '<div class="alert bad"><strong>Review expired</strong>No decision was made within the time limit.</div>';
    }
  }
})();
