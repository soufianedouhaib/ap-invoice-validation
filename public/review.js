(function () {
  'use strict';
  var esc = AP.esc;
  var id = AP.qs('id');
  var data = null;
  var exceptions = [];   // [{ num, title, desc, meta }]
  var decisions = {};    // num -> 'approve' | 'dispute'
  var manual = false;
  var countdownTimer = null;

  var GUIDE = [
    ['approve 1', 'accept exception 1 and pay as invoiced'],
    ['dispute 2', 'hold exception 2 and send a query to the vendor'],
    ['approve 1, dispute 2 and 3', 'combine decisions'],
    ['dispute all qty issues', 'apply across a type'],
    ['approve all under AED 100', 'apply by threshold'],
  ];

  AP.boot({ active: 'reviews', roles: ['approver', 'admin'] }, function () {
    document.getElementById('guide').innerHTML = '<ul class="guide">' + GUIDE.map(function (g) {
      return '<li><code>' + esc(g[0]) + '</code><span>' + esc(g[1]) + '</span></li>';
    }).join('') + '</ul><p class="muted" style="margin:8px 0 0">Unmentioned exceptions default to dispute.</p>';

    if (!id) return AP.showError(document.getElementById('error'), new Error('No review id in the link.'));
    document.getElementById('crumb').textContent = id.slice(0, 12);
    bind();
    load();
  });

  function load() {
    AP.api('/api/reviews/' + encodeURIComponent(id)).then(render, function (err) {
      document.getElementById('title').textContent = err.status === 404 ? 'Review not found' : 'Could not load review';
      AP.showError(document.getElementById('error'), err);
    });
  }

  // ---------- reading exceptions out of the brief ----------

  var LIST_KEYS = ['exceptions', 'exception_list', 'exceptionList', 'items', 'exception_items', 'flags', 'issues', 'discrepancies', 'variances'];

  function findList(v, depth) {
    if (depth > 3 || !v || typeof v !== 'object') return null;
    if (Array.isArray(v)) return v.length && v.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }) ? v : null;
    for (var i = 0; i < LIST_KEYS.length; i++) {
      var hit = v[LIST_KEYS[i]];
      if (Array.isArray(hit) && hit.length && hit.every(function (x) { return x && typeof x === 'object'; })) return hit;
    }
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      var found = findList(v[keys[k]], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function pick(o, names) {
    for (var i = 0; i < names.length; i++) {
      var val = o[names[i]];
      if (val !== undefined && val !== null && val !== '' && typeof val !== 'object') return val;
    }
    return null;
  }

  var TYPE_LABEL = {
    PRICE_VARIANCE: 'Unit price above PO', QTY_INVOICE_VS_PO: 'Quantity differs from PO', QTY_INVOICE_VS_GR: 'Billed more than received',
    GR_RECEIPT_SHORT: 'Goods receipt short of PO', HEADER_TOTAL_VARIANCE: 'Invoice total above PO', VAT_VARIANCE: 'VAT amount off',
    CURRENCY_MISMATCH: 'Currency mismatch', PO_CROSS_REF_MISMATCH: 'PO reference mismatch', VENDOR_NOT_ACTIVE: 'Vendor not active',
    VENDOR_NOT_FOUND: 'Vendor not in master', INPUT_PARSE_FAILED: 'Document could not be read',
  };
  function niceType(t) {
    var s = String(t);
    if (TYPE_LABEL[s]) return TYPE_LABEL[s];
    return /^[A-Z0-9_]+$/.test(s) ? AP.humanKey(s) : s;
  }

  function parseExceptions(brief) {
    var list = findList(brief, 0) || [];
    var used = {};
    return list.map(function (e, i) {
      var n = pick(e, ['number', 'exception_number', 'exceptionNumber', 'index', 'seq', 'no', 'id', 'exception_id']);
      var num = /^\d{1,3}$/.test(String(n)) ? Number(n) : i + 1;
      if (used[num]) num = i + 1;
      used[num] = true;
      var amount = pick(e, ['variance_amount', 'varianceAmount', 'variance', 'difference', 'amount', 'impact', 'value_at_risk']);
      var currency = pick(e, ['currency', 'currency_code']);
      var lineNo = pick(e, ['line_no', 'lineNo', 'line_number']);
      var sev = pick(e, ['severity', 'priority']);
      var meta = [
        sev ? String(sev).charAt(0).toUpperCase() + String(sev).slice(1).toLowerCase() + ' severity' : null,
        lineNo !== null ? 'Line ' + lineNo : (pick(e, ['level']) === 'header' ? 'Invoice level' : null),
        pick(e, ['line_item', 'lineItem', 'item', 'item_description', 'sku']),
        pick(e, ['exception_id']),
        amount !== null ? 'Variance ' + amount + (currency ? ' ' + currency : '') : null,
      ].filter(function (x) { return x !== null; });
      return {
        num: num,
        title: niceType(pick(e, ['title', 'exception_type', 'exceptionType', 'type', 'category', 'code', 'name']) || 'Exception'),
        desc: pick(e, ['description', 'summary', 'message', 'detail', 'details', 'reason', 'explanation']),
        meta: meta.join(' · '),
      };
    });
  }

  // ---------- render ----------

  function render(d) {
    data = d;
    document.getElementById('layout').hidden = false;
    var c = d.review.case;
    document.getElementById('title').textContent = c ? (c.reference || (c.files.invoice && c.files.invoice.name) || 'Invoice pack') : 'Invoice review';
    document.getElementById('crumb').textContent = c ? (c.reference || 'Job ' + c.jobId) : 'Review';
    document.getElementById('sub').textContent = c
      ? 'Submitted by ' + (c.submittedBy ? c.submittedBy.name : '—') + ' · ' + AP.fmtDate(c.submittedAt) + (c.note ? ' · Note: ' + c.note : '')
      : 'This review is not linked to a case in the console yet. You can still decide on it.';
    document.getElementById('case-link').innerHTML = c ? '<a class="btn" href="/case.html?id=' + encodeURIComponent(c.jobId) + '">Open case</a>' : '';

    var inputs = d.inputs || {};
    var pres = document.getElementById('presentation');
    var text = inputs.analystPresentation;
    // The Exception Presenter writes aligned plain text, not Markdown; keep its layout.
    var looksMarkdown = text && /(^|\n)\s*(#{1,6}\s|\|.*\|\s*\n\s*\|?\s*:?-{3,})/.test(text);
    pres.innerHTML = !text ? '<p class="muted">No presentation was included.</p>'
      : looksMarkdown ? AP.markdown(text) : '<pre class="presentation">' + esc(text) + '</pre>';

    var brief = inputs.exceptionBrief;
    var briefEl = document.getElementById('brief');
    if (brief === null || brief === undefined) {
      briefEl.innerHTML = '<p class="muted">No exception brief was included.</p>';
    } else if (brief && typeof brief === 'object' && !Array.isArray(brief) && brief.match_audit) {
      var rest = {};
      Object.keys(brief).forEach(function (k) { if (k !== 'match_audit' && k !== 'action_labels') rest[k] = brief[k]; });
      briefEl.innerHTML = AP.renderValue(rest) +
        '<details class="raw"><summary>3-way match checks (full audit)</summary><div style="margin-top:10px">' + AP.renderValue(brief.match_audit) + '</div></details>';
    } else {
      briefEl.innerHTML = AP.renderValue(brief);
    }
    var other = inputs.other || {};
    document.getElementById('other-inputs').innerHTML = Object.keys(other).length
      ? '<h3 style="margin:16px 0 8px">Other context</h3>' + AP.renderValue(other) : '';

    exceptions = parseExceptions(inputs.exceptionBrief);
    renderExceptions();

    if (d.review.status !== 'pending') return renderClosed(d);

    var blocked = document.getElementById('blocked');
    if (d.blockedReason) {
      blocked.textContent = d.blockedReason;
      blocked.hidden = false;
      document.getElementById('decision-form').hidden = true;
      document.getElementById('bulk').hidden = true;
    }
    startCountdown(d.review);
    rebuild();
  }

  function renderExceptions() {
    var card = document.getElementById('exc-card');
    var list = document.getElementById('exc-list');
    if (!exceptions.length) {
      document.getElementById('bulk').hidden = true;
      document.getElementById('exc-hint').textContent = 'The brief has no exception list this screen can read, so write the decision by hand using the numbers in the analyst presentation.';
      list.innerHTML = '';
      card.querySelector('.card-head').style.marginBottom = '0';
      return;
    }
    var closed = data.review.status !== 'pending' || Boolean(data.blockedReason);
    list.innerHTML = exceptions.map(function (e) {
      var dcs = decisions[e.num];
      return '<div class="exc' + (dcs ? ' ' + dcs : '') + '">' +
        '<div class="exc-num">' + e.num + '</div>' +
        '<div><div class="exc-title">' + esc(e.title) + '</div>' +
          (e.meta ? '<div class="exc-meta">' + esc(e.meta) + '</div>' : '') +
          (e.desc ? '<div class="exc-desc">' + esc(e.desc) + '</div>' : '') + '</div>' +
        (closed ? '' : '<div class="seg" role="group" aria-label="Decision for exception ' + e.num + '">' +
          '<button type="button" class="approve" data-num="' + e.num + '" data-d="approve" aria-pressed="' + (dcs === 'approve') + '">Approve</button>' +
          '<button type="button" class="dispute" data-num="' + e.num + '" data-d="dispute" aria-pressed="' + (dcs === 'dispute') + '">Dispute</button>' +
        '</div>') +
      '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.seg button'), function (b) {
      b.addEventListener('click', function () {
        var num = Number(b.getAttribute('data-num'));
        var dd = b.getAttribute('data-d');
        decisions[num] = decisions[num] === dd ? undefined : dd;
        renderExceptions();
        rebuild();
      });
    });
  }

  function joinNums(nums) {
    if (nums.length === 1) return String(nums[0]);
    return nums.slice(0, -1).join(', ') + ' and ' + nums[nums.length - 1];
  }

  function buildResponse() {
    var approve = [], dispute = [];
    exceptions.forEach(function (e) {
      if (decisions[e.num] === 'approve') approve.push(e.num);
      if (decisions[e.num] === 'dispute') dispute.push(e.num);
    });
    var parts = [];
    if (approve.length) parts.push('approve ' + joinNums(approve));
    if (dispute.length) parts.push('dispute ' + joinNums(dispute));
    return parts.join(', ');
  }

  function rebuild() {
    if (!exceptions.length) { updateUndecided(); return; }
    if (!manual) document.getElementById('response').value = buildResponse();
    document.getElementById('manual-hint').hidden = !manual;
    updateUndecided();
  }

  function updateUndecided() {
    var el = document.getElementById('undecided');
    var open = exceptions.filter(function (e) { return !decisions[e.num]; }).map(function (e) { return e.num; });
    el.hidden = manual || !exceptions.length || !open.length;
    if (!el.hidden) el.textContent = 'No decision yet for ' + (open.length === 1 ? 'exception ' : 'exceptions ') + joinNums(open) + '. If you submit now, ' + (open.length === 1 ? 'it' : 'they') + ' will be disputed.';
  }

  function startCountdown(r) {
    var el = document.getElementById('countdown');
    var deadline = new Date(r.receivedAt).getTime() + r.timeoutMinutes * 60000;
    function tick() {
      var ms = deadline - Date.now();
      if (ms <= 0) {
        el.innerHTML = '<span class="pill bad plain">Past the workflow’s ' + r.timeoutMinutes + '-minute limit; Opus may no longer accept it</span>';
        return;
      }
      var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
      el.textContent = 'About ' + m + ':' + (s < 10 ? '0' : '') + s + ' left before the workflow stops waiting';
    }
    tick();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(tick, 1000);
  }

  function renderClosed(d) {
    clearInterval(countdownTimer);
    document.getElementById('decision-form').hidden = true;
    document.getElementById('bulk').hidden = true;
    var done = document.getElementById('done');
    done.hidden = false;
    if (d.review.status === 'submitted') {
      document.getElementById('countdown').textContent = 'Decided by ' + (d.reviewedBy ? d.reviewedBy.name : '—') + ' · ' + AP.fmtDate(d.reviewedAt);
      done.innerHTML = '<pre class="mono" style="white-space:pre-wrap;margin:0">' + esc(d.response || '') + '</pre>';
    } else {
      document.getElementById('countdown').textContent = '';
      done.innerHTML = '<div class="alert bad"><strong>Expired</strong>Opus stopped waiting for this decision. The invoice pack has to be submitted again.</div>';
    }
  }

  // ---------- events ----------

  function bind() {
    document.getElementById('all-approve').addEventListener('click', function () { setAll('approve'); });
    document.getElementById('all-dispute').addEventListener('click', function () { setAll('dispute'); });
    document.getElementById('response').addEventListener('input', function () {
      manual = exceptions.length > 0 && this.value.trim() !== buildResponse();
      document.getElementById('manual-hint').hidden = !manual;
      updateUndecided();
    });
    document.getElementById('regen').addEventListener('click', function (e) { e.preventDefault(); manual = false; rebuild(); });
    document.getElementById('decision-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var text = finalText();
      var err = document.getElementById('submit-error');
      if (!document.getElementById('response').value.trim()) {
        AP.showError(err, new Error(exceptions.length ? 'Choose Approve or Dispute for at least one exception, or write a decision.' : 'Write a decision before submitting.'));
        return;
      }
      err.hidden = true;
      document.getElementById('confirm-text').textContent = text;
      document.getElementById('confirm').hidden = false;
      document.getElementById('confirm-ok').focus();
    });
    document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
    document.getElementById('confirm').addEventListener('click', function (e) { if (e.target === this) closeConfirm(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeConfirm(); });
    document.getElementById('confirm-ok').addEventListener('click', submit);
  }

  function setAll(dd) {
    exceptions.forEach(function (e) { decisions[e.num] = dd; });
    manual = false;
    renderExceptions();
    rebuild();
  }

  function finalText() {
    var text = document.getElementById('response').value.trim();
    var note = document.getElementById('note').value.trim();
    return note ? text + '\nNote: ' + note : text;
  }

  function closeConfirm() { document.getElementById('confirm').hidden = true; }

  function submit() {
    var ok = document.getElementById('confirm-ok');
    ok.disabled = true;
    ok.textContent = 'Submitting…';
    AP.api('/api/reviews/' + encodeURIComponent(id), { method: 'POST', body: { response: finalText() } }).then(function (r) {
      closeConfirm();
      data.review.status = 'submitted';
      renderExceptions();
      clearInterval(countdownTimer);
      document.getElementById('decision-form').hidden = true;
      document.getElementById('bulk').hidden = true;
      var done = document.getElementById('done');
      done.hidden = false;
      document.getElementById('countdown').textContent = '';
      done.innerHTML = '<div class="alert ok"><strong>Decision sent</strong>The workflow is resuming. It will apply your decisions and finish the payment record.</div>' +
        (r.jobId ? '<p style="margin:12px 0 0"><a class="btn primary block" href="/case.html?id=' + encodeURIComponent(r.jobId) + '">Follow the case</a></p>' : '') +
        '<p style="margin:8px 0 0"><a class="btn block" href="/reviews.html">Back to reviews</a></p>';
      AP.refreshReviewBadge();
    }, function (err) {
      closeConfirm();
      ok.disabled = false;
      ok.textContent = 'Submit';
      AP.showError(document.getElementById('submit-error'), err);
      if (err.status === 409) load();
    });
  }
})();
