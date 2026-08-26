export const SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>DSH Desktop</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --sidebar: #f7f8fa;
        --surface: #ffffff;
        --surface-hover: rgba(38, 49, 72, 0.04);
        --surface-selected: rgba(38, 49, 72, 0.06);
        --text: #0f1115;
        --text-secondary: #61666b;
        --text-tertiary: #72777e;
        --border: rgba(0, 0, 0, 0.1);
        --brand: #416bea;
        --brand-hover: #345bce;
        --success: #168f61;
        --danger: #c73a3a;
        --warning-bg: #fff8e6;
        --warning-border: #e7c873;
        --warning-text: #654b14;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--text);
        background: var(--bg);
      }

      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html, body { margin: 0; min-width: 320px; min-height: 100%; }
      body { min-height: 100vh; background: var(--bg); }
      button, input { font: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: 0.45; }
      button:focus-visible, input:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(65, 107, 234, 0.2);
      }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
      }

      .masthead {
        position: sticky;
        top: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 24px 16px 18px;
        border-right: 1px solid var(--border);
        background: var(--sidebar);
      }

      .brand-mark {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 2px;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.03em;
      }

      .brand-mark::after {
        content: "DESKTOP";
        padding: 1px 4px;
        border: 1px solid var(--text);
        border-radius: 3px;
        font-size: 8px;
        font-weight: 600;
        line-height: 12px;
        letter-spacing: 0.04em;
      }

      .masthead-copy {
        margin-top: 34px;
        padding: 12px;
        border-radius: 12px;
        background: var(--surface-selected);
      }

      .mode-label {
        margin: 0 0 3px;
        color: var(--text-tertiary);
        font-size: 12px;
        line-height: 18px;
      }

      h1 {
        margin: 0;
        font-size: 14px;
        font-weight: 500;
        line-height: 22px;
      }

      .masthead-copy > p:last-child {
        margin: 3px 0 0;
        color: var(--text-secondary);
        font-size: 12px;
        line-height: 18px;
      }

      .runtime-note {
        display: grid;
        gap: 9px;
        padding: 14px 8px 0;
        border-top: 1px solid var(--border);
      }

      .runtime-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: var(--text-tertiary);
        font-size: 11px;
      }

      .runtime-row strong {
        color: var(--text-secondary);
        font-weight: 500;
      }

      .workspace {
        min-width: 0;
        padding: 56px 48px 40px;
        overflow: auto;
      }

      .workspace-inner { max-width: 880px; margin: 0 auto; }
      .workspace-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 28px;
      }

      h2 {
        margin: 0;
        font-size: 28px;
        font-weight: 600;
        line-height: 36px;
        letter-spacing: -0.025em;
      }

      .page-description, .section-description {
        margin: 5px 0 0;
        color: var(--text-secondary);
        font-size: 14px;
        line-height: 22px;
      }

      .button {
        min-height: 38px;
        padding: 7px 16px;
        border: 1px solid var(--border);
        border-radius: 10px;
        color: var(--text);
        background: var(--surface);
        font-size: 14px;
        font-weight: 500;
        line-height: 22px;
        transition: background 120ms ease, border-color 120ms ease;
      }

      .button:hover:not(:disabled) { background: var(--surface-hover); border-color: rgba(0, 0, 0, 0.18); }
      .button.primary {
        border-color: var(--brand);
        color: #ffffff;
        background: var(--brand);
      }
      .button.primary:hover:not(:disabled) {
        border-color: var(--brand-hover);
        background: var(--brand-hover);
      }
      .button.secondary { background: transparent; }
      .button.small { min-height: 34px; padding: 5px 13px; font-size: 13px; }

      .notice {
        margin-bottom: 20px;
        padding: 12px 14px;
        border: 1px solid var(--warning-border);
        border-radius: 10px;
        color: var(--warning-text);
        background: var(--warning-bg);
        font-size: 13px;
        line-height: 20px;
      }

      .notice strong { display: block; margin-bottom: 2px; font-weight: 600; }
      .summary-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin: 0 0 12px;
        color: var(--text-secondary);
        font-size: 13px;
      }

      .status { display: inline-flex; align-items: center; gap: 7px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }
      .status.available .status-dot { background: var(--success); }

      .server-list { display: grid; gap: 10px; }
      .server-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 20px;
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        transition: background 120ms ease, border-color 120ms ease;
      }

      .server-card:hover { border-color: rgba(0, 0, 0, 0.16); background: var(--surface-hover); }
      .server-name { margin: 0 0 4px; font-size: 15px; font-weight: 500; line-height: 22px; }
      .server-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        color: var(--text-secondary);
        font-size: 12px;
        line-height: 18px;
      }
      .server-meta code, .log-path {
        font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, monospace;
        overflow-wrap: anywhere;
      }

      .server-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      .text-button {
        padding: 6px 8px;
        border: 0;
        border-radius: 8px;
        color: var(--text-secondary);
        background: transparent;
        font-size: 13px;
        line-height: 20px;
        white-space: nowrap;
      }
      .text-button:hover { color: var(--text); background: var(--surface-selected); }
      .text-button.danger:hover { color: var(--danger); }

      .empty-state {
        padding: 52px 24px;
        border: 1px solid var(--border);
        border-radius: 16px;
        text-align: center;
        background: var(--surface);
      }

      .empty-state strong { display: block; margin-bottom: 6px; font-size: 16px; font-weight: 600; }
      .empty-state p {
        max-width: 48ch;
        margin: 0 auto 20px;
        color: var(--text-secondary);
        font-size: 14px;
        line-height: 22px;
      }

      .editor {
        position: relative;
        margin-top: 24px;
        padding: 24px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--surface);
        box-shadow: 0 12px 36px rgba(31, 35, 41, 0.08);
      }

      .editor-header { padding-right: 44px; margin-bottom: 22px; }
      .editor-header > .text-button { position: absolute; top: 18px; right: 16px; }
      .editor h3 { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
      .form-grid { display: grid; grid-template-columns: 1fr 0.55fr; gap: 18px; }
      .field:first-child { grid-column: 1 / -1; }
      .field label {
        display: block;
        margin-bottom: 7px;
        color: var(--text);
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
      }

      .field input {
        width: 100%;
        height: 40px;
        padding: 0 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        outline: none;
        color: var(--text);
        background: var(--surface);
      }
      .field input:hover { border-color: rgba(0, 0, 0, 0.18); }
      .field input:focus { border-color: var(--brand); }
      .field input::placeholder { color: #a1a5ab; }
      .field small {
        display: block;
        margin-top: 6px;
        color: var(--text-tertiary);
        font-size: 12px;
        line-height: 18px;
      }
      .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }

      .diagnostics {
        margin-top: 28px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
        color: var(--text-tertiary);
        font-size: 11px;
        line-height: 18px;
      }

      .toast {
        position: fixed;
        z-index: 20;
        right: 24px;
        bottom: 24px;
        max-width: min(420px, calc(100vw - 48px));
        padding: 11px 14px;
        border-radius: 10px;
        color: #ffffff;
        background: var(--text);
        box-shadow: 0 8px 24px rgba(15, 17, 21, 0.16);
        font-size: 13px;
        line-height: 20px;
      }

      .connecting {
        position: fixed;
        z-index: 30;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(15, 17, 21, 0.24);
      }

      .connecting-card {
        width: min(460px, 100%);
        padding: 26px;
        border: 1px solid var(--border);
        border-radius: 16px;
        color: var(--text);
        background: var(--surface);
        box-shadow: 0 18px 56px rgba(15, 17, 21, 0.18);
      }

      .connecting-header { display: flex; align-items: flex-start; gap: 14px; }
      .track {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        margin-top: 3px;
        border: 2px solid rgba(65, 107, 234, 0.22);
        border-top-color: var(--brand);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      .connecting-card h3 { margin: 0 0 4px; font-size: 18px; font-weight: 600; line-height: 26px; }
      .connecting-card p { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 20px; }
      .connecting-steps {
        display: grid;
        gap: 8px;
        margin: 20px 0 0 34px;
        padding: 0;
        list-style: none;
        color: var(--text-secondary);
        font-size: 12px;
        line-height: 18px;
      }
      .connecting-steps li::before { content: "·"; margin-right: 7px; color: var(--text-tertiary); }

      @keyframes spin { to { transform: rotate(360deg); } }

      @media (max-width: 760px) {
        .shell { grid-template-columns: 1fr; }
        .masthead {
          position: static;
          height: auto;
          padding: 16px 18px;
          border-right: 0;
          border-bottom: 1px solid var(--border);
        }
        .masthead-copy { margin-top: 18px; }
        .runtime-note { display: none; }
        .workspace { padding: 32px 20px 40px; }
      }

      @media (max-width: 620px) {
        .workspace-header { align-items: flex-start; flex-direction: column; }
        .workspace-header .button { width: 100%; }
        .server-card { grid-template-columns: 1fr; }
        .server-actions { justify-content: flex-start; }
        .form-grid { grid-template-columns: 1fr; }
        .field:first-child { grid-column: auto; }
        .form-actions { flex-direction: column-reverse; }
        .form-actions .button { width: 100%; }
      }

      @media (prefers-reduced-motion: reduce) {
        .track { animation: none; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="masthead">
        <div>
          <div class="brand-mark">deepseek</div>
          <div class="masthead-copy">
            <p class="mode-label">连接方式</p>
            <h1>远程模式</h1>
            <p>通过本机 OpenSSH 连接远程 DSH Web。</p>
          </div>
        </div>
        <div class="runtime-note">
          <div class="runtime-row"><span>浏览器</span><strong>Chromium / CEF</strong></div>
          <div class="runtime-row"><span>连接</span><strong>OpenSSH</strong></div>
        </div>
      </aside>

      <main class="workspace">
        <div class="workspace-inner">
          <header class="workspace-header">
            <div>
              <h2>选择服务器</h2>
              <p class="page-description">通过 SSH Host 建立安全连接。</p>
            </div>
            <button id="add-server" class="button primary" type="button">添加服务器</button>
          </header>

          <div id="notice" class="notice" role="alert" hidden></div>
          <div class="summary-line">
            <span id="server-count">正在读取配置...</span>
            <span id="ssh-status" class="status"><span class="status-dot"></span><span>检测 OpenSSH</span></span>
          </div>

          <section id="server-list" class="server-list" aria-live="polite"></section>
          <section id="empty-state" class="empty-state" hidden>
            <strong>还没有服务器</strong>
            <p>添加一个 <code>~/.ssh/config</code> 中的 Host。用户、端口、密钥和跳板机继续由 OpenSSH 管理。</p>
            <button id="empty-add" class="button primary" type="button">添加服务器</button>
          </section>

          <section id="editor" class="editor" aria-labelledby="editor-title" hidden>
            <div class="editor-header">
              <div>
                <h3 id="editor-title">添加服务器</h3>
                <p class="section-description">保存 DSH 显示名称、SSH Host 和远端 Web 端口。</p>
              </div>
              <button id="close-editor" class="text-button" type="button">关闭</button>
            </div>
            <form id="server-form">
              <div class="form-grid">
                <div class="field">
                  <label for="server-name">显示名称</label>
                  <input id="server-name" name="name" maxlength="80" placeholder="生产环境" autocomplete="off">
                  <small>可留空，默认使用 SSH Host。</small>
                </div>
                <div class="field">
                  <label for="ssh-target">SSH Host / 别名</label>
                  <input id="ssh-target" name="sshTarget" required maxlength="255" placeholder="prod-dsh" autocomplete="off" spellcheck="false">
                  <small>直接交给本机 <code>ssh</code>，并读取 <code>~/.ssh/config</code>。</small>
                </div>
                <div class="field">
                  <label for="remote-port">DSH Web 端口</label>
                  <input id="remote-port" name="remotePort" type="number" required min="1" max="65535" value="3080" inputmode="numeric">
                  <small>默认端口为 <code>3080</code>。</small>
                </div>
              </div>
              <div class="form-actions">
                <button id="cancel-editor" class="button secondary" type="button">取消</button>
                <button class="button primary" type="submit">保存</button>
              </div>
            </form>
          </section>

          <footer class="diagnostics">
            <div>日志目录：<code id="log-directory" class="log-path">正在初始化...</code></div>
            <div>认证使用 <code>.ssh/config</code>、密钥或 <code>ssh-agent</code>；应用不处理密码。</div>
          </footer>
        </div>
      </main>
    </div>

    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    <div id="connecting" class="connecting" role="dialog" aria-modal="true" aria-labelledby="connecting-title" hidden>
      <div class="connecting-card">
        <div class="connecting-header">
          <div class="track" aria-hidden="true"></div>
          <div>
            <h3 id="connecting-title">正在连接</h3>
            <p id="connecting-target">正在准备远程连接...</p>
          </div>
        </div>
        <ul class="connecting-steps">
          <li>读取本机 .ssh/config</li>
          <li>建立回环端口转发</li>
          <li>验证远端 DSH Web</li>
        </ul>
      </div>
    </div>

    <script>
      (function () {
        "use strict";

        var state = { profiles: [], ssh: { available: false }, editingId: null };
        var list = document.getElementById("server-list");
        var empty = document.getElementById("empty-state");
        var editor = document.getElementById("editor");
        var form = document.getElementById("server-form");
        var notice = document.getElementById("notice");
        var toast = document.getElementById("toast");
        var connecting = document.getElementById("connecting");
        var toastTimer;

        document.getElementById("add-server").addEventListener("click", function () { openEditor(); });
        document.getElementById("empty-add").addEventListener("click", function () { openEditor(); });
        document.getElementById("close-editor").addEventListener("click", closeEditor);
        document.getElementById("cancel-editor").addEventListener("click", closeEditor);
        form.addEventListener("submit", saveProfile);

        bootstrap();

        async function bootstrap() {
          try {
            if (!globalThis.bindings) throw new Error("请通过 DSH Desktop 启动此页面");
            var data = await globalThis.bindings.bootstrap();
            state.profiles = data.profiles;
            state.ssh = data.ssh;
            document.getElementById("log-directory").textContent = data.logDirectory;
            renderSshStatus();
            renderProfiles();
            if (data.startupNotice) showNotice(data.startupNotice);
            if (!state.profiles.length) openEditor();
          } catch (error) {
            showNotice(errorMessage(error));
            document.getElementById("server-count").textContent = "配置读取失败";
          }
        }

        function renderSshStatus() {
          var element = document.getElementById("ssh-status");
          var version = state.ssh.version || "";
          element.classList.toggle("available", state.ssh.available);
          element.lastElementChild.textContent = state.ssh.available
            ? version.indexOf("OpenSSH") === 0 ? version : "OpenSSH " + (version || "可用")
            : "OpenSSH 未安装";
          if (!state.ssh.available) {
            showNotice(state.ssh.installHelp || "未找到 OpenSSH Client，请安装后重启应用。");
          }
        }

        function renderProfiles() {
          list.replaceChildren();
          empty.hidden = state.profiles.length !== 0;
          document.getElementById("server-count").textContent = state.profiles.length
            ? state.profiles.length + " 个远程入口"
            : "等待添加远程入口";

          state.profiles.forEach(function (profile) {
            var card = document.createElement("article");
            card.className = "server-card";

            var details = document.createElement("div");
            var title = document.createElement("h3");
            title.className = "server-name";
            title.textContent = profile.name;
            details.appendChild(title);

            var meta = document.createElement("div");
            meta.className = "server-meta";
            var target = document.createElement("code");
            target.textContent = profile.sshTarget;
            var port = document.createElement("span");
            port.textContent = "远端 DSH · :" + profile.remotePort;
            meta.append(target, port);
            details.appendChild(meta);

            var actions = document.createElement("div");
            actions.className = "server-actions";
            actions.append(
              actionButton("编辑", "text-button", function () { openEditor(profile); }),
              actionButton("删除", "text-button danger", function () { deleteProfile(profile); }),
              actionButton("连接", "button small primary", function () { connectProfile(profile); }, !state.ssh.available)
            );
            card.append(details, actions);
            list.appendChild(card);
          });
        }

        function actionButton(label, className, handler, disabled) {
          var button = document.createElement("button");
          button.type = "button";
          button.className = className;
          button.textContent = label;
          button.disabled = Boolean(disabled);
          button.addEventListener("click", handler);
          return button;
        }

        function openEditor(profile) {
          state.editingId = profile ? profile.id : null;
          document.getElementById("editor-title").textContent = profile ? "编辑服务器" : "添加服务器";
          form.elements.name.value = profile ? profile.name : "";
          form.elements.sshTarget.value = profile ? profile.sshTarget : "";
          form.elements.remotePort.value = profile ? String(profile.remotePort) : "3080";
          editor.hidden = false;
          window.setTimeout(function () { form.elements.sshTarget.focus(); }, 0);
        }

        function closeEditor() {
          state.editingId = null;
          form.reset();
          form.elements.remotePort.value = "3080";
          editor.hidden = true;
        }

        async function saveProfile(event) {
          event.preventDefault();
          var submit = form.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            await globalThis.bindings.saveProfile({
              id: state.editingId,
              name: form.elements.name.value,
              sshTarget: form.elements.sshTarget.value,
              remotePort: Number(form.elements.remotePort.value)
            });
            var data = await globalThis.bindings.bootstrap();
            state.profiles = data.profiles;
            closeEditor();
            renderProfiles();
            showToast("服务器配置已保存");
          } catch (error) {
            showToast(errorMessage(error));
          } finally {
            submit.disabled = false;
          }
        }

        async function deleteProfile(profile) {
          if (!confirm("删除服务器“" + profile.name + "”？")) return;
          try {
            await globalThis.bindings.deleteProfile(profile.id);
            state.profiles = state.profiles.filter(function (item) { return item.id !== profile.id; });
            if (state.editingId === profile.id) closeEditor();
            renderProfiles();
            showToast("服务器配置已删除");
          } catch (error) {
            showToast(errorMessage(error));
          }
        }

        async function connectProfile(profile) {
          connecting.hidden = false;
          document.getElementById("connecting-target").textContent = "正在连接 “" + profile.name + "”";
          try {
            await globalThis.bindings.connectProfile(profile.id);
          } catch (error) {
            connecting.hidden = true;
            showToast(errorMessage(error));
          }
        }

        function showNotice(message) {
          notice.replaceChildren();
          var title = document.createElement("strong");
          title.textContent = "需要处理";
          var body = document.createElement("span");
          body.textContent = message;
          notice.append(title, body);
          notice.hidden = false;
        }

        function showToast(message) {
          window.clearTimeout(toastTimer);
          toast.textContent = message;
          toast.hidden = false;
          toastTimer = window.setTimeout(function () { toast.hidden = true; }, 5200);
        }

        function errorMessage(error) {
          if (error && typeof error.message === "string") return error.message;
          return String(error || "操作失败，请查看日志");
        }
      })();
    </script>
  </body>
</html>`;

export function handleShellRequest(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname !== "/" || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(request.method === "HEAD" ? null : SHELL_HTML, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
