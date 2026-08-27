// A dsh-web stand-in for verifying process cleanup on Windows without a real
// dsh install. It listens on 127.0.0.1:<port> and runs forever, and spawns one
// child node process to mirror `dsh web` (main process + child process).
//
// Usage (mirrors how the desktop app launches the .ps1 shim):
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File fake-dsh.ps1 web --host 127.0.0.1 --port 47890 --no-open
const http = require("node:http");
const { spawn } = require("node:child_process");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue("--port") ?? 47890);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("fake dsh web\n");
});

server.listen(port, "127.0.0.1", () => {
  // Mirror `dsh web` spawning a worker child process that stays alive.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  console.log(`fake dsh web listening on http://127.0.0.1:${port}/ (pid ${process.pid})`);
});
