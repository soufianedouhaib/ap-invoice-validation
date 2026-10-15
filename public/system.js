(function () {
  'use strict';
  // Connection details for IT. Not linked from the menu: open /system.html.
  var esc = AP.esc;

  AP.boot({ active: 'settings', roles: ['admin'] }, function () { loadConfig(); wireCleanup(); });

  // Admin: delete what was left from setting the system up (test runs, runs
  // that never finished, reviews that expired). Previewed first.
  function wireCleanup() {
    var btn = document.getElementById('cleanup-btn');
    var box = document.getElementById('cleanup-confirm');
    var text = document.getElementById('cleanup-text');
    var yes = document.getElementById('cleanup-yes');
    var note = document.getElementById('clear-note');
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    btn.addEventListener('click', function () {
      box.hidden = false; note.hidden = true; yes.disabled = true;
      text.innerHTML = '<strong style="display:inline">Clean up set-up data?</strong> Checking…';
      AP.api('/api/admin/cleanup').then(function (p) {
        var parts = [];
        if (p.test) parts.push(plural(p.test, 'hidden set-up run', 'hidden set-up runs'));
        if (p.duplicate) parts.push(plural(p.duplicate, 'duplicate submission', 'duplicate submissions'));
        if (p.unfinished) parts.push(plural(p.unfinished, 'run that did not finish', 'runs that did not finish'));
        if (p.expired) parts.push(plural(p.expired, 'invoice whose review expired', 'invoices whose review expired'));
        if (p.reviews) parts.push(plural(p.reviews, 'expired or unmatched review request', 'expired or unmatched review requests'));
        if (!parts.length) { text.innerHTML = '<strong style="display:inline">Nothing to clean up.</strong> ' + plural(p.kept, 'invoice stays', 'invoices stay') + '.'; return; }
        text.innerHTML = '<strong style="display:inline">Clean up set-up data?</strong> Deletes ' + esc(parts.join(', ')) + '. ' + esc(plural(p.kept, 'invoice stays', 'invoices stay')) + '. This cannot be undone.';
        yes.disabled = false;
      }, function (err) { text.textContent = err.message; });
    });
    document.getElementById('cleanup-no').addEventListener('click', function () { box.hidden = true; });
    yes.addEventListener('click', function () {
      yes.disabled = true; yes.textContent = 'Deleting…';
      AP.api('/api/admin/cleanup', { method: 'POST' }).then(function (p) {
        box.hidden = true; note.hidden = false;
        note.textContent = 'Cleaned up. ' + plural(p.kept, 'invoice remains', 'invoices remain') + '.';
        AP.refreshReviewBadge();
      }, function (err) { box.hidden = true; note.hidden = false; note.textContent = 'Nothing was deleted: ' + err.message; })
        .then(function () { yes.textContent = 'Yes, delete them'; });
    });
  }



  function yesNo(v) { return v ? '<span class="pill ok">Set</span>' : '<span class="pill bad">Missing</span>'; }

  function loadConfig() {
    AP.api('/api/config').then(function (c) {
      var rows = [
        ['Opus host', '<span class="mono">' + esc(c.opusHost) + '</span>'],
        ['Workflow id', '<span class="mono">' + esc(c.workflowId) + '</span>'],
        ['Service key', yesNo(c.serviceKeyConfigured)],
        ['Organization id', c.orgId
          ? '<span class="mono">' + esc(c.orgId) + '</span> <span class="muted small">(' + (c.orgSource === 'env' ? 'from OPUS_ORG_ID' : 'read from Opus') + ')</span>'
          : '<span class="pill warn">Not set</span><div class="hint">Opus does not return it through the API. Copy it from your Opus organization settings and add OPUS_ORG_ID in Vercel, then redeploy. It goes into support emails.</div>'],
        ['Workspace used for uploads', c.workspaceId
          ? '<span class="mono">' + esc(c.workspaceId) + '</span> <span class="muted small">(' + (c.workspaceSource === 'workflow' ? 'read from the workflow' : 'from OPUS_WORKSPACE_ID') + ')</span>' +
            (c.workspaceEnvMismatch ? '<div class="hint">OPUS_WORKSPACE_ID is set to a different workspace; it is being ignored. You can delete it.</div>' : '')
          : '<span class="pill bad">Unknown</span>'],
        ['Storage', c.storageDurable ? '<span class="pill ok">' + esc(c.storage) + '</span>' : '<span class="pill bad">In memory only, connect a KV or Redis store</span>'],
        ['Human Task webhook', '<span class="mono" style="word-break:break-all">' + esc(c.webhookUrl) + '</span><div class="hint">Paste this into the Human Task node (off-platform) in the Opus builder.' + (c.webhookSecretConfigured ? ' Replace &lt;WEBHOOK_SECRET&gt; with the value of that variable.' : ' Set WEBHOOK_SECRET to stop anyone else posting fake reviews.') + '</div>'],
        ['Review time limit', esc(c.reviewTimeoutMinutes) + ' minutes <span class="muted small">(REVIEW_TIME_LIMIT_MINUTES, default 60. The review task timeout in Opus must be at least this long.)</span>'],
        ['Self-review', c.allowSelfReview ? 'Allowed' : 'Blocked: an approver cannot decide on an invoice they submitted'],
      ];
      var ids = [
        ['Input: Invoice', c.inputs.invoice],
        ['Input: Purchase Order', c.inputs.purchaseOrder],
        ['Input: Goods Receipt', c.inputs.goodsReceipt],
        ['Output: Payment Object', c.outputs.paymentObject],
        ['Output: Audit Trail', c.outputs.auditTrail],
        ['Output: Justification Summary', c.outputs.justificationSummary],
        ['Human Task node', c.humanNodeId],
        ['Review input: Exception Brief', c.reviewInputs.exceptionBrief],
        ['Review input: Analyst Presentation', c.reviewInputs.analystPresentation],
        ['Review output (fallback)', c.reviewOutputFallback],
      ];
      document.getElementById('conn').innerHTML =
        (c.missing.length ? '<div class="alert warn" style="margin-bottom:14px"><strong>Missing</strong>' + esc(c.missing.join(', ')) + '</div>' : '<div class="alert ok" style="margin-bottom:14px">Everything required is configured.</div>') +
        '<dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
        '<details class="raw"><summary>Workflow variable ids</summary><dl class="kv" style="margin-top:10px">' +
        ids.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd class="mono">' + esc(r[1]) + '</dd>'; }).join('') + '</dl></details>';
    }, function (err) {
      document.getElementById('conn').innerHTML = '<div class="alert bad">' + esc(err.message) + '</div>';
    });
  }
})();
