export const SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>DSH Desktop</title>
    <style>
      :root {
        --ink: #172019;
        --ink-soft: #47534a;
        --paper: #f1eadb;
        --paper-light: #fffaf0;
        --line: #b8b09e;
        --moss: #385847;
        --moss-dark: #203b2d;
        --signal: #ee6b3b;
        --signal-dark: #b83f1d;
        --warning: #8a5317;
        --shadow: 0 24px 70px rgba(42, 49, 39, 0.16);
        font-family: "Aptos", "Segoe UI Variable", "Noto Sans CJK SC", sans-serif;
        color: var(--ink);
        background: var(--paper);
      }

      * { box-sizing: border-box; }
      [hidden] { display: none !important; }

      body {
        margin: 0;
        min-width: 320px;
        min-height: 100vh;
        background:
          linear-gradient(115deg, rgba(255, 250, 240, 0.94), rgba(236, 225, 204, 0.92)),
          repeating-linear-gradient(0deg, transparent 0 31px, rgba(23, 32, 25, 0.07) 31px 32px),
          repeating-linear-gradient(90deg, transparent 0 31px, rgba(23, 32, 25, 0.07) 31px 32px);
      }

      button, input { font: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: 0.48; }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: minmax(290px, 0.78fr) minmax(480px, 1.55fr);
      }

      .masthead {
        position: relative;
        display: flex;
        min-height: 100vh;
        flex-direction: column;
        justify-content: space-between;
        overflow: hidden;
        padding: clamp(32px, 5vw, 72px);
        color: #f8f1e4;
        background:
          radial-gradient(circle at 82% 16%, rgba(238, 107, 59, 0.9) 0 5px, transparent 6px),
          radial-gradient(circle at 82% 16%, transparent 0 62px, rgba(238, 107, 59, 0.45) 63px 64px, transparent 65px),
          linear-gradient(145deg, #13271c 0%, #294c38 58%, #172d21 100%);
      }

      .masthead::after {
        content: "";
        position: absolute;
        width: 360px;
        height: 360px;
        right: -180px;
        bottom: -170px;
        border: 1px solid rgba(248, 241, 228, 0.28);
        border-radius: 50%;
        box-shadow: 0 0 0 52px rgba(248, 241, 228, 0.035), 0 0 0 104px rgba(248, 241, 228, 0.025);
      }

      .brand-mark {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }

      .brand-mark::before {
        content: "";
        width: 34px;
        height: 10px;
        border-top: 2px solid var(--signal);
        border-bottom: 2px solid var(--signal);
      }

      .masthead-copy { position: relative; z-index: 1; max-width: 560px; }
      .mode-label {
        margin: 0 0 22px;
        color: #f5aa82;
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        font-size: 12px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        max-width: 9ch;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: clamp(46px, 6vw, 82px);
        font-weight: 600;
        line-height: 0.96;
        letter-spacing: -0.045em;
      }

      .masthead-copy > p:last-child {
        max-width: 38ch;
        margin: 28px 0 0;
        color: rgba(248, 241, 228, 0.74);
        font-size: 15px;
        line-height: 1.7;
      }

      .runtime-note {
        position: relative;
        z-index: 1;
        display: grid;
        gap: 12px;
        padding-top: 24px;
        border-top: 1px solid rgba(248, 241, 228, 0.22);
      }

      .runtime-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        color: rgba(248, 241, 228, 0.72);
        font-size: 12px;
      }

      .runtime-row strong {
        color: #fffaf0;
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        font-weight: 600;
      }

      .workspace {
        min-width: 0;
        padding: clamp(26px, 4.5vw, 68px);
        overflow: auto;
      }

      .workspace-inner { max-width: 980px; margin: 0 auto; }
      .workspace-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 30px;
      }

      .eyebrow {
        margin: 0 0 9px;
        color: var(--signal-dark);
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.17em;
        text-transform: uppercase;
      }

      h2 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: clamp(32px, 4vw, 52px);
        font-weight: 600;
        line-height: 1;
        letter-spacing: -0.035em;
      }

      .button {
        min-height: 44px;
        padding: 0 18px;
        border: 1px solid var(--ink);
        border-radius: 2px;
        color: var(--paper-light);
        background: var(--ink);
        font-weight: 700;
        transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease;
      }

      .button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 4px 4px 0 var(--signal); }
      .button.secondary { color: var(--ink); background: transparent; }
      .button.secondary:hover:not(:disabled) { box-shadow: 4px 4px 0 rgba(23, 32, 25, 0.18); }
      .button.signal { border-color: var(--signal-dark); background: var(--signal); }
      .button.small { min-height: 36px; padding: 0 13px; font-size: 13px; }

      .notice {
        margin-bottom: 22px;
        padding: 16px 18px;
        border-left: 4px solid var(--warning);
        color: #5d3c17;
        background: #f7dfb6;
        line-height: 1.55;
      }

      .notice strong { display: block; margin-bottom: 4px; }
      .summary-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin: 0 0 14px;
        color: var(--ink-soft);
        font-size: 13px;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #a33d26;
        box-shadow: 0 0 0 4px rgba(163, 61, 38, 0.12);
      }

      .status.available .status-dot {
        background: #357454;
        box-shadow: 0 0 0 4px rgba(53, 116, 84, 0.14);
      }

      .server-list { display: grid; gap: 13px; }
      .server-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 22px;
        padding: 21px 22px;
        border: 1px solid var(--line);
        border-radius: 3px;
        background: rgba(255, 250, 240, 0.78);
        box-shadow: 0 8px 24px rgba(57, 64, 51, 0.05);
        animation: rise 420ms both;
      }

      .server-card:hover { border-color: #716c60; background: var(--paper-light); }
      .server-name {
        margin: 0 0 8px;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: 24px;
        font-weight: 600;
      }

      .server-meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--ink-soft); font-size: 12px; }
      .server-meta code, .log-path {
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        overflow-wrap: anywhere;
      }

      .server-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .text-button {
        padding: 7px 8px;
        border: 0;
        color: var(--ink-soft);
        background: transparent;
        font-size: 12px;
        font-weight: 700;
      }
      .text-button:hover { color: var(--signal-dark); }

      .empty-state {
        padding: clamp(34px, 7vw, 76px) 26px;
        border: 1px dashed #8e8779;
        text-align: center;
        background: rgba(255, 250, 240, 0.45);
      }

      .empty-state strong {
        display: block;
        margin-bottom: 10px;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: 28px;
      }

      .empty-state p { max-width: 46ch; margin: 0 auto 22px; color: var(--ink-soft); line-height: 1.6; }

      .editor {
        margin-top: 22px;
        padding: clamp(22px, 4vw, 34px);
        border: 1px solid var(--ink);
        background: var(--paper-light);
        box-shadow: var(--shadow);
        animation: rise 240ms both;
      }

      .editor-header { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 24px; }
      .editor h3 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: 30px;
        font-weight: 600;
      }

      .form-grid { display: grid; grid-template-columns: 1fr 0.55fr; gap: 18px; }
      .field:first-child { grid-column: 1 / -1; }
      .field label {
        display: block;
        margin-bottom: 7px;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.04em;
      }

      .field input {
        width: 100%;
        height: 46px;
        padding: 0 13px;
        border: 1px solid #878071;
        border-radius: 0;
        outline: none;
        color: var(--ink);
        background: #fffdf7;
      }

      .field input:focus { border-color: var(--signal-dark); box-shadow: 0 0 0 3px rgba(238, 107, 59, 0.16); }
      .field small { display: block; margin-top: 7px; color: var(--ink-soft); line-height: 1.45; }
      .form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 25px; }

      .diagnostics {
        margin-top: 26px;
        padding-top: 17px;
        border-top: 1px solid var(--line);
        color: var(--ink-soft);
        font-size: 11px;
        line-height: 1.6;
      }

      .toast {
        position: fixed;
        z-index: 20;
        right: 24px;
        bottom: 24px;
        max-width: min(440px, calc(100vw - 48px));
        padding: 15px 18px;
        border-left: 4px solid var(--signal);
        color: #fffaf0;
        background: var(--ink);
        box-shadow: var(--shadow);
        animation: rise 220ms both;
      }

      .connecting {
        position: fixed;
        z-index: 30;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(18, 29, 22, 0.88);
        backdrop-filter: blur(9px);
      }

      .connecting-card {
        width: min(520px, 100%);
        padding: 38px;
        color: var(--paper-light);
        background: var(--moss-dark);
        border: 1px solid rgba(255, 250, 240, 0.22);
        box-shadow: var(--shadow);
      }

      .track { height: 3px; margin: 25px 0; overflow: hidden; background: rgba(255, 250, 240, 0.16); }
      .track::after {
        content: "";
        display: block;
        width: 42%;
        height: 100%;
        background: var(--signal);
        animation: scan 1.2s ease-in-out infinite;
      }

      .connecting-card h3 {
        margin: 0 0 10px;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        font-size: 34px;
        font-weight: 600;
      }

      .connecting-card p { margin: 0; color: rgba(255, 250, 240, 0.7); line-height: 1.6; }
      .connecting-steps {
        margin: 22px 0 0;
        padding: 0;
        list-style: none;
        color: rgba(255, 250, 240, 0.72);
        font-family: "Cascadia Code", "JetBrains Mono", monospace;
        font-size: 12px;
        line-height: 2;
      }

      @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
      @keyframes scan { from { transform: translateX(-110%); } to { transform: translateX(350%); } }

      @media (max-width: 900px) {
        .shell { grid-template-columns: 1fr; }
        .masthead { min-height: 390px; padding: 32px; }
        .masthead-copy { margin: 44px 0; }
        h1 { max-width: 12ch; font-size: clamp(44px, 11vw, 68px); }
        .workspace { padding: 34px 24px 52px; }
      }

      @media (max-width: 620px) {
        .workspace-header { align-items: flex-start; flex-direction: column; }
        .server-card { grid-template-columns: 1fr; }
        .server-actions { justify-content: flex-start; }
        .form-grid { grid-template-columns: 1fr; }
        .field:first-child { grid-column: auto; }
        .form-actions { flex-direction: column-reverse; }
        .form-actions .button { width: 100%; }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="masthead">
        <div class="brand-mark">DSH Desktop</div>
        <div class="masthead-copy">
          <p class="mode-label">Remote mode / 01</p>
          <h1>穿过隧道，回到 DSH。</h1>
          <p>复用本机 OpenSSH 与 <code>~/.ssh/config</code>，建立只绑定回环地址的端口转发，再由内置 Chromium 接管工作界面。</p>
        </div>
        <div class="runtime-note">
          <div class="runtime-row"><span>Renderer</span><strong>Chromium / CEF</strong></div>
          <div class="runtime-row"><span>Transport</span><strong>OpenSSH LocalForward</strong></div>
        </div>
      </aside>

      <main class="workspace">
        <div class="workspace-inner">
          <header class="workspace-header">
            <div>
              <p class="eyebrow">Connection desk</p>
              <h2>选择服务器</h2>
            </div>
            <button id="add-server" class="button signal" type="button">添加服务器</button>
          </header>

          <div id="notice" class="notice" role="alert" hidden></div>
          <div class="summary-line">
            <span id="server-count">正在读取配置...</span>
            <span id="ssh-status" class="status"><span class="status-dot"></span><span>检测 OpenSSH</span></span>
          </div>

          <section id="server-list" class="server-list" aria-live="polite"></section>
          <section id="empty-state" class="empty-state" hidden>
            <strong>还没有远程入口</strong>
            <p>添加一个 <code>~/.ssh/config</code> 中的 Host 别名。SSH 用户、端口、密钥和跳板机继续由 OpenSSH 管理。</p>
            <button id="empty-add" class="button" type="button">添加第一台服务器</button>
          </section>

          <section id="editor" class="editor" aria-labelledby="editor-title" hidden>
            <div class="editor-header">
              <div>
                <p class="eyebrow">Remote profile</p>
                <h3 id="editor-title">添加服务器</h3>
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
                  <small>直接交给本机 <code>ssh</code>，会读取 <code>~/.ssh/config</code>。</small>
                </div>
                <div class="field">
                  <label for="remote-port">DSH Web 端口</label>
                  <input id="remote-port" name="remotePort" type="number" required min="1" max="65535" value="3080" inputmode="numeric">
                  <small>远端默认是 <code>3080</code>。</small>
                </div>
              </div>
              <div class="form-actions">
                <button id="cancel-editor" class="button secondary" type="button">取消</button>
                <button class="button" type="submit">保存服务器</button>
              </div>
            </form>
          </section>

          <footer class="diagnostics">
            <div>日志目录：<code id="log-directory" class="log-path">正在初始化...</code></div>
            <div>认证支持 <code>.ssh/config</code>、密钥与 <code>ssh-agent</code>；首版不处理密码交互。</div>
          </footer>
        </div>
      </main>
    </div>

    <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
    <div id="connecting" class="connecting" role="dialog" aria-modal="true" aria-labelledby="connecting-title" hidden>
      <div class="connecting-card">
        <p class="eyebrow">Secure handoff</p>
        <h3 id="connecting-title">正在建立 SSH 隧道</h3>
        <p id="connecting-target">正在准备远程连接...</p>
        <div class="track"></div>
        <ul class="connecting-steps">
          <li>01 · 读取本机 .ssh/config</li>
          <li>02 · 建立回环端口转发</li>
          <li>03 · 验证远端 DSH Web</li>
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
          element.classList.toggle("available", state.ssh.available);
          element.lastElementChild.textContent = state.ssh.available
            ? "OpenSSH " + (state.ssh.version || "可用")
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

          state.profiles.forEach(function (profile, index) {
            var card = document.createElement("article");
            card.className = "server-card";
            card.style.animationDelay = String(index * 45) + "ms";

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
              actionButton("删除", "text-button", function () { deleteProfile(profile); }),
              actionButton("连接", "button small", function () { connectProfile(profile); }, !state.ssh.available)
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
