// Tarka Assistant dashboard. Plain JS, no build step.
(function () {
  'use strict';

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: Object.assign({ 'X-Requested-With': 'fetch' }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
        throw new Error('signed out');
      }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : 'Request failed');
        return data;
      });
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- chat
  var log = document.getElementById('chat-log');
  var form = document.getElementById('composer');
  var input = document.getElementById('composer-input');
  var send = document.getElementById('composer-send');
  var statusEl = document.getElementById('chat-status');
  var busy = false;

  function scrollDown() {
    if (log) log.scrollTop = log.scrollHeight;
  }

  function lastId() {
    return Number((log && log.getAttribute('data-last-id')) || 0);
  }

  function appendMessages(list) {
    if (!log || !list || !list.length) return;
    var empty = document.getElementById('chat-empty');
    if (empty) empty.remove();
    var pending = log.querySelector('[data-pending]');
    if (pending) pending.remove();
    list.forEach(function (m) {
      if (log.querySelector('[data-id="' + m.id + '"]')) return;
      log.insertAdjacentHTML('beforeend', m.html);
      if (m.id > lastId()) log.setAttribute('data-last-id', String(m.id));
    });
    scrollDown();
  }

  function refresh() {
    if (!log) return Promise.resolve();
    return api('/api/messages?after=' + lastId()).then(function (data) {
      appendMessages(data.messages);
      if (data.approvalsHtml !== undefined) {
        var box = document.querySelector('[data-approvals-list]');
        if (box) box.innerHTML = data.approvalsHtml;
      }
      if (data.upcomingHtml !== undefined) {
        var up = document.querySelector('[data-upcoming-list]');
        if (up) up.innerHTML = data.upcomingHtml;
      }
    });
  }

  function setStatus(text, live) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('live', Boolean(live));
  }

  if (form && input) {
    scrollDown();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      send.disabled = true;
      input.value = '';
      input.style.height = '';
      var empty = document.getElementById('chat-empty');
      if (empty) empty.remove();
      log.insertAdjacentHTML('beforeend', '<div class="msg user" data-pending><div class="body"><p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p></div></div>');
      scrollDown();
      setStatus('Thinking', true);

      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ text: text }),
        credentials: 'same-origin',
      })
        .then(function (res) {
          if (!res.ok || !res.body) throw new Error('The message could not be sent.');
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buf = '';
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              buf += decoder.decode(r.value, { stream: true });
              var lines = buf.split('\n');
              buf = lines.pop();
              lines.forEach(function (line) {
                if (!line.trim()) return;
                var ev;
                try {
                  ev = JSON.parse(line);
                } catch (_) {
                  return;
                }
                if (ev.type === 'status') setStatus(ev.label, true);
                if (ev.type === 'error') setStatus(ev.message, false);
              });
              return pump();
            });
          }
          return pump();
        })
        .then(refresh)
        .then(function () {
          setStatus('', false);
        })
        .catch(function (err) {
          setStatus(err.message || 'Something went wrong. Try again.', false);
        })
        .finally(function () {
          busy = false;
          send.disabled = false;
          input.focus();
        });
    });
    // Proactive messages (briefs, reminders, call reports) show up without a reload.
    setInterval(function () {
      if (!busy && document.visibilityState === 'visible') refresh().catch(function () {});
    }, 20000);
  }

  // ---------------------------------------------------------------- clicks
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;

    if (t.hasAttribute('data-approval')) {
      var id = t.getAttribute('data-approval');
      var decision = t.getAttribute('data-decision');
      document.querySelectorAll('[data-approval="' + id + '"]').forEach(function (b) {
        b.disabled = true;
      });
      setStatus(decision === 'approved' ? 'Working on it' : 'Cancelling', true);
      api('/api/approvals/' + id, { decision: decision })
        .then(function () {
          document.querySelectorAll('[data-approval-card="' + id + '"]').forEach(function (el) {
            el.remove();
          });
          document.querySelectorAll('[data-approval="' + id + '"]').forEach(function (b) {
            b.remove();
          });
          return refresh();
        })
        .then(function () {
          setStatus('', false);
        })
        .catch(function (err) {
          setStatus(err.message, false);
        });
    }

    if (t.hasAttribute('data-link-telegram')) {
      t.disabled = true;
      api('/api/link/telegram', {})
        .then(function (data) {
          var hint = document.getElementById('link-hint');
          if (hint) hint.innerHTML = 'Opening Telegram. Press <strong>Start</strong> there to connect. <a href="' + data.url + '" target="_blank" rel="noopener">Open again</a>';
          window.open(data.url, '_blank', 'noopener');
        })
        .catch(function (err) {
          alert(err.message);
        })
        .finally(function () {
          t.disabled = false;
        });
    }

    if (t.hasAttribute('data-forget')) {
      var mid = t.getAttribute('data-forget');
      t.disabled = true;
      api('/api/memories/' + encodeURIComponent(mid) + '/forget', {})
        .then(function () {
          var row = document.querySelector('[data-memory-row="' + mid + '"]');
          if (row) row.remove();
        })
        .catch(function (err) {
          t.disabled = false;
          alert(err.message);
        });
    }

    if (t.hasAttribute('data-forget-all')) {
      if (!confirm('Forget everything it remembers about you? This cannot be undone.')) return;
      api('/api/memories/forget-all', {}).then(function () {
        window.location.reload();
      });
    }

    if (t.hasAttribute('data-routine')) {
      var rid = t.getAttribute('data-routine');
      var action = t.getAttribute('data-action');
      t.disabled = true;
      api('/api/routines/' + rid + '/' + action, {})
        .then(function () {
          window.location.reload();
        })
        .catch(function (err) {
          t.disabled = false;
          alert(err.message);
        });
    }

    if (t.hasAttribute('data-google-disconnect')) {
      api('/api/google/disconnect', {}).then(function () {
        window.location.reload();
      });
    }

    if (t.hasAttribute('data-identity-remove')) {
      api('/api/identities/' + t.getAttribute('data-identity-remove') + '/remove', {}).then(function () {
        window.location.reload();
      });
    }

    if (t.hasAttribute('data-delete-account')) {
      if (!confirm('Delete your account, memory and all data? This cannot be undone.')) return;
      api('/api/account/delete', {}).then(function () {
        window.location.href = '/';
      });
    }
  });

  // ---------------------------------------------------------------- settings
  var settings = document.getElementById('settings-form');
  if (settings) {
    settings.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(settings);
      var body = {
        name: f.get('name'),
        assistant_name: f.get('assistant_name'),
        city: f.get('city'),
        timezone: f.get('timezone'),
        brief_time: f.get('brief_time') || 'off',
        proactivity: f.get('proactivity'),
        quiet_start: f.get('quiet_start'),
        quiet_end: f.get('quiet_end'),
        meeting_nudges: f.get('meeting_nudges') === 'on',
        voice_replies: f.get('voice_replies') === 'on',
      };
      var st = document.getElementById('settings-status');
      st.textContent = 'Saving…';
      api('/api/settings', body)
        .then(function () {
          st.textContent = 'Saved.';
        })
        .catch(function (err) {
          st.textContent = err.message;
        });
    });
  }

  var modelForm = document.getElementById('model-form');
  if (modelForm) {
    modelForm.addEventListener('change', function (e) {
      var st = document.getElementById('model-status');
      st.textContent = 'Switching…';
      api('/api/settings', { model: e.target.value })
        .then(function () {
          st.textContent = 'Your next reply will use this model.';
        })
        .catch(function (err) {
          st.textContent = err.message;
        });
    });
  }
})();
