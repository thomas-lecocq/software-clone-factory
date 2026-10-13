/* global process, console */
// The agent container's only way out: an HTTPS CONNECT proxy that lets through the hosts in
// ALLOW (comma-separated, exact names, port 443) and refuses everything else, logging each
// decision. The agent's network is internal, so a request that bypasses this proxy has no route.
import { createServer } from "node:http";
import { connect } from "node:net";

const allow = new Set((process.env.ALLOW ?? "").split(",").filter((h) => h !== ""));
const server = createServer((req, res) => {
  console.log(`denied plain-http ${req.method ?? ""} ${req.url ?? ""}`);
  res.writeHead(403);
  res.end("plain HTTP is not allowed\n");
});
server.on("connect", (req, socket, head) => {
  const [host = "", port = ""] = (req.url ?? "").split(":");
  if (!allow.has(host) || port !== "443") {
    console.log(`denied ${req.url ?? ""}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  console.log(`allowed ${req.url ?? ""}`);
  const upstream = connect(443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(3128, "0.0.0.0");
