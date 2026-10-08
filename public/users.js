(function () {
  'use strict';
  var esc = AP.esc;
  var users = [];
  var editing = null; // user being edited, or null when adding
  var me = null;

  AP.boot({ active: 'users', roles: ['admin'] }, function (user) {
    me = user;
    document.getElementById('add-btn').addEventListener('click', function () { open(null); });
    document.getElementById('cancel-btn').addEventListener('click', close);
    document.getElementById('modal').addEventListener('click', function (e) { if (e.target === this) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.getElementById('user-form').addEventListener('submit', save);
    document.getElementById('del-cancel').addEventListener('click', closeDelete);
    document.getElementById('del-ok').addEventListener('click', confirmDelete);
    document.getElementById('del-modal').addEventListener('click', function (e) { if (e.target === this) closeDelete(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDelete(); });
    document.getElementById('f-password').value = suggestPassword();
    load();
  });

  function suggestPassword() {
    var chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    var buf = new Uint32Array(14);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  function load() {
    AP.api('/api/users').then(function (d) { users = d.users || []; render(); }, function (err) { AP.showError(document.getElementById('error'), err); });
  }

  function render() {
    var wrap = document.getElementById('wrap');
    if (!users.length) { wrap.innerHTML = '<div class="empty">No users.</div>'; return; }
    var order = { admin: 0, approver: 1, clerk: 2 };
    var sorted = users.slice().sort(function (a, b) { return (order[a.role] - order[b.role]) || a.name.localeCompare(b.name); });
    wrap.innerHTML = '<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>' +
      sorted.map(function (u) {
        return '<tr><td><strong>' + esc(u.name) + '</strong>' + (u.id === me.id ? ' <span class="muted small">(you)</span>' : '') + '</td>' +
          '<td>' + esc(u.email) + '</td>' +
          '<td>' + esc(AP.ROLE_LABEL[u.role] || u.role) + '</td>' +
          '<td>' + (u.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Disabled</span>') + '</td>' +
          '<td>' + esc(AP.fmtDate(u.createdAt)) + '</td>' +
          '<td class="num"><span class="row-actions"><button type="button" class="btn small" data-edit="' + esc(u.id) + '">Edit</button>' +
          (u.id === me.id ? '' : '<button type="button" class="btn small danger" data-del="' + esc(u.id) + '">Delete</button>') + '</span></td></tr>';
      }).join('') + '</tbody></table>';
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-edit]'), function (b) {
      b.addEventListener('click', function () {
        var u = users.filter(function (x) { return x.id === b.getAttribute('data-edit'); })[0];
        open(u);
      });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        var u = users.filter(function (x) { return x.id === b.getAttribute('data-del'); })[0];
        askDelete(u);
      });
    });
  }

  // Asked on the page, not in a browser dialog. Your own account has no
  // Delete button, and the server refuses it too.
  var deleting = null;
  function askDelete(u) {
    deleting = u;
    document.getElementById('del-name').textContent = u.name + ' (' + u.email + ')';
    document.getElementById('del-error').hidden = true;
    document.getElementById('del-modal').hidden = false;
    document.getElementById('del-cancel').focus();
  }
  function closeDelete() { document.getElementById('del-modal').hidden = true; deleting = null; }
  function confirmDelete() {
    if (!deleting) return;
    var btn = document.getElementById('del-ok');
    btn.disabled = true;
    AP.api('/api/users/' + encodeURIComponent(deleting.id), { method: 'DELETE' }).then(function () {
      btn.disabled = false;
      closeDelete();
      load();
    }, function (err) { btn.disabled = false; AP.showError(document.getElementById('del-error'), err); });
  }

  function open(u) {
    editing = u;
    document.getElementById('modal-title').textContent = u ? 'Edit ' + u.name : 'Add user';
    document.getElementById('f-name').value = u ? u.name : '';
    document.getElementById('f-email').value = u ? u.email : '';
    document.getElementById('email-field').hidden = Boolean(u);
    document.getElementById('f-role').value = u ? u.role : 'clerk';
    document.getElementById('active-field').hidden = !u;
    document.getElementById('f-active').value = u && !u.active ? 'false' : 'true';
    document.getElementById('f-password').value = u ? '' : suggestPassword();
    document.getElementById('pw-label').textContent = u ? 'Reset password (optional)' : 'Temporary password';
    document.getElementById('pw-hint').textContent = u ? 'Leave empty to keep the current password.' : 'Share it with the person directly. They can change it under Settings.';
    var self = u && u.id === me.id;
    document.getElementById('f-role').disabled = Boolean(self);
    document.getElementById('f-active').disabled = Boolean(self);
    document.getElementById('form-error').hidden = true;
    document.getElementById('modal').hidden = false;
    document.getElementById('f-name').focus();
  }

  function close() { document.getElementById('modal').hidden = true; }

  function save(e) {
    e.preventDefault();
    var btn = document.getElementById('save-btn');
    var errEl = document.getElementById('form-error');
    errEl.hidden = true;
    var body = {
      name: document.getElementById('f-name').value.trim(),
      role: document.getElementById('f-role').value,
    };
    var pw = document.getElementById('f-password').value;
    if (editing) {
      if (editing.id !== me.id) body.active = document.getElementById('f-active').value === 'true';
      else delete body.role;
      if (pw) body.password = pw;
    } else {
      body.email = document.getElementById('f-email').value.trim();
      body.password = pw;
    }
    btn.disabled = true;
    var req = editing
      ? AP.api('/api/users/' + encodeURIComponent(editing.id), { method: 'PATCH', body: body })
      : AP.api('/api/users', { method: 'POST', body: body });
    req.then(function () { btn.disabled = false; close(); load(); }, function (err) { btn.disabled = false; AP.showError(errEl, err); });
  }
})();
