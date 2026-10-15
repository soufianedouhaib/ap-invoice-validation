(function () {
  'use strict';
  // Read-only neighbouring areas. The records are owned elsewhere (vendor
  // master, procurement, treasury); these views show what the hub has seen
  // on the invoices it matched, and nothing here can be edited.
  var esc = AP.esc;
  var view = document.querySelector('main').getAttribute('data-view');
  var rows = [];
  var term = '';

  var VIEWS = {
    vendors: {
      lede: 'Suppliers that have invoiced through the hub, with what was approved and held for each.',
      source: 'Vendor records are kept in the vendor master by Procurement. To add or change a vendor, raise a vendor request with Procurement.',
      empty: 'No vendors yet. They appear once an invoice from them has been read.',
      head: ['Vendor', 'Vendor ID', 'Status', 'Invoices', 'Approved', 'Held', 'Last invoice'],
      num: [3, 4, 5],
      row: function (v) {
        return [
          '<strong>' + esc(v.name) + '</strong>', '<span class="mono">' + esc(v.vendorId || '—') + '</span>',
          v.status ? '<span class="pill ' + (v.status === 'ACTIVE' ? 'ok' : 'warn') + ' plain">' + esc(AP.humanKey(v.status.toLowerCase())) + '</span>' : '—',
          v.invoices, money(v.approved, v.currency), money(v.held, v.currency), esc(AP.fmtDate(v.lastInvoiceAt)),
        ];
      },
      hay: function (v) { return [v.name, v.vendorId, v.status].join(' '); },
    },
    orders: {
      lede: 'Purchase orders and goods receipts matched against invoices in the hub.',
      source: 'Purchase orders and goods receipts are raised in procurement. This list shows the ones the hub has matched an invoice against.',
      empty: 'No purchase orders yet. They appear once a purchase order number has been read from an invoice pack.',
      head: ['Purchase order', 'Goods receipt', 'Vendor', 'Latest invoice', 'Invoices', 'Match', 'Matched on'],
      num: [4],
      row: function (o) {
        return [
          o.poNumber ? '<strong>' + esc(o.poNumber) + '</strong>' : '<span class="muted">Not read</span>',
          o.grNumber ? esc(o.grNumber) : '<span class="muted">Not read</span>', esc(o.vendor || '—'),
          '<a href="/case.html?id=' + encodeURIComponent(o.caseId) + '">' + esc(o.invoiceNumber || 'Invoice') + '</a>', o.invoices,
          '<span class="pill ' + tone(o.state) + ' plain">' + esc(o.state) + '</span>', esc(AP.fmtDate(o.submittedAt)),
        ];
      },
      hay: function (o) { return [o.poNumber, o.grNumber, o.vendor, o.invoiceNumber, o.state].join(' '); },
    },
    payments: {
      lede: 'Invoices approved for payment, with when each falls due under the vendor’s terms.',
      source: 'Payments are released by Treasury in the scheduled payment run. This list shows what the hub has approved; it does not release money.',
      empty: 'Nothing approved for payment yet.',
      head: ['Vendor', 'Invoice', 'Amount', 'Terms', 'Approved on', 'Due'],
      num: [2],
      row: function (p) {
        var due = p.dueAt ? new Date(p.dueAt) : null;
        var soon = due && due - Date.now() < 7 * 86400000;
        return [
          '<strong>' + esc(p.vendor || '—') + '</strong>',
          '<a href="/case.html?id=' + encodeURIComponent(p.caseId) + '">' + esc(p.invoiceNumber || 'Invoice') + '</a>',
          money(p.amount, p.currency), esc(p.terms || '—'), esc(AP.fmtDate(p.approvedAt)),
          due ? (soon ? '<span class="pill warn plain">' + esc(fmtDay(due)) + '</span>' : esc(fmtDay(due))) : '—',
        ];
      },
      hay: function (p) { return [p.vendor, p.invoiceNumber, p.terms].join(' '); },
    },
  };

  function fmtDay(d) { return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }
  function money(v, ccy) { return typeof v === 'number' ? esc((ccy ? ccy + ' ' : '') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : '—'; }
  function tone(state) { return /finish|held/i.test(state) ? 'bad' : /approval|part/i.test(state) ? 'warn' : /match/i.test(state) && !/matched/i.test(state) ? 'info' : 'ok'; }

  var V = VIEWS[view];
  AP.boot({ active: view }, function () {
    document.getElementById('lede').textContent = V.lede;
    document.getElementById('source').textContent = V.source;
    document.getElementById('search').addEventListener('input', function (e) { term = e.target.value.trim().toLowerCase(); render(); });
    AP.api('/api/ledger').then(function (d) { rows = d[view] || []; render(); },
      function (err) { AP.showError(document.getElementById('error'), err); document.getElementById('table-wrap').innerHTML = ''; });
  });

  function render() {
    var list = rows.filter(function (r) { return !term || V.hay(r).toLowerCase().indexOf(term) !== -1; });
    document.getElementById('count-text').textContent = rows.length ? (list.length === rows.length ? rows.length + ' total' : list.length + ' of ' + rows.length + ' shown') : '';
    var wrap = document.getElementById('table-wrap');
    if (!list.length) { wrap.innerHTML = '<div class="empty">' + (rows.length ? 'Nothing matches the search.' : V.empty) + '</div>'; return; }
    wrap.innerHTML = '<table><thead><tr>' + V.head.map(function (h, i) { return '<th' + (V.num.indexOf(i) !== -1 ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr>' + V.row(r).map(function (cell, i) { return '<td' + (V.num.indexOf(i) !== -1 ? ' class="num"' : '') + '>' + cell + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }
})();
