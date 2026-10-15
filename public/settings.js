(function () {
  'use strict';
  var esc = AP.esc;

  AP.boot({ active: 'settings' }, function (user, me) {
    document.getElementById('account').innerHTML =
      '<dt>Name</dt><dd>' + esc(user.name) + '</dd>' +
      '<dt>Email</dt><dd>' + esc(user.email) + '</dd>' +
      '<dt>Role</dt><dd>' + esc(AP.ROLE_LABEL[user.role] || user.role) + '</dd>';
    document.getElementById('pw-form').addEventListener('submit', changePassword);
    wireTheme();
    if (user.role === 'admin') {
      document.getElementById('settings-lede').textContent = 'Your account, preferences and the approval rules.';
      loadRules(me);
    }
  });

  function wireTheme() {
    var root = document.documentElement;
    function current() { return root.getAttribute('data-theme') || 'system'; }
    function paint() {
      Array.prototype.forEach.call(document.querySelectorAll('[data-theme-choice]'), function (b) {
        b.setAttribute('aria-checked', b.getAttribute('data-theme-choice') === current() ? 'true' : 'false');
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-choice]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-theme-choice');
        if (v === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', v);
        try { if (v === 'system') localStorage.removeItem('ap-theme'); else localStorage.setItem('ap-theme', v); } catch (e) { /* ignore */ }
        paint();
      });
    });
    document.getElementById('theme-toggle').addEventListener('click', function () { setTimeout(paint, 0); });
    paint();
  }

  function loadRules(me) {
    document.getElementById('rules-card').hidden = false;
    AP.api('/api/config').then(function (c) {
      document.getElementById('rules').innerHTML =
        '<dt>Time to decide</dt><dd>' + esc(c.reviewTimeoutMinutes) + ' minutes from when a review arrives</dd>' +
        '<dt>Own invoices</dt><dd>' + (c.allowSelfReview ? 'An approver may decide on an invoice they submitted' : 'An approver cannot decide on an invoice they submitted') + '</dd>' +
        '<dt>Sign-in</dt><dd>' + (c.demoMode ? 'Pick an account on the sign-in page' : 'Email and password') + '</dd>';
    }, function (err) {
      document.getElementById('rules').innerHTML = '<dt>Rules</dt><dd>' + esc(err.message) + '</dd>';
    });
  }

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
})();
