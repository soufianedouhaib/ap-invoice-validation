(function () {
  'use strict';
  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var errEl = document.getElementById('login-error');
  var esc = AP.esc;

  // A deep link (a case, a review) wins; otherwise each role lands on its own
  // home: a clerk on New submission, an approver on Pending reviews.
  function destination(home) {
    var n = AP.qs('next');
    var safe = n && n.charAt(0) === '/' && n.charAt(1) !== '/' && n !== '/' && n.indexOf('/index.html') !== 0 && n.indexOf('/login') !== 0;
    return safe ? n : (home || '/');
  }

  AP.api('/api/me', { allow401: true }).then(function (me) {
    if (me && me.user) location.replace(destination(me.home));
  }, function () { /* show the form */ });

  var DEMO_TEXT = {
    clerk: { email: 'demo.clerk@demo.local', does: 'Lands on New submission' },
    approver: { email: 'demo.approver@demo.local', does: 'Lands on Pending reviews' },
    admin: { email: 'demo.admin@demo.local', does: 'Sees everything' },
  };
  AP.api('/api/demo', { allow401: true }).then(function (d) {
    if (!d || !d.enabled || !d.accounts.length) return;
    document.getElementById('demo').hidden = false;
    // Demo build: the one-click accounts are the only way in, so the email
    // form is hidden. It comes back when DEMO_MODE=false.
    form.hidden = true;
    var wrap = document.getElementById('demo-buttons');
    wrap.innerHTML = d.accounts.map(function (a) {
      var t = DEMO_TEXT[a.role] || {};
      return '<button type="button" class="demo-account" data-role="' + esc(a.role) + '">' +
        '<span class="avatar">' + esc((a.name || '?').replace(/^Demo\s+/, '').charAt(0)) + '</span>' +
        '<span class="who"><b>' + esc(a.name) + '</b><span>' + esc(t.does || t.email || '') + '</span></span>' +
        '<span class="pill plain">' + esc(AP.ROLE_LABEL[a.role] || a.role) + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-role]'), function (b) {
      b.addEventListener('click', function () {
        var err = document.getElementById('demo-error');
        err.hidden = true;
        b.disabled = true;
        AP.api('/api/demo-login', { method: 'POST', body: { role: b.getAttribute('data-role') }, allow401: true })
          .then(function (out) { location.replace(destination(out && out.home)); })
          .catch(function (e) { b.disabled = false; AP.showError(err, e); });
      });
    });
  }, function () { /* no demo */ });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    if (!email || !password) {
      AP.showError(errEl, new Error('Enter your email and password.'));
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    AP.api('/api/login', { method: 'POST', body: { email: email, password: password }, allow401: true })
      .then(function (out) { location.replace(destination(out && out.home)); })
      .catch(function (err) {
        AP.showError(errEl, err);
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  });
})();
