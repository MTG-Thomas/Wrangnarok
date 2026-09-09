import { createServer } from "node:http";
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/echo") { res.writeHead(404).end(); return; }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body.message !== "string" || Buffer.byteLength(body.message) > 1024) throw new Error("invalid");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ message: body.message }));
  } catch { if (!res.headersSent) res.writeHead(400).end(); }
});
server.listen(8788, "127.0.0.1", () => console.log("Local vendor fixture: http://127.0.0.1:8788/echo"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
