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
    clerk: 'Lands on New submission',
    approver: 'Lands on Pending reviews',
    admin: 'Sees everything',
  };
  var initial = function (name) { return esc(String(name || '?').replace(/^Demo\s+/, '').charAt(0).toUpperCase()); };

  AP.api('/api/demo', { allow401: true }).then(function (d) {
    if (!d || !d.enabled || !d.accounts.length) return;
    document.getElementById('demo').hidden = false;
    // Demo build: accounts are picked from the list, so the free email form
    // is hidden. It comes back when DEMO_MODE=false.
    form.hidden = true;
    var wrap = document.getElementById('demo-buttons');
    wrap.innerHTML = d.accounts.map(function (a, i) {
      var role = a.shownRole || a.role;
      var sub = a.kind === 'demo' ? (DEMO_TEXT[role] || '') : a.email;
      return '<div class="demo-item">' +
        '<button type="button" class="demo-account" data-i="' + i + '">' +
          '<span class="avatar">' + initial(a.name) + '</span>' +
          '<span class="who"><b>' + esc(a.name) + '</b><span>' + esc(sub) + '</span></span>' +
          '<span class="pill plain">' + esc(AP.ROLE_LABEL[role] || role) + '</span></button>' +
        (a.kind === 'user'
          ? '<form class="demo-pass" data-i="' + i + '" hidden novalidate>' +
              '<input type="password" autocomplete="current-password" placeholder="Password for ' + esc(a.name) + '" aria-label="Password">' +
              '<button class="btn primary small" type="submit">Sign in</button></form>'
          : '') +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(wrap.querySelectorAll('.demo-account'), function (b) {
      b.addEventListener('click', function () {
        var a = d.accounts[Number(b.getAttribute('data-i'))];
        var err = document.getElementById('demo-error');
        err.hidden = true;
        if (a.kind === 'user') {
          // Added users sign in with the password their admin gave them.
          Array.prototype.forEach.call(wrap.querySelectorAll('.demo-pass'), function (f) { f.hidden = f !== b.nextElementSibling ? true : !f.hidden; });
          var f = b.nextElementSibling;
          if (!f.hidden) f.querySelector('input').focus();
          return;
        }
        b.disabled = true;
        AP.api('/api/demo-login', { method: 'POST', body: { role: a.role }, allow401: true })
          .then(function (out) { location.replace(destination(out && out.home)); })
          .catch(function (e) { b.disabled = false; AP.showError(err, e); });
      });
    });

    Array.prototype.forEach.call(wrap.querySelectorAll('.demo-pass'), function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var a = d.accounts[Number(f.getAttribute('data-i'))];
        var input = f.querySelector('input');
        var btn2 = f.querySelector('button');
        var err = document.getElementById('demo-error');
        err.hidden = true;
        if (!input.value) { input.focus(); return; }
        btn2.disabled = true;
        btn2.textContent = 'Signing in…';
        AP.api('/api/login', { method: 'POST', body: { email: a.email, password: input.value }, allow401: true })
          .then(function (out) { location.replace(destination(out && out.home)); })
          .catch(function (e2) {
            btn2.disabled = false;
            btn2.textContent = 'Sign in';
            input.value = '';
            input.focus();
            AP.showError(err, e2);
          });
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
