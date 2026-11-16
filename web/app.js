/**
 * Demand-response analysis client.
 *
 * Plain ES modules, no build step. State is held in one object; every render
 * reads from it. The server does all the analysis — the client only formats and
 * never recomputes a baseline.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  boot: null,
  report: null,
  task: null,
  reports: [],
  tasks: [],
  pollTimer: null,
  compare: null,
  chartFocus: null,
  dataQuality: null,
  dqVersionId: null,
  intervalFilter: 'all',
};

const fmt = {
  num(x, d = 1) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    return x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  int(x) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    return Math.round(x).toLocaleString();
  },
  pct(x, d = 1) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    return `${x.toFixed(d)}%`;
  },
  ci(ci, d = 0) {
    if (!ci) return '—';
    return `${fmt.num(ci[0], d)} – ${fmt.num(ci[1], d)}`;
  },
  time(ts) {
    if (!ts) return '—';
    const iso = new Date(ts).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  },
  mins(m) {
    const sign = m < 0 ? '-' : '+';
    const a = Math.abs(m);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Mount point of the app, taken from the <base href> the server injects when it
 * is served under a prefix (DR_BASE_PATH). Empty means "same origin root".
 */
const API_BASE = (() => {
  try {
    const href = document.querySelector('base')?.getAttribute('href');
    if (href && href !== '/') return href.replace(/\/+$/, '');
  } catch {
    /* no base element */
  }
  return '';
})();

async function api(path, init) {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

function flash(kind, html) {
  const el = $('#flash');
  if (!kind) {
    el.hidden = true;
    el.className = 'flash';
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.className = `flash ${kind}`;
  el.innerHTML = kind === 'loading' ? `<span class="loading-line"><span class="spinner" aria-hidden="true"></span>${html}</span>` : html;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  flash('loading', 'Loading state …');
  try {
    state.boot = await api('/api/state');
    state.reports = state.boot.reports;
    state.tasks = state.boot.tasks;
    state.dataQuality = state.boot.dataQuality;
    populateVersions();
    populateSites();
    populateEvents();
    populateExclusions(state.boot.defaults);
    renderTasks();
    renderDataQuality();
    flash(null);
    if (state.reports.length) {
      await openReport(state.reports[0].id);
    }
  } catch (err) {
    flash('error', `Could not load the application: ${esc(err.message)}`);
  }
}

function populateVersions() {
  const sel = $('#version-select');
  sel.innerHTML = state.boot.versions
    .map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`)
    .join('');
  sel.value = state.boot.latestDatasetVersionId;
  sel.addEventListener('change', () => {
    $('#run-hint').textContent = `Next run will pin ${sel.value}. Existing reports keep the version they were built on.`;
  });
  const dq = $('#dq-version');
  dq.innerHTML = sel.innerHTML;
  dq.value = state.boot.latestDatasetVersionId;
  state.dqVersionId = dq.value;
  dq.addEventListener('change', () => {
    state.dqVersionId = dq.value;
    renderDataQuality();
  });
}

function sitesForEvent(ev) {
  return state.boot.sites.filter((s) => ev.siteIds.includes(s.id));
}

function populateSites() {
  const sel = $('#site-select');
  sel.innerHTML = state.boot.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.timezone)}</option>`).join('');
}

function populateEvents() {
  const sel = $('#event-select');
  sel.innerHTML = state.boot.events
    .map((e) => {
      const tagLabel = e.status === 'cancelled' ? ' (cancelled)' : e.revisionCount > 1 ? ` (${e.revisionCount} revisions)` : '';
      return `<option value="${esc(e.id)}">${esc(e.name)}${tagLabel}</option>`;
    })
    .join('');
  sel.addEventListener('change', () => {
    filterSitesForEvent();
    populateRevisions();
  });
  filterSitesForEvent();
  populateRevisions();
}

function filterSitesForEvent() {
  const ev = state.boot.events.find((e) => e.id === $('#event-select').value);
  const sel = $('#site-select');
  const allowed = ev ? sitesForEvent(ev).map((s) => s.id) : state.boot.sites.map((s) => s.id);
  for (const opt of sel.options) opt.hidden = !allowed.includes(opt.value);
  if (!allowed.includes(sel.value) && allowed.length) sel.value = allowed[0];
}

function populateRevisions() {
  const ev = state.boot.events.find((e) => e.id === $('#event-select').value);
  const sel = $('#revision-select');
  if (!ev) {
    sel.innerHTML = '';
    return;
  }
  sel.innerHTML =
    `<option value="">Latest (rev ${ev.latestRevision})</option>` +
    ev.revisions
      .map((r) => {
        const when = r.localStart ? `${r.localStart}–${r.localEnd ?? '?'}` : r.startUtc ? `${fmt.time(r.startUtc)}` : 'window unresolved';
        const st = r.status === 'cancelled' ? ' — cancelled' : '';
        return `<option value="${esc(r.id)}"${r.id === ev.latestRevisionId ? '' : ''}>rev ${r.revision} · ${esc(when)}${st}</option>`;
      })
      .join('');
  sel.onchange = updateRevisionHint;
  updateRevisionHint();
}

function updateRevisionHint() {
  const ev = state.boot.events.find((e) => e.id === $('#event-select').value);
  const rid = $('#revision-select').value;
  const rev = ev?.revisions.find((r) => r.id === rid) ?? ev?.revisions[ev.revisions.length - 1];
  const hint = $('#revision-hint');
  if (!rev) {
    hint.textContent = '';
    return;
  }
  const bits = [`rev ${rev.revision}`, rev.status, rev.timeBasis === 'utc' ? 'UTC basis' : 'site-local basis'];
  if (rev.cancellationReason) bits.push(`cancelled: ${rev.cancellationReason}`);
  if (rev.supersedesRevisionId) bits.push(`supersedes ${rev.supersedesRevisionId}`);
  hint.textContent = bits.join(' · ');
}

/* -------------------------------------------------------------- exclusions */

const RANGE_FIELDS = [
  ['minActualCoverage', (v) => `${Math.round(v * 100)}%`],
  ['minDayCoverage', (v) => `${Math.round(v * 100)}%`],
  ['lookbackDays', (v) => `${v} days`],
  ['weatherCorrection', (v) => (v ? 'on' : 'off')],
];
const CHECK_FIELDS = [
  'excludeUnverifiedProduction',
  'excludeHolidays',
  'excludeEventDays',
  'treatEstimatedAsMissing',
  'excludeMeterExchangeDays',
  'excludeDstTransitionDays',
];
const STATUSES = [
  ['planned_maintenance', 'Planned maintenance'],
  ['unplanned_shutdown', 'Unplanned shutdown'],
  ['reduced', 'Reduced output'],
  ['non_routine', 'Non-routine'],
];

function populateExclusions(defaults) {
  $('#ex-autoPolicy').value = defaults.autoPolicy;
  $('#ex-methodOverride').value = defaults.methodOverride ?? '';
  for (const f of CHECK_FIELDS) $(`#ex-${f}`).checked = Boolean(defaults[f]);
  for (const [key, label] of RANGE_FIELDS) {
    const el = $(`#ex-${key}`);
    if (!el) continue;
    const toInput = typeof defaults[key] === 'boolean' ? (defaults[key] ? 1 : 0) : Number(defaults[key]);
    el.value = toInput;
    const out = $(`#out-${key}`);
    if (out) out.textContent = label(toInput);
    // oninput, not addEventListener: the reset button re-populates the form and
    // must not stack duplicate handlers.
    el.oninput = () => {
      if (out) out.textContent = label(Number(el.value));
    };
  }
  const chips = $('#ex-production-statuses');
  chips.innerHTML = STATUSES.map(
    ([id, label]) =>
      `<label class="chip${defaults.excludeProductionStatuses.includes(id) ? ' on' : ''}"><input type="checkbox" value="${id}"${
        defaults.excludeProductionStatuses.includes(id) ? ' checked' : ''
      } /><span>${esc(label)}</span></label>`,
  ).join('');
  $$('#ex-production-statuses input').forEach((cb) =>
    cb.addEventListener('change', () => cb.closest('.chip').classList.toggle('on', cb.checked)),
  );
  $('#reset-exclusions').addEventListener('click', () => populateExclusions(state.boot.defaults));
}

function readExclusions() {
  const out = {
    autoPolicy: $('#ex-autoPolicy').value,
    methodOverride: $('#ex-methodOverride').value || null,
    excludeProductionStatuses: $$('#ex-production-statuses input:checked').map((cb) => cb.value),
  };
  for (const f of CHECK_FIELDS) out[f] = $(`#ex-${f}`).checked;
  for (const [key] of RANGE_FIELDS) {
    const el = $(`#ex-${key}`);
    if (!el) continue;
    out[key] = key === 'weatherCorrection' ? Number(el.value) === 1 : Number(el.value);
  }
  return out;
}

/* ------------------------------------------------------------------- tasks */

async function runAnalysis(e) {
  e?.preventDefault();
  const btn = $('#run-btn');
  btn.disabled = true;
  flash('loading', 'Task queued …');
  try {
    const payload = {
      label: buildLabel(),
      siteId: $('#site-select').value,
      eventId: $('#event-select').value,
      eventRevisionId: $('#revision-select').value || null,
      datasetVersionId: $('#version-select').value,
      scope: $('#validation-mode').checked ? 'training_validation' : 'event',
      validationDate: $('#validation-mode').checked ? $('#validation-date').value || null : null,
      exclusions: readExclusions(),
    };
    if (payload.scope === 'training_validation' && !payload.validationDate) {
      throw new Error('Pick a validation date first.');
    }
    const { task } = await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
    state.task = task;
    await refreshTasks();
    watchTask(task.id);
  } catch (err) {
    flash('error', `Could not start the analysis: ${esc(err.message)}`);
    btn.disabled = false;
  }
}

function buildLabel() {
  const site = state.boot.sites.find((s) => s.id === $('#site-select').value);
  const ev = state.boot.events.find((e) => e.id === $('#event-select').value);
  const revId = $('#revision-select').value;
  const rev = ev?.revisions.find((r) => r.id === revId);
  const base = `${site?.name ?? 'Site'} · ${ev?.name ?? 'Event'}`;
  const tail = rev ? ` · rev ${rev.revision}` : '';
  const mode = $('#validation-mode').checked ? ` · validate ${$('#validation-date').value}` : '';
  return base + tail + mode;
}

function watchTask(id) {
  clearInterval(state.pollTimer);
  const tick = async () => {
    try {
      const data = await api(`/api/tasks/${id}`);
      state.task = data.task;
      renderTasks();
      const t = data.task;
      if (t.status === 'queued' || t.status === 'running') {
        flash('loading', `${esc(t.step)} … ${Math.round(t.progress * 100)}%`);
        return;
      }
      clearInterval(state.pollTimer);
      $('#run-btn').disabled = false;
      if (t.status === 'succeeded' && t.reportIds.length) {
        flash(null);
        await refreshReports();
        await openReport(t.reportIds[t.reportIds.length - 1]);
      } else if (t.status === 'interrupted') {
        flash('error', `${esc(t.error ?? 'Task interrupted.')} Restore it from the task list.`);
      } else if (t.status === 'cancelled') {
        flash('error', 'Task cancelled.');
      } else {
        flash('error', `Task failed: ${esc(t.error ?? 'unknown error')}`);
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      $('#run-btn').disabled = false;
      flash('error', `Lost contact with the task: ${esc(err.message)}`);
    }
  };
  tick();
  state.pollTimer = setInterval(tick, 350);
}

async function refreshTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks;
  renderTasks();
}

async function refreshReports() {
  const data = await api('/api/reports');
  state.reports = data.reports;
  populateCompareSelects();
}

function renderTasks() {
  const list = $('#task-list');
  if (!state.tasks.length) {
    list.innerHTML = '<li class="empty-line">No tasks yet. Run an analysis to create one.</li>';
    return;
  }
  list.innerHTML = state.tasks
    .map((t) => {
      const active = state.task?.id === t.id;
      const pct = Math.round((t.progress ?? 0) * 100);
      const statusTag =
        t.status === 'succeeded'
          ? '<span class="tag good">done</span>'
          : t.status === 'failed'
            ? '<span class="tag bad">failed</span>'
            : t.status === 'interrupted'
              ? '<span class="tag warn">interrupted</span>'
              : t.status === 'cancelled'
                ? '<span class="tag plain">cancelled</span>'
                : `<span class="tag">${esc(t.status)}</span>`;
      const reports = t.reportIds.length
        ? `<button class="mini" data-open-report="${esc(t.reportIds[t.reportIds.length - 1])}">Open report</button>`
        : '';
      const restore =
        t.status !== 'running' && t.status !== 'queued'
          ? `<button class="mini" data-restore="${esc(t.id)}">Restore</button>`
          : `<button class="mini" data-cancel="${esc(t.id)}">Cancel</button>`;
      return `<li class="task-item${active ? ' active' : ''}">
        <div class="task-line"><span class="task-label" title="${esc(t.config.label)}">${esc(t.config.label)}</span>${statusTag}</div>
        <div class="task-sub">${esc(t.config.datasetVersionId)} · ${esc(t.config.siteId)} · ${esc(t.step)}</div>
        ${t.status === 'running' || t.status === 'queued' ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ''}
        ${t.restoredFromTaskId ? `<div class="task-sub">restored from ${esc(t.restoredFromTaskId)}</div>` : ''}
        <div class="task-actions">${reports}${restore}</div>
      </li>`;
    })
    .join('');
  $$('#task-list [data-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-restore');
      try {
        const { task } = await api(`/api/tasks/${id}/restore`, { method: 'POST', body: '{}' });
        await refreshTasks();
        watchTask(task.id);
      } catch (err) {
        flash('error', `Restore failed: ${esc(err.message)}`);
      }
    }),
  );
  $$('#task-list [data-cancel]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/tasks/${b.getAttribute('data-cancel')}/cancel`, { method: 'POST', body: '{}' });
        await refreshTasks();
      } catch (err) {
        flash('error', `Cancel failed: ${esc(err.message)}`);
      }
    }),
  );
  $$('#task-list [data-open-report]').forEach((b) =>
    b.addEventListener('click', () => openReport(b.getAttribute('data-open-report'))),
  );
}

/* ------------------------------------------------------------------ report */

async function openReport(id) {
  flash('loading', 'Loading report …');
  try {
    const { report } = await api(`/api/reports/${id}`);
    state.report = report;
    $('#empty-state').hidden = true;
    $('#report-view').hidden = false;
    renderReport();
    flash(null);
  } catch (err) {
    flash('error', `Could not load report ${esc(id)}: ${esc(err.message)}`);
  }
}

function statusClass(r) {
  if (r.status === 'ok') return 'ok';
  if (r.status === 'training_only') return 'warn';
  if (r.status === 'no_rule' || r.status === 'no_window' || r.status === 'insufficient_attribution') return 'bad';
  return '';
}

function renderReport() {
  const r = state.report;
  if (!r) return;

  $('#rep-event').textContent = `${r.siteName} · ${r.eventName}`;
  $('#rep-title').textContent = `${r.window.localStart} → ${r.window.localEnd}`;
  $('#rep-meta').textContent = `${r.window.localDates.join(', ')} · ${r.window.offsetStart}${
    r.window.dstTransition ? ' → ' + r.window.offsetEnd + ' (DST transition)' : ''
  } · ${r.window.expectedIntervals} intervals · rev ${r.revisionNumber} (${r.revisionStatus})`;
  const pill = $('#rep-status');
  pill.textContent = r.statusLabel;
  pill.className = `status-pill ${statusClass(r)}`;
  const csv = $('#rep-csv');
  csv.href = `${API_BASE}/api/reports/${r.id}.csv`;
  csv.setAttribute('download', `${r.id}.csv`);

  renderKpis(r);
  renderWarnings(r);
  $('#rep-basis').textContent =
    `basis · dataset ${r.datasetVersionId} · revision ${r.eventRevisionId} · exclusions ${r.basis.exclusionsHash} · ` +
    `business ${r.basis.businessHash} · window ${r.basis.windowHash} · suite ${r.basis.suiteHash}`;

  renderChart(r);
  renderMethodTable(r);
  renderAttribution(r);
  renderIntervalTable(r);
  populateCompareSelects();
  renderCompare();
}

function renderKpis(r) {
  const res = r.results;
  const cards = [];
  const savingsSub =
    res.savingsCi90 && res.savingsKwh !== null
      ? `90% CI ${fmt.num(res.savingsCi90[0])} – ${fmt.num(res.savingsCi90[1])} kWh`
      : 'no interval reported';
  cards.push(
    `<div class="kpi ${res.savingsKwh !== null && res.savingsKwh > 0 ? 'good' : res.savingsKwh !== null && res.savingsKwh < 0 ? 'bad' : ''}">
      <div class="k-label">Attributed savings</div>
      <div class="k-value">${res.savingsKwh === null ? '—' : fmt.num(res.savingsKwh)} kWh</div>
      <div class="k-sub">${savingsSub}</div>
    </div>`,
  );
  cards.push(
    `<div class="kpi">
      <div class="k-label">Baseline</div>
      <div class="k-value">${res.baselineKwh === null ? '—' : fmt.num(res.baselineKwh)} kWh</div>
      <div class="k-sub">${esc(r.methodLabel)}${res.baselineCi90 ? ` · 90% CI ${fmt.ci(res.baselineCi90)}` : ''}</div>
    </div>`,
  );
  cards.push(
    `<div class="kpi">
      <div class="k-label">Observed drop</div>
      <div class="k-value">${res.observedDropKwh === null ? '—' : fmt.num(res.observedDropKwh)} kWh</div>
      <div class="k-sub">${res.nonDrDropKwh === null ? 'non-response part not separable' : `${fmt.num(res.nonDrDropKwh)} kWh not attributed`}</div>
    </div>`,
  );
  cards.push(
    `<div class="kpi ${res.attributableCoverage >= 0.999 ? '' : 'bad'}">
      <div class="k-label">Attributable coverage</div>
      <div class="k-value">${fmt.pct(res.attributableCoverage * 100)}</div>
      <div class="k-sub">${r.attribution.attributable}/${r.attribution.expected} window intervals</div>
    </div>`,
  );
  cards.push(
    `<div class="kpi">
      <div class="k-label">Savings vs baseline</div>
      <div class="k-value">${res.savingsPct === null ? '—' : fmt.pct(res.savingsPct)}</div>
      <div class="k-sub">of paired baseline kWh</div>
    </div>`,
  );
  $('#kpis').innerHTML = cards.join('');
}

function renderWarnings(r) {
  const el = $('#rep-warnings');
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const items = [...r.warnings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  el.innerHTML = items
    .map(
      (w) => `<div class="notice ${esc(w.severity)}"><strong>${esc(w.code.replace(/_/g, ' '))}</strong> — ${esc(w.message)}${
        w.detail ? `<div class="detail">${esc(w.detail)}</div>` : ''
      }</div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------- chart */

function renderChart(r) {
  const host = $('#chart');
  const intervals = r.intervals;
  if (!intervals.length) {
    host.innerHTML = '<p class="hint">No intervals in this window.</p>';
    return;
  }
  const showActual = $('#tgl-actual').checked;
  const showBaseline = $('#tgl-baseline').checked;
  const showCi = $('#tgl-ci').checked;
  const showExcluded = $('#tgl-excluded').checked;
  const showTemp = $('#tgl-temp').checked;

  const width = Math.max(320, host.clientWidth || 720);
  const height = host.clientHeight || 330;
  const m = { top: 14, right: showTemp ? 46 : 14, bottom: 28, left: 48 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  const values = [];
  for (const iv of intervals) {
    if (iv.actualKwh !== null) values.push(iv.actualKwh);
    if (iv.baselineKwh !== null) values.push(iv.baselineKwh);
    if (iv.baselineCi90) values.push(iv.baselineCi90[0], iv.baselineCi90[1]);
  }
  const maxV = values.length ? Math.max(...values) : 1;
  const minV = 0;
  const yMax = niceMax(maxV * 1.08);
  const temps = intervals.map((iv) => iv.tempF).filter((t) => t !== null);
  const tMin = temps.length ? Math.floor(Math.min(...temps) - 2) : 0;
  const tMax = temps.length ? Math.ceil(Math.max(...temps) + 2) : 1;

  const x = (i) => m.left + (intervals.length === 1 ? iw / 2 : (i / (intervals.length - 1)) * iw);
  const y = (v) => m.top + ih - ((v - minV) / (yMax - minV)) * ih;
  const ty = (t) => m.top + ih - ((t - tMin) / (tMax - tMin)) * ih;

  const parts = [];
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" tabindex="0" role="application" aria-label="Window load profile. Use left and right arrow keys to move between intervals.">`,
  );
  parts.push(
    `<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
       <line x1="0" y1="0" x2="0" y2="6" stroke="#c4ccd9" stroke-width="2"/></pattern></defs>`,
  );

  // y grid
  const yTicks = ticks(0, yMax, 4);
  for (const t of yTicks) {
    parts.push(`<line class="gridline" x1="${m.left}" x2="${width - m.right}" y1="${y(t)}" y2="${y(t)}"/>`);
    parts.push(`<text class="axis" x="${m.left - 7}" y="${y(t) + 3.5}" text-anchor="end">${fmt.num(t, 0)}</text>`);
  }
  parts.push(`<text class="axis-title" x="${m.left - 40}" y="${m.top - 2}">kWh</text>`);

  // excluded bands
  if (showExcluded) {
    let runStart = null;
    const flush = (endIdx) => {
      if (runStart === null) return;
      const x0 = x(runStart) - (iw / Math.max(1, intervals.length - 1)) / 2;
      const x1 = x(endIdx) + (iw / Math.max(1, intervals.length - 1)) / 2;
      parts.push(
        `<rect class="excluded-band" x="${Math.max(m.left, x0)}" y="${m.top}" width="${Math.max(2, Math.min(width - m.right, x1) - Math.max(m.left, x0))}" height="${ih}"/>`,
      );
      runStart = null;
    };
    intervals.forEach((iv, i) => {
      const ex = iv.exclusionCodes.length > 0;
      if (ex && runStart === null) runStart = i;
      if (!ex && runStart !== null) flush(i - 1);
    });
    flush(intervals.length - 1);
  }

  // x labels (hourly, thinned to avoid overlap)
  const slotEvery = Math.max(1, Math.ceil(intervals.length / Math.max(4, Math.floor(iw / 54))));
  // Wall-clock labels repeat across a fall-back transition; suffix the repeated
  // occurrence so the axis does not show two identical ticks at different x.
  const labelCounts = new Map();
  for (const iv of intervals) labelCounts.set(iv.localTime, (labelCounts.get(iv.localTime) ?? 0) + 1);
  const seenLabels = new Map();
  intervals.forEach((iv, i) => {
    const isHour = iv.localTime.endsWith(':00');
    if (!isHour) return;
    if (i % slotEvery !== 0 && i !== intervals.length - 1) return;
    const repeated = (labelCounts.get(iv.localTime) ?? 0) > 1;
    const n = (seenLabels.get(iv.localTime) ?? 0) + 1;
    seenLabels.set(iv.localTime, n);
    const label = repeated ? `${iv.localTime.slice(0, 5)}${'′'.repeat(n - 1)}` : iv.localTime.slice(0, 5);
    parts.push(`<text class="axis" x="${x(i)}" y="${height - 10}" text-anchor="middle">${esc(label)}</text>`);
  });
  const repeatedHour = intervals.some((iv) => (labelCounts.get(iv.localTime) ?? 0) > 1);
  parts.push(
    `<text class="axis-title" x="${width - m.right}" y="${height - 10}" text-anchor="end">${esc(
      `${intervals[0]?.localDate ?? ''} local${repeatedHour ? ' · ′ repeated hour (DST fall-back)' : ''}`,
    )}</text>`,
  );

  // baseline CI band
  if (showCi && showBaseline) {
    const pts = intervals.map((iv, i) => ({ i, lo: iv.baselineCi90?.[0], hi: iv.baselineCi90?.[1] })).filter((p) => p.lo != null && p.hi != null);
    if (pts.length > 1) {
      const up = pts.map((p) => `${x(p.i)},${y(p.hi)}`).join(' L ');
      const down = [...pts].reverse().map((p) => `${x(p.i)},${y(p.lo)}`).join(' L ');
      parts.push(`<path class="baseline-band" d="M ${up} L ${down} Z"/>`);
    }
  }

  // lines
  const linePath = (key) => {
    let d = '';
    let pen = false;
    intervals.forEach((iv, i) => {
      const v = iv[key];
      if (v === null || v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'} ${x(i)} ${y(v)} `;
      pen = true;
    });
    return d;
  };
  if (showBaseline) parts.push(`<path class="series-baseline" d="${linePath('baselineKwh')}"/>`);
  if (showActual) {
    parts.push(`<path class="series-actual" d="${linePath('actualKwh')}"/>`);
    intervals.forEach((iv, i) => {
      if (iv.actualKwh === null) return;
      parts.push(`<circle class="dot-actual" cx="${x(i)}" cy="${y(iv.actualKwh)}" r="2.6"/>`);
    });
  }
  if (showTemp && temps.length) {
    let d = '';
    let pen = false;
    intervals.forEach((iv, i) => {
      if (iv.tempF === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'} ${x(i)} ${ty(iv.tempF)} `;
      pen = true;
    });
    parts.push(`<path class="series-temp" d="${d}"/>`);
    const heels = [tMin, Math.round((tMin + tMax) / 2), tMax];
    for (const t of heels) {
      parts.push(`<text class="axis" x="${width - m.right + 6}" y="${ty(t) + 3.5}" text-anchor="start" fill="var(--temp)">${t}°F</text>`);
    }
  }

  // direct labels at the right edge
  const last = intervals[intervals.length - 1];
  if (showBaseline && last.baselineKwh !== null) {
    parts.push(
      `<text class="direct-label" x="${x(intervals.length - 1) - 4}" y="${y(last.baselineKwh) - 7}" text-anchor="end" fill="var(--baseline)">baseline</text>`,
    );
  }
  if (showActual && last.actualKwh !== null) {
    parts.push(
      `<text class="direct-label" x="${x(intervals.length - 1) - 4}" y="${y(last.actualKwh) + 14}" text-anchor="end" fill="var(--actual)">actual</text>`,
    );
  }

  // cursor layers
  parts.push(`<line class="cursor" id="chart-cursor" x1="0" x2="0" y1="${m.top}" y2="${m.top + ih}" visibility="hidden"/>`);
  parts.push(`<circle class="focus-dot" id="chart-focus" r="4.5" visibility="hidden"/>`);
  parts.push(`<rect id="chart-hit" x="${m.left}" y="${m.top}" width="${iw}" height="${ih}" fill="transparent"/>`);
  parts.push('</svg>');
  host.innerHTML = parts.join('');

  // legend
  const legend = [];
  if (showActual) legend.push(`<span class="item"><span class="swatch" style="background:var(--actual)"></span>Actual (measured)</span>`);
  if (showBaseline) legend.push(`<span class="item"><span class="swatch dash"></span>Baseline (${esc(r.methodLabel)})</span>`);
  if (showBaseline && showCi) legend.push(`<span class="item"><span class="swatch band"></span>Baseline 90% CI</span>`);
  if (showExcluded) legend.push(`<span class="item"><span class="swatch hatch"></span>Excluded interval</span>`);
  if (showTemp && temps.length) legend.push(`<span class="item"><span class="swatch" style="background:var(--temp)"></span>Temperature</span>`);
  $('#legend').innerHTML = legend.join('');

  // interaction
  const svg = host.querySelector('svg');
  const hit = svg.querySelector('#chart-hit');
  const cursor = svg.querySelector('#chart-cursor');
  const focus = svg.querySelector('#chart-focus');
  const tip = $('#chart-tooltip');
  const showAt = (idx) => {
    const iv = intervals[Math.max(0, Math.min(intervals.length - 1, idx))];
    if (!iv) return;
    const px = x(intervals.indexOf(iv));
    cursor.setAttribute('x1', px);
    cursor.setAttribute('x2', px);
    cursor.setAttribute('visibility', 'visible');
    const anchorVal = iv.actualKwh ?? iv.baselineKwh;
    if (anchorVal !== null) {
      focus.setAttribute('cx', px);
      focus.setAttribute('cy', y(showActual && iv.actualKwh !== null ? iv.actualKwh : anchorVal));
      focus.setAttribute('visibility', 'visible');
    } else {
      focus.setAttribute('visibility', 'hidden');
    }
    const delta =
      iv.actualKwh !== null && iv.baselineKwh !== null ? iv.baselineKwh - iv.actualKwh : null;
    tip.hidden = false;
    tip.innerHTML = `
      <div class="t-time">${esc(iv.localDate)} ${esc(iv.localTime)} · UTC${fmt.mins(iv.offsetMinutes)}</div>
      <div class="t-row"><span>Actual</span><b>${iv.actualKwh === null ? '—' : fmt.num(iv.actualKwh)} kWh</b></div>
      <div class="t-row"><span>Baseline</span><b>${iv.baselineKwh === null ? '—' : fmt.num(iv.baselineKwh)} kWh</b></div>
      ${iv.baselineCi90 ? `<div class="t-row"><span>90% CI</span><b>${fmt.ci(iv.baselineCi90)}</b></div>` : ''}
      <div class="t-row"><span>Δ (base − actual)</span><b>${delta === null ? '—' : fmt.num(delta)} kWh</b></div>
      ${iv.tempF !== null ? `<div class="t-row"><span>Temp</span><b>${fmt.num(iv.tempF)} °F${iv.isDerivedWeather ? '*' : ''}</b></div>` : ''}
      ${iv.exclusionCodes.length ? `<div class="t-flag">Excluded: ${esc(iv.exclusionCodes.join(', '))}</div>` : ''}
      ${iv.actualQuality === 'estimated' ? '<div class="t-flag">Estimated read</div>' : ''}
    `;
    const box = host.getBoundingClientRect();
    const scale = box.width / width;
    let left = px * scale + 14;
    if (left + 220 > box.width) left = px * scale - 226;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, Math.min(box.height - 120, 12))}px`;
    state.chartFocus = intervals.indexOf(iv);
  };
  const hide = () => {
    tip.hidden = true;
    cursor.setAttribute('visibility', 'hidden');
    focus.setAttribute('visibility', 'hidden');
  };
  const idxFromEvent = (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const frac = (px - m.left) / iw;
    return Math.round(frac * (intervals.length - 1));
  };
  hit.addEventListener('mousemove', (ev) => showAt(idxFromEvent(ev)));
  hit.addEventListener('mouseleave', hide);
  hit.addEventListener('click', (ev) => {
    const idx = idxFromEvent(ev);
    const iv = intervals[idx];
    if (!iv) return;
    state.intervalFilter = 'all';
    $('#interval-filter').value = 'all';
    renderIntervalTable(state.report);
    const row = $(`#interval-table tr[data-index="${iv.index}"]`);
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
  svg.addEventListener('keydown', (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(ev.key)) return;
    ev.preventDefault();
    if (ev.key === 'Escape') return hide();
    let idx = state.chartFocus ?? 0;
    if (ev.key === 'ArrowLeft') idx -= 1;
    if (ev.key === 'ArrowRight') idx += 1;
    if (ev.key === 'Home') idx = 0;
    if (ev.key === 'End') idx = intervals.length - 1;
    showAt(idx);
  });
  svg.addEventListener('blur', hide);
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function ticks(lo, hi, count) {
  const out = [];
  const step = (hi - lo) / count;
  for (let i = 0; i <= count; i++) out.push(lo + i * step);
  return out;
}

/* ---------------------------------------------------------------- methods */

function renderMethodTable(r) {
  const tbody = $('#method-table tbody');
  tbody.innerHTML = r.methods
    .map((mm) => {
      const failed = mm.checks.filter((c) => !c.passed);
      const status = mm.selected
        ? '<span class="tag good">selected</span>'
        : mm.applicable
          ? '<span class="tag plain">applicable</span>'
          : `<span class="tag warn" title="${esc(failed.map((c) => c.code).join(', '))}">fails ${failed.length} check${failed.length === 1 ? '' : 's'}</span>`;
      const delta = mm.deltaVsSelected
        ? `${mm.deltaVsSelected.savingsDiffKwh === null ? '—' : (mm.deltaVsSelected.savingsDiffKwh > 0 ? '+' : '') + fmt.num(mm.deltaVsSelected.savingsDiffKwh)} kWh`
        : '—';
      return `<tr class="${mm.selected ? 'rule-selected' : ''}">
        <td><strong>${esc(mm.label)}</strong><div class="muted" style="font-size:11px">${esc(mm.description)}</div></td>
        <td>${mm.sample.matchedDays} days<div class="muted" style="font-size:11px">${esc(mm.sample.selectedSummary)}</div></td>
        <td class="num">${mm.baselineKwh === null ? '—' : fmt.num(mm.baselineKwh)}</td>
        <td class="num">${mm.savingsKwh === null ? '—' : fmt.num(mm.savingsKwh)}</td>
        <td class="num">${mm.savingsCi90 ? fmt.ci(mm.savingsCi90) : '—'}</td>
        <td class="num">${fmt.pct(mm.coverage.pairedFraction * 100)}</td>
        <td class="num">${delta}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');

  const selected = r.methods.find((m) => m.selected) ?? r.methods[0];
  if (!selected) {
    $('#method-detail').innerHTML = '';
    return;
  }
  const s = selected.sample;
  const sampleRows = [
    ['Training window', `${s.windowStartDate} → ${s.windowEndDate}`],
    ['Day type', `${s.dayType}${s.dayTypeRestricted ? ' (restricted)' : ''}`],
    ['Day-type restriction', s.dayTypeRestricted ? 'Yes — matched same weekday/weekend class' : 'No — too few same-type days'],
    ['Candidates examined', String(s.examinedDays)],
    ['Excluded days', String(s.excludedDays)],
    ['Matched days', String(s.matchedDays)],
    ['Thin slot has', `${s.perSlotMinSamples} load / ${s.perSlotMinTempSamples} temp obs`],
    ['Median R²', s.medianR2 === null ? '—' : s.medianR2.toFixed(2)],
    ['Training temp range', s.tempRangeF ? `${s.tempRangeF[0].toFixed(1)}–${s.tempRangeF[1].toFixed(1)} °F` : '—'],
    ['Event temp range', s.eventTempRangeF ? `${s.eventTempRangeF[0].toFixed(1)}–${s.eventTempRangeF[1].toFixed(1)} °F` : '—'],
    ['Match tolerance used', s.observedMatchDeviationF === null ? '—' : `${fmt.num(s.observedMatchDeviationF)} °F`],
    ['Weather slope', s.slopeKwhPerF === null ? '—' : `${fmt.num(s.slopeKwhPerF, 3)} kWh/°F`],
    ['Slope fit sample', s.slopeSampleDays ? `${s.slopeSampleDays} days` : '—'],
    ['Slope adjustment', s.slopeAdjustmentKwh === null ? '—' : `${fmt.num(s.slopeAdjustmentKwh)} kWh`],
  ];
  const excludedList = Object.entries(s.excludedByReason)
    .map(([k, v]) => `<li><span class="dot fail"></span>${esc(k.replace(/_/g, ' '))}: ${v} day(s)</li>`)
    .join('');
  const checks = selected.checks
    .map(
      (c) => `<li><span class="dot${c.passed ? '' : ' fail'}"></span><span><strong>${esc(c.label)}</strong> — ${esc(c.detail)}</span></li>`,
    )
    .join('');

  $('#method-detail').innerHTML = `
    <div class="detail-card">
      <h3>${esc(selected.label)} — why this rule</h3>
      <p>${esc(selected.selectionReason || (selected.applicable ? 'Applicable; selected by policy.' : 'Not applicable.'))}</p>
      <p class="muted" style="margin-top:4px">${esc(s.leakageGuard)}</p>
      <dl class="sample-grid">
        ${sampleRows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      </dl>
    </div>
    <div class="detail-card">
      <h3>Applicability checks</h3>
      <ul class="check-list">${checks}</ul>
      ${excludedList ? `<h3 style="margin-top:10px">Why history days were dropped</h3><ul class="check-list">${excludedList}</ul>` : ''}
    </div>
    <div class="detail-card">
      <h3>Uncertainty</h3>
      <p>${esc(r.uncertainty.method)}. ${esc(r.uncertainty.note)}</p>
    </div>
  `;
}

/* ------------------------------------------------------------- attribution */

const CODE_LABELS = {
  missing_actual: 'Missing actual read (never zero-filled)',
  meter_conflict: 'Two meters reported the same interval',
  no_active_meter: 'No meter active at this instant',
  estimated_read: 'Estimated read excluded',
  production_planned_maintenance: 'Planned maintenance',
  production_unplanned_shutdown: 'Unplanned shutdown',
  production_reduced: 'Reduced output',
  production_non_routine: 'Non-routine operation',
  production_unverified: 'Unverified production anomaly',
  dst_transition_day: 'DST transition day',
  meter_exchange_day: 'Meter exchange day',
};

function renderAttribution(r) {
  const a = r.attribution;
  const bars = [];
  const base = Math.max(1, a.expected);
  bars.push(
    `<div class="attr-row"><span class="label">Attributable to response</span><span class="bar"><span style="width:${(a.attributable / base) * 100}%"></span></span><span class="count">${a.attributable}/${a.expected}</span></div>`,
  );
  for (const reason of a.reasons) {
    bars.push(
      `<div class="attr-row"><span class="label" title="${esc(reason.code)}">${esc(CODE_LABELS[reason.code] ?? reason.label)}</span><span class="bar"><span class="bad" style="width:${(reason.count / base) * 100}%"></span></span><span class="count">${reason.count}/${a.expected}</span></div>`,
    );
  }
  $('#attr-bars').innerHTML = bars.join('');

  const tbody = $('#exclusion-table tbody');
  if (!a.reasons.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No window interval was excluded.</td></tr>';
  } else {
    tbody.innerHTML = a.reasons
      .map(
        (x) => `<tr>
          <td>${esc(CODE_LABELS[x.code] ?? x.label)}<div class="muted mono" style="font-size:11px">${esc(x.code)}</div></td>
          <td class="num">${x.count}</td>
          <td class="num">${x.kWh === null ? '—' : fmt.num(x.kWh)}</td>
          <td class="mono">${esc(x.indexRanges)}</td>
        </tr>`,
      )
      .join('');
  }
  $('#attr-hint').textContent =
    `${a.attributable} of ${a.expected} window intervals survive exclusion; ` +
    `${a.missing} missing, ${a.conflict} meter conflict(s), ${a.productionAffected} production-affected, ${a.meterExchangeAffected} on a meter-exchange day.`;
}

/* ---------------------------------------------------------------- intervals */

function renderIntervalTable(r) {
  const filter = state.intervalFilter;
  const rows = r.intervals.filter((iv) => {
    if (filter === 'attributable') return iv.attributable;
    if (filter === 'excluded') return iv.exclusionCodes.length > 0;
    if (filter === 'missing-baseline') return iv.baselineKwh === null;
    return true;
  });
  const tbody = $('#interval-table tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No intervals match this filter.</td></tr>';
    return;
  }
  // Across a fall-back transition the same wall-clock label (e.g. 01:00)
  // occurs twice. Show the UTC offset on the repeated rows so a reader can
  // tell the two intervals apart; the timestamps themselves are distinct.
  const keyOf = (iv) => `${iv.localDate} ${iv.localTime}`;
  const seen = new Map();
  for (const iv of r.intervals) seen.set(keyOf(iv), (seen.get(keyOf(iv)) ?? 0) + 1);
  tbody.innerHTML = rows
    .map((iv) => {
      const delta = iv.actualKwh !== null && iv.baselineKwh !== null ? iv.baselineKwh - iv.actualKwh : null;
      const repeated = (seen.get(keyOf(iv)) ?? 0) > 1;
      const status =
        iv.exclusionCodes.length > 0
          ? iv.exclusionCodes.map((c) => `<span class="tag warn">${esc(c)}</span>`).join('')
          : iv.attributable
            ? '<span class="tag good">attributable</span>'
            : '<span class="tag plain">not used</span>';
      const notes = [];
      if (iv.actualQuality === 'estimated') notes.push('estimated read');
      if (iv.isDerivedWeather) notes.push('weather from nearest hour');
      if (iv.productionStatus !== 'normal') notes.push(`production: ${iv.productionStatus}`);
      if (iv.meterId) notes.push(`meter ${iv.meterId}`);
      return `<tr data-index="${iv.index}" class="${iv.attributable ? '' : 'muted'}">
        <td class="mono">${esc(iv.localTime)}${
          repeated ? ` <span class="tag plain" title="Second occurrence of this wall clock across the DST fall-back">UTC${fmt.mins(iv.offsetMinutes)}</span>` : ''
        }${iv.exclusionCodes.includes('dst_transition_day') ? ' <span class="tag plain">DST</span>' : ''}</td>
        <td class="num">${iv.tempF === null ? '—' : fmt.num(iv.tempF)}</td>
        <td class="num">${iv.baselineKwh === null ? '—' : fmt.num(iv.baselineKwh)}</td>
        <td class="num">${iv.baselineCi90 ? fmt.ci(iv.baselineCi90) : '—'}</td>
        <td class="num">${iv.actualKwh === null ? '—' : fmt.num(iv.actualKwh)}</td>
        <td class="num ${delta !== null && delta > 0 ? 'delta-positive' : delta !== null && delta < 0 ? 'delta-negative' : ''}">${delta === null ? '—' : fmt.num(delta)}</td>
        <td>${status}</td>
        <td class="muted" style="font-size:11.5px">${esc(notes.join(' · '))}</td>
      </tr>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ compare */

function populateCompareSelects() {
  const a = $('#cmp-a');
  const b = $('#cmp-b');
  const opts = state.reports
    .map(
      (r) =>
        `<option value="${esc(r.id)}">${esc(r.datasetVersionId)} · rev ${r.revisionNumber} · ${esc(r.methodLabel)} · ${esc(
          r.siteName.split(' ')[0],
        )} ${esc(r.eventName.slice(0, 24))}${r.savingsKwh === null ? '' : ` · ${fmt.num(r.savingsKwh)} kWh`}</option>`,
    )
    .join('');
  const keepA = a.value;
  const keepB = b.value;
  a.innerHTML = opts;
  b.innerHTML = opts;
  if (keepA) a.value = keepA;
  if (keepB) b.value = keepB;
  else if (state.reports.length > 1) b.value = state.reports[1].id;
}

async function runCompare() {
  const aId = $('#cmp-a').value;
  const bId = $('#cmp-b').value;
  if (!aId || !bId) {
    flash('error', 'Two reports are needed before comparing.');
    return;
  }
  if (aId === bId) {
    $('#compare-out').innerHTML = '<p class="hint">Pick two different reports to compare.</p>';
    return;
  }
  $('#compare-out').innerHTML = '<p class="hint">Comparing …</p>';
  try {
    state.compare = await api('/api/compare', { method: 'POST', body: JSON.stringify({ a: aId, b: bId }) });
    renderCompare();
  } catch (err) {
    $('#compare-out').innerHTML = `<div class="notice critical">${esc(err.message)}</div>`;
  }
}

function renderCompare() {
  const out = $('#compare-out');
  const c = state.compare;
  if (!c) {
    out.innerHTML = '<p class="hint">Run a comparison to see whether the two reports share a basis, and what the difference is.</p>';
    return;
  }
  const bannerText = {
    exact: 'Identical basis — the two runs share dataset, revision, window, exclusions and rule.',
    method: 'Same event and data revision, but different rule or exclusion settings.',
    revision: 'Different data or event revision. Use the common-window delta, not the headline difference.',
    incomparable: 'Not comparable — different site/event, or the window could not be resolved consistently.',
  }[c.comparability];
  const mismatches = c.mismatches.length
    ? `<ul class="mismatch-list">${c.mismatches
        .map(
          (m) => `<li><span class="sev ${m.severity}">${m.severity}</span><span><strong>${esc(m.label)}</strong> — ${esc(
            m.message,
          )}<div class="muted mono" style="font-size:11px">A: ${esc(m.a)} · B: ${esc(m.b)}</div></span></li>`,
        )
        .join('')}</ul>`
    : '<p class="hint">All basis fields match.</p>';

  const side = (s, label) => `<div class="compare-col">
      <h3>${esc(label)}</h3>
      <dl>
        <div><dt>Report</dt><dd class="mono">${esc(s.id)}</dd></div>
        <div><dt>Dataset</dt><dd>${esc(s.datasetVersionId)}</dd></div>
        <div><dt>Revision</dt><dd>rev ${s.revisionNumber}</dd></div>
        <div><dt>Rule</dt><dd>${esc(s.method ?? '—')}</dd></div>
        <div><dt>Window</dt><dd>${esc(s.window.localStart)}–${esc(s.window.localEnd)}</dd></div>
        <div><dt>Baseline</dt><dd>${s.baselineKwh === null ? '—' : fmt.num(s.baselineKwh)} kWh</dd></div>
        <div><dt>Savings</dt><dd>${s.savingsKwh === null ? '—' : fmt.num(s.savingsKwh)} kWh</dd></div>
        <div><dt>90% CI</dt><dd>${s.savingsCi90 ? fmt.ci(s.savingsCi90) : '—'}</dd></div>
        <div><dt>Coverage</dt><dd>${fmt.pct(s.attributableCoverage * 100)}</dd></div>
      </dl>
    </div>`;

  const deltaRow = (label, v, unit = 'kWh') =>
    `<div><dt>${esc(label)}</dt><dd class="${v !== null && v > 0 ? 'delta-positive' : v !== null && v < 0 ? 'delta-negative' : ''}">${
      v === null ? '—' : `${v > 0 ? '+' : ''}${fmt.num(v)} ${unit}`
    }</dd></div>`;

  const deltas = c.deltas
    ? `<div class="compare-col"><h3>Full-window difference (B − A)</h3><dl>
        ${deltaRow('Savings', c.deltas.savingsKwh)}
        ${deltaRow('Baseline', c.deltas.baselineKwh)}
        ${deltaRow('Savings % of baseline', c.deltas.savingsPctOfBaseline, 'pp')}
        ${deltaRow('Coverage', c.deltas.attributableCoveragePts, 'pp')}
        <div><dt>Intervals</dt><dd>${c.deltas.intervalCount === null ? '—' : (c.deltas.intervalCount > 0 ? '+' : '') + c.deltas.intervalCount}</dd></div>
      </dl></div>`
    : '<div class="compare-col"><h3>Full-window difference</h3><p class="hint">Not computed: the reports are not comparable.</p></div>';

  const cw = c.commonWindow;
  const common = cw
    ? `<div class="detail-card">
        <h3>Common window ${esc(fmt.time(cw.startUtc))} → ${esc(fmt.time(cw.endUtc))} (${cw.minutes} min, ${cw.intervals} intervals)</h3>
        <div class="compare-cols">
          <div class="compare-col"><h3>A</h3><dl>
            <div><dt>Baseline</dt><dd>${fmt.num(cw.a.baselineKwh)} kWh</dd></div>
            <div><dt>Actual</dt><dd>${fmt.num(cw.a.actualKwh)} kWh</dd></div>
            <div><dt>Savings</dt><dd>${cw.a.savingsKwh === null ? '—' : fmt.num(cw.a.savingsKwh)} kWh</dd></div>
            <div><dt>Attributable</dt><dd>${cw.a.attributable} intervals</dd></div>
          </dl></div>
          <div class="compare-col"><h3>B</h3><dl>
            <div><dt>Baseline</dt><dd>${fmt.num(cw.b.baselineKwh)} kWh</dd></div>
            <div><dt>Actual</dt><dd>${fmt.num(cw.b.actualKwh)} kWh</dd></div>
            <div><dt>Savings</dt><dd>${cw.b.savingsKwh === null ? '—' : fmt.num(cw.b.savingsKwh)} kWh</dd></div>
            <div><dt>Attributable</dt><dd>${cw.b.attributable} intervals</dd></div>
          </dl></div>
          <div class="compare-col"><h3>Δ savings on common window</h3><dl>
            <div><dt>B − A</dt><dd class="${cw.deltaSavingsKwh !== null && cw.deltaSavingsKwh > 0 ? 'delta-positive' : cw.deltaSavingsKwh !== null && cw.deltaSavingsKwh < 0 ? 'delta-negative' : ''}">${
              cw.deltaSavingsKwh === null ? '—' : `${cw.deltaSavingsKwh > 0 ? '+' : ''}${fmt.num(cw.deltaSavingsKwh)} kWh`
            }</dd></div>
          </dl></div>
        </div>
      </div>`
    : '<p class="hint">The two windows do not overlap, so no common-window delta exists.</p>';

  out.innerHTML = `
    <div class="compare-banner ${esc(c.comparability)}">${esc(bannerText)}</div>
    ${mismatches}
    <div class="compare-cols">${side(c.a, 'A — base')}${side(c.b, 'B — comparison')}${deltas}</div>
    ${common}
    <p class="hint">${c.notes.map(esc).join(' ')}</p>
  `;
}

/* -------------------------------------------------------------- data quality */

function renderDataQuality() {
  const dq = state.dataQuality;
  if (!dq) return;
  const version = dq.versions.find((v) => v.id === state.dqVersionId) ?? dq.versions[dq.versions.length - 1];
  if (!version) return;
  state.dqVersionId = version.id;
  const counts = version.counts;
  $('#dq-summary').innerHTML = [
    ['Reads', counts.reads],
    ['Weather obs', counts.weather],
    ['Production records', counts.production],
    ['Meters', counts.meters],
    ['Events', counts.events],
    ['Quarantined rows', counts.quarantined],
  ]
    .map(([l, n]) => `<div class="dq-stat"><div class="n">${fmt.int(n)}</div><div class="l">${esc(l)}</div></div>`)
    .join('');

  const q = $('#quarantine-table tbody');
  q.innerHTML = version.quarantine.length
    ? version.quarantine
        .slice(0, 40)
        .map(
          (row) => `<tr><td class="mono">${esc(row.rowRef)}</td><td><span class="tag warn">${esc(row.code)}</span></td><td>${esc(row.detail)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3" class="muted">No rows quarantined in this version.</td></tr>';

  const diffEl = $('#version-diff');
  if (!dq.diff) {
    diffEl.innerHTML = '<p class="hint">This is the first version, so there is no version-to-version diff.</p>';
    return;
  }
  const d = dq.diff;
  diffEl.innerHTML = `
    <h3>Changes since ${esc(d.fromVersionId)}</h3>
    <ul>
      <li>${d.addedReads} interval readings added, ${d.correctedReads} corrected</li>
      ${d.productionChanges
        .map(
          (c) =>
            `<li>SITE ${esc(c.siteId)} production record at ${esc(fmt.time(c.startUtc))}: <span class="mono">${esc(c.field)}</span> ${esc(
              c.oldValue || '(empty)',
            )} → ${esc(c.newValue)}</li>`,
        )
        .join('')}
    </ul>
  `;
}

/* -------------------------------------------------------------------- wire */

function wire() {
  $('#run-form').addEventListener('submit', runAnalysis);
  $('#validation-mode').addEventListener('change', (e) => {
    $('#validation-field').hidden = !e.target.checked;
    if (e.target.checked && !$('#validation-date').value) {
      const r = state.report;
      $('#validation-date').value = r ? r.window.localDates[0] : '';
    }
  });
  $('#refresh-tasks').addEventListener('click', () => refreshTasks().catch((err) => flash('error', esc(err.message))));
  $('#cmp-run').addEventListener('click', runCompare);
  $('#cmp-a').addEventListener('change', () => {
    state.compare = null;
    renderCompare();
  });
  $('#cmp-b').addEventListener('change', () => {
    state.compare = null;
    renderCompare();
  });
  $('#interval-filter').addEventListener('change', (e) => {
    state.intervalFilter = e.target.value;
    if (state.report) renderIntervalTable(state.report);
  });
  for (const id of ['tgl-actual', 'tgl-baseline', 'tgl-ci', 'tgl-excluded', 'tgl-temp']) {
    $(`#${id}`).addEventListener('change', () => {
      if (state.report) renderChart(state.report);
    });
  }
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.report) renderChart(state.report);
    }, 140);
  });
}

wire();
boot();
