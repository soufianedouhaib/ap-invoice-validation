(function () {
  'use strict';
  var form = document.getElementById('login-form');
  var btn = document.getElementById('login-btn');
  var errEl = document.getElementById('login-error');

  function nextUrl() {
    var n = AP.qs('next');
    // Only same-site paths, never an absolute URL.
    return n && n.charAt(0) === '/' && n.charAt(1) !== '/' ? n : '/';
  }

  // Already signed in? Skip the form.
  AP.api('/api/me', { allow401: true }).then(function (me) {
    if (me && me.user) location.replace(nextUrl());
  }, function () { /* show the form */ });

  var DEMO_TEXT = {
    clerk: 'Submits invoice packs and follows their own cases',
    approver: 'Decides on exceptions in the review queue',
    admin: 'Sees everything, manages users and settings',
  };
  AP.api('/api/demo', { allow401: true }).then(function (d) {
    if (!d || !d.enabled || !d.accounts.length) return;
    document.getElementById('demo').hidden = false;
    document.getElementById('form-intro').hidden = true;
    document.getElementById('form-slot').appendChild(form);
    var wrap = document.getElementById('demo-buttons');
    wrap.innerHTML = d.accounts.map(function (a) {
      return '<button type="button" class="sample" data-role="' + AP.esc(a.role) + '">' +
        '<span class="sample-title">' + AP.esc(a.name) + '</span>' +
        '<span class="sample-desc">' + AP.esc(DEMO_TEXT[a.role] || '') + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-role]'), function (b) {
      b.addEventListener('click', function () {
        var err = document.getElementById('demo-error');
        err.hidden = true;
        b.disabled = true;
        AP.api('/api/demo-login', { method: 'POST', body: { role: b.getAttribute('data-role') }, allow401: true })
          .then(function () { location.replace(nextUrl()); })
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
      .then(function () { location.replace(nextUrl()); })
      .catch(function (err) {
        AP.showError(errEl, err);
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  });
})();
