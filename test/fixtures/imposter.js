import { createServer } from "node:net";

// Stands in for a daemon from an older codeq: it owns the socket and answers
// every line with an error, the way an old build treats an unknown command.
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", () => {
    socket.write(`${JSON.stringify({ type: "error", error: "unknown command: ping" })}\n`);
    socket.end();
  });
  socket.on("error", () => {});
});
server.listen(process.argv[2]);
