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
