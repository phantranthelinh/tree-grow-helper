import { PROVIDERS } from '../llm/providers'

/**
 * Self-contained setup page: inline CSS + vanilla JS, no build step, no external
 * assets. The only server-side interpolation is the PROVIDERS preset table, so the
 * client and server share one source of truth for provider defaults.
 */
export function renderSetupPage(): string {
  const providersJson = JSON.stringify(PROVIDERS)
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cấu hình AI Server</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #f4f5f7; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e8e8e8; } }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.4rem; margin: 8px 0 4px; }
  .sub { color: #666; margin: 0 0 20px; font-size: .92rem; }
  @media (prefers-color-scheme: dark) { .sub { color: #9aa0a6; } }
  .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .card { background: #1f2229; border-color: #2f333c; } }
  .providers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .prov { border: 2px solid #e0e0e0; border-radius: 10px; padding: 12px; cursor: pointer; transition: border-color .15s; }
  @media (prefers-color-scheme: dark) { .prov { border-color: #2f333c; } }
  .prov.active { border-color: #2f7d32; background: rgba(47,125,50,.06); }
  .prov b { display: block; margin-bottom: 4px; }
  .prov small { color: #777; font-size: .78rem; line-height: 1.35; }
  @media (prefers-color-scheme: dark) { .prov small { color: #9aa0a6; } }
  label { display: block; font-weight: 600; font-size: .85rem; margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px; font-size: .95rem; background: #fff; color: inherit; }
  @media (prefers-color-scheme: dark) { input { background: #14161b; border-color: #3a3f49; } }
  .hint { font-size: .78rem; color: #888; margin-top: 4px; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row > div { flex: 1; }
  button { padding: 10px 16px; border: 0; border-radius: 8px; font-size: .95rem; font-weight: 600; cursor: pointer; }
  button.primary { background: #2f7d32; color: #fff; width: 100%; margin-top: 18px; padding: 12px; }
  button.ghost { background: #e8e8e8; color: #222; white-space: nowrap; }
  @media (prefers-color-scheme: dark) { button.ghost { background: #2a2e37; color: #e8e8e8; } }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .err { display: none; background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 8px; padding: 10px 12px; margin-top: 14px; font-size: .9rem; }
  @media (prefers-color-scheme: dark) { .err { background: #3a1e1c; border-color: #6b2f2b; color: #ff9a92; } }
  .steps { list-style: none; padding: 0; margin: 0; }
  .steps li { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid #eee; }
  @media (prefers-color-scheme: dark) { .steps li { border-color: #2a2e37; } }
  .steps li:last-child { border-bottom: 0; }
  .ico { width: 20px; text-align: center; }
  .st-done .ico { color: #2f7d32; }
  .st-failed .ico { color: #c9772b; }
  .step-detail { display: block; font-size: .78rem; color: #888; margin-top: 2px; }
  .ready-banner { display: none; background: #e7f5e8; color: #1e5b21; border-radius: 8px; padding: 14px; text-align: center; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .ready-banner { background: #16301a; color: #8fd894; } }
  a { color: #2f7d32; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Cấu hình AI Server</h1>
  <p class="sub">Chọn nhà cung cấp LLM và kết nối để bắt đầu. Cấu hình sẽ được lưu cho các lần chạy sau.</p>

  <div id="form-card" class="card">
    <label>Nhà cung cấp</label>
    <div class="providers" id="providers"></div>

    <label for="baseURL">Base URL</label>
    <input id="baseURL" type="text" placeholder="http://localhost:1234/v1" autocomplete="off" />
    <div class="hint">Chạy trong Docker? Dùng <code>http://host.docker.internal:&lt;port&gt;/v1</code> thay cho <code>localhost</code>.</div>

    <label for="apiKey">API key <span id="key-opt" class="hint" style="display:inline">(không bắt buộc)</span></label>
    <input id="apiKey" type="password" placeholder="" autocomplete="off" />

    <div class="row">
      <div>
        <label for="model">Model chat</label>
        <input id="model" type="text" autocomplete="off" />
      </div>
      <div>
        <label for="embedModel">Model embedding</label>
        <input id="embedModel" type="text" autocomplete="off" />
      </div>
    </div>

    <label for="mcpUrl">MCP URL</label>
    <div class="row">
      <div><input id="mcpUrl" type="text" placeholder="http://localhost:8000/mcp" autocomplete="off" /></div>
      <button id="btn-mcp-test" class="ghost">Kiểm tra MCP</button>
    </div>
    <div id="mcp-hint" class="hint">Địa chỉ MCP điều khiển thiết bị. MCP chưa chạy vẫn kết nối được — lệnh điều khiển sẽ lỗi đến khi MCP sẵn sàng.</div>

    <div id="err" class="err"></div>
    <button id="btn-connect" class="primary">Kết nối</button>
  </div>

  <div id="progress-card" class="card hidden">
    <ul class="steps" id="steps"></ul>
    <div id="ready" class="ready-banner">Sẵn sàng! Mở <a href="/docs">/docs</a> để thử chat.</div>
  </div>
</div>

<script>
var PROVIDERS = ${providersJson};
var ERR = {
  unreachable: 'Không kết nối được — kiểm tra Base URL và dịch vụ đã chạy chưa.',
  timeout: 'Hết thời gian chờ (model có thể đang nạp, thử lại).',
  auth_failed: 'API key không hợp lệ.',
  model_not_found: 'Không tìm thấy model chat.',
  embed_model_not_found: 'Không tìm thấy model embedding.',
  busy: 'Đang khởi tạo, vui lòng đợi.',
  unknown: 'Lỗi không xác định.'
};
var STEP_LABEL = { llm: 'Kiểm tra kết nối LLM', mcp: 'Kết nối MCP', rag: 'Nạp dữ liệu RAG' };
var ICON = { pending: '○', running: '⏳', done: '✓', failed: '✗' };

var selected = 'lmstudio';
var pollTimer = null;

function $(id) { return document.getElementById(id); }

function renderProviders() {
  var box = $('providers');
  box.innerHTML = '';
  Object.keys(PROVIDERS).forEach(function (id) {
    var p = PROVIDERS[id];
    var el = document.createElement('div');
    el.className = 'prov' + (id === selected ? ' active' : '');
    el.innerHTML = '<b>' + p.label + '</b><small>' + (p.note || '') + '</small>';
    el.onclick = function () { selectProvider(id); };
    box.appendChild(el);
  });
}

function selectProvider(id) {
  selected = id;
  var p = PROVIDERS[id];
  if (p.defaultBaseURL) $('baseURL').value = p.defaultBaseURL;
  $('key-opt').textContent = p.requiresApiKey ? '(bắt buộc)' : '(không bắt buộc)';
  renderProviders();
}

function showError(code, message) {
  var box = $('err');
  box.textContent = (ERR[code] || ERR.unknown) + (message ? ' (' + message + ')' : '');
  box.style.display = 'block';
}
function clearError() { $('err').style.display = 'none'; }

function currentBody() {
  return {
    provider: selected,
    baseURL: $('baseURL').value.trim(),
    apiKey: $('apiKey').value,
    model: $('model').value.trim(),
    embedModel: $('embedModel').value.trim(),
    mcpUrl: $('mcpUrl').value.trim()
  };
}

function testMcp() {
  var url = $('mcpUrl').value.trim();
  if (!url) { $('mcp-hint').textContent = '✗ Nhập MCP URL trước.'; return; }
  var btn = $('btn-mcp-test');
  btn.disabled = true;
  btn.textContent = 'Đang kiểm tra…';
  fetch('/api/setup/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: url })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) {
        $('mcp-hint').textContent = '✗ Không kết nối được MCP' + (res.j.message ? ' (' + res.j.message + ')' : '') + ' — vẫn kết nối được, điều khiển sẽ lỗi đến khi MCP sẵn sàng.';
        return;
      }
      $('mcp-hint').textContent = '✓ Tìm thấy ' + res.j.toolCount + ' tool.';
    })
    .catch(function (e) { $('mcp-hint').textContent = '✗ Lỗi kiểm tra MCP (' + String(e) + ')'; })
    .finally(function () { btn.disabled = false; btn.textContent = 'Kiểm tra MCP'; });
}

function connect() {
  clearError();
  var body = currentBody();
  if (!body.baseURL) { showError('unknown', 'Thiếu Base URL'); return; }
  if (!body.model) { showError('unknown', 'Thiếu model chat'); return; }
  if (!body.embedModel) { showError('unknown', 'Thiếu model embedding'); return; }
  if (!body.mcpUrl) { showError('unknown', 'Thiếu MCP URL'); return; }
  var btn = $('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Đang kết nối…';
  fetch('/api/setup/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) {
        showError(res.j.error, res.j.message);
        btn.disabled = false; btn.textContent = 'Kết nối';
        return;
      }
      $('progress-card').classList.remove('hidden');
      startPolling();
    })
    .catch(function (e) {
      showError('unknown', String(e));
      btn.disabled = false; btn.textContent = 'Kết nối';
    });
}

function renderSteps(status) {
  var ul = $('steps');
  ul.innerHTML = '';
  (status.steps || []).forEach(function (s) {
    var li = document.createElement('li');
    li.className = 'st-' + s.status;
    var detail = s.detail ? '<span class="step-detail">' + s.detail + '</span>' : '';
    li.innerHTML = '<span class="ico">' + (ICON[s.status] || '○') + '</span><span>' + (STEP_LABEL[s.id] || s.id) + detail + '</span>';
    ul.appendChild(li);
  });
  $('ready').style.display = status.phase === 'ready' ? 'block' : 'none';
}

function applyStatus(status) {
  if (status.phase === 'connecting' || status.phase === 'initializing' || status.phase === 'ready') {
    $('progress-card').classList.remove('hidden');
    renderSteps(status);
  }
  if (status.phase === 'ready') {
    stopPolling();
    $('btn-connect').textContent = 'Đã kết nối';
  }
  if (status.error && (status.phase === 'waiting_config' || status.phase === 'error')) {
    showError(status.error.code, status.error.message);
    $('btn-connect').disabled = false;
    $('btn-connect').textContent = 'Kết nối';
    stopPolling();
  }
}

function poll() {
  fetch('/api/setup/status').then(function (r) { return r.json(); }).then(applyStatus).catch(function () {});
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(poll, 1000); poll(); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function prefill(status) {
  var src = status.config || status.defaults || {};
  if (src.provider && PROVIDERS[src.provider]) selected = src.provider;
  renderProviders();
  var p = PROVIDERS[selected];
  $('baseURL').value = src.baseURL || (p ? p.defaultBaseURL : '');
  $('model').value = src.model || '';
  $('embedModel').value = src.embedModel || '';
  $('mcpUrl').value = src.mcpUrl || (status.defaults && status.defaults.mcpUrl) || '';
  $('key-opt').textContent = (p && p.requiresApiKey) ? '(bắt buộc)' : '(không bắt buộc)';
}

function init() {
  renderProviders();
  $('btn-mcp-test').onclick = testMcp;
  $('btn-connect').onclick = connect;
  fetch('/api/setup/status').then(function (r) { return r.json(); }).then(function (status) {
    prefill(status);
    applyStatus(status);
    if (status.phase === 'connecting' || status.phase === 'initializing') startPolling();
  }).catch(function () {});
}

init();
</script>
</body>
</html>`
}
