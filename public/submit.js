(function () {
  'use strict';
  var esc = AP.esc;
  var MAX = 10 * 1024 * 1024;
  var SLOTS = [
    { key: 'invoice', title: 'Invoice', sub: 'The vendor’s invoice' },
    { key: 'purchaseOrder', title: 'Purchase Order', sub: 'The PO the invoice bills against' },
    { key: 'goodsReceipt', title: 'Goods Receipt', sub: 'Proof the goods or services were received' },
  ];
  // key -> { state: 'empty'|'uploading'|'done'|'error', name, fileUrl, message }
  var slots = {};
  var submitting = false;

  var SAMPLES = {
    a: { reference: 'INV-DFM-24017', note: 'Sample A: clean match', prefix: 'sample-a-clean' },
    b: { reference: 'INV-MTS-55310', note: 'Sample B: exceptions', prefix: 'sample-b-exceptions' },
  };
  var SAMPLE_FILE = { invoice: 'invoice', purchaseOrder: 'purchase-order', goodsReceipt: 'goods-receipt' };

  AP.boot({ active: 'submit', roles: ['clerk', 'admin'] }, function () {
    SLOTS.forEach(function (s) { slots[s.key] = { state: 'empty' }; });
    renderZones();
    document.getElementById('submit-form').addEventListener('submit', onSubmit);
    Array.prototype.forEach.call(document.querySelectorAll('[data-sample]'), function (b) {
      b.addEventListener('click', function () { loadSample(b.getAttribute('data-sample')); });
    });
    document.getElementById('sample-links').innerHTML = ['a', 'b'].map(function (k) {
      return SLOTS.map(function (s) {
        var f = SAMPLES[k].prefix + '-' + SAMPLE_FILE[s.key] + '.pdf';
        return '<a href="/samples/' + f + '" target="_blank" rel="noopener">' + k.toUpperCase() + ' ' + esc(s.title) + '</a>';
      }).join(' · ');
    }).join(' &nbsp;|&nbsp; ');
  });

  function loadSample(k) {
    var sm = SAMPLES[k];
    if (!sm || submitting) return;
    document.getElementById('reference').value = sm.reference;
    document.getElementById('note').value = sm.note;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sample]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-sample') === k);
    });
    SLOTS.forEach(function (s) {
      var name = sm.prefix + '-' + SAMPLE_FILE[s.key] + '.pdf';
      slots[s.key] = { state: 'uploading', name: name };
    });
    renderZones();
    SLOTS.forEach(function (s) {
      var name = sm.prefix + '-' + SAMPLE_FILE[s.key] + '.pdf';
      fetch('/samples/' + name).then(function (res) {
        if (!res.ok) throw new Error('Sample file missing (' + res.status + ').');
        return res.blob();
      }).then(function (blob) {
        take(s.key, new File([blob], name, { type: 'application/pdf' }));
      }, function (err) {
        slots[s.key] = { state: 'error', name: name, message: err.message };
        renderZones();
      });
    });
  }

  function renderZones() {
    var root = document.getElementById('dropzones');
    root.innerHTML = SLOTS.map(function (s) {
      var st = slots[s.key];
      var cls = st.state === 'done' ? ' done' : st.state === 'error' ? ' error' : '';
      var stateHtml = '';
      if (st.state === 'uploading') stateHtml = '<div class="dz-state busy">Uploading…</div>';
      if (st.state === 'done') stateHtml = '<div class="dz-state ok">✓ Uploaded</div>';
      if (st.state === 'error') stateHtml = '<div class="dz-state bad">' + esc(st.message) + '</div>';
      return '<div class="dropzone' + cls + '" data-key="' + s.key + '">' +
        '<div class="dz-title">' + esc(s.title) + ' <span class="muted small">· required</span></div>' +
        '<div class="dz-sub">' + esc(s.sub) + '. PDF only, up to 10 MB.</div>' +
        (st.name ? '<div class="dz-file mono">' + esc(st.name) + '</div>' : '<div class="dz-file muted">Drop a PDF here or click to choose</div>') +
        stateHtml +
        (st.state === 'done' || st.state === 'error' ? '<button type="button" class="btn small dz-remove" data-remove="' + s.key + '">Replace</button>' : '') +
        (st.state === 'empty' ? '<input type="file" accept="application/pdf,.pdf" aria-label="Choose ' + esc(s.title) + ' PDF">' : '') +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(root.querySelectorAll('.dropzone'), function (zone) {
      var key = zone.getAttribute('data-key');
      var input = zone.querySelector('input[type=file]');
      if (input) input.addEventListener('change', function () { if (input.files[0]) take(key, input.files[0]); });
      zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('drag'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('drag'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        zone.classList.remove('drag');
        if (slots[key].state === 'uploading') return;
        var f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) take(key, f);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-remove]'), function (b) {
      b.addEventListener('click', function () { slots[b.getAttribute('data-remove')] = { state: 'empty' }; renderZones(); });
    });
    updateSubmit();
  }

  function take(key, file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      slots[key] = { state: 'error', name: file.name, message: 'That is not a PDF.' };
      return renderZones();
    }
    if (file.size > MAX) {
      slots[key] = { state: 'error', name: file.name, message: 'Larger than 10 MB.' };
      return renderZones();
    }
    slots[key] = { state: 'uploading', name: file.name };
    renderZones();
    uploadFile(file).then(function (fileUrl) {
      slots[key] = { state: 'done', name: file.name, fileUrl: fileUrl };
      renderZones();
    }, function (err) {
      slots[key] = { state: 'error', name: file.name, message: err.message || 'Upload failed.' };
      renderZones();
    });
  }

  // Direct-to-storage first (works for any size); fall back to the server
  // proxy if the browser is not allowed to PUT to storage directly.
  function uploadFile(file) {
    return AP.api('/api/upload-url', { method: 'POST', body: { fileName: file.name.replace(/\.PDF$/, '.pdf'), size: file.size } })
      .then(function (d) {
        return fetch(d.presignedUrl, { method: 'PUT', body: file }).then(function (res) {
          if (!res.ok) throw new Error('direct upload ' + res.status);
          return d.fileUrl;
        });
      })
      .catch(function (err) {
        if (err.status) throw err; // a real error from our own API, not a blocked PUT
        if (file.size > 4 * 1024 * 1024) {
          throw new Error('Upload blocked. Files over 4 MB need direct upload to be allowed; ask your admin.');
        }
        var fd = new FormData();
        fd.append('file', file, file.name);
        return AP.api('/api/upload', { method: 'POST', body: fd }).then(function (d) { return d.fileUrl; });
      });
  }

  function ready() {
    return SLOTS.every(function (s) { return slots[s.key].state === 'done'; });
  }

  function updateSubmit() {
    var btn = document.getElementById('submit-btn');
    var busy = SLOTS.some(function (s) { return slots[s.key].state === 'uploading'; });
    btn.disabled = submitting || !ready();
    document.getElementById('submit-hint').textContent = submitting ? 'Starting the workflow…' : busy ? 'Waiting for uploads to finish…' : ready() ? 'Takes a few minutes. You can leave the page; the case keeps running.' : 'Add all three PDFs to continue.';
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!ready() || submitting) return;
    submitting = true;
    updateSubmit();
    var errEl = document.getElementById('error');
    errEl.hidden = true;
    var files = {};
    SLOTS.forEach(function (s) { files[s.key] = { fileUrl: slots[s.key].fileUrl, name: slots[s.key].name }; });
    AP.api('/api/cases', {
      method: 'POST',
      body: { files: files, reference: document.getElementById('reference').value, note: document.getElementById('note').value },
    }).then(function (d) {
      location.href = '/case.html?id=' + encodeURIComponent(d.case.jobId);
    }, function (err) {
      submitting = false;
      updateSubmit();
      AP.showError(errEl, err);
    });
  }
})();
