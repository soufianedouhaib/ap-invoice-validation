(function () {
  'use strict';
  var esc = AP.esc;

  AP.boot({ active: 'settings' }, function (user) {
    document.getElementById('account-line').textContent = user.name + ' · ' + user.email + ' · ' + (AP.ROLE_LABEL[user.role] || user.role);
    document.getElementById('pw-form').addEventListener('submit', changePassword);
    if (user.role === 'admin') loadConfig();
  });

  function changePassword(e) {
    e.preventDefault();
    var msg = document.getElementById('pw-msg');
    var btn = document.getElementById('pw-btn');
    msg.hidden = true;
    btn.disabled = true;
    AP.api('/api/me/password', { method: 'POST', body: { current: document.getElementById('pw-current').value, next: document.getElementById('pw-next').value } })
      .then(function () {
        msg.className = 'alert ok';
        msg.textContent = 'Password changed.';
        msg.hidden = false;
        document.getElementById('pw-current').value = '';
        document.getElementById('pw-next').value = '';
      }, function (err) {
        msg.className = 'alert bad';
        msg.textContent = err.message;
        msg.hidden = false;
      }).then(function () { btn.disabled = false; });
  }

  function yesNo(v) { return v ? '<span class="pill ok">Set</span>' : '<span class="pill bad">Missing</span>'; }

  function loadConfig() {
    document.getElementById('conn-card').hidden = false;
    AP.api('/api/config').then(function (c) {
      var rows = [
        ['Opus host', '<span class="mono">' + esc(c.opusHost) + '</span>'],
        ['Workflow id', '<span class="mono">' + esc(c.workflowId) + '</span>'],
        ['Service key', yesNo(c.serviceKeyConfigured)],
        ['Workspace id', yesNo(c.workspaceConfigured)],
        ['Storage', c.storageDurable ? '<span class="pill ok">' + esc(c.storage) + '</span>' : '<span class="pill bad">In memory only — connect a KV / Redis store</span>'],
        ['Human Task webhook', '<span class="mono" style="word-break:break-all">' + esc(c.webhookUrl) + '</span><div class="hint">Paste this into the Human Task node (off-platform) in the Opus builder.' + (c.webhookSecretConfigured ? ' Replace &lt;WEBHOOK_SECRET&gt; with the value of that variable.' : ' Set WEBHOOK_SECRET to stop anyone else posting fake reviews.') + '</div>'],
        ['Review time limit shown', esc(c.reviewTimeoutMinutes) + ' minutes <span class="muted small">(REVIEW_TIMEOUT_MINUTES — keep it equal to the Human Task timeout in Opus)</span>'],
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
