const http = require("http");

const PORT = 8080;
const TARGET_PORT = Number(process.env.XMINYC_PORT || 3000);

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const out = { ...up.headers };
      delete out["x-frame-options"];
      delete out["strict-transport-security"];
      for (const key of Object.keys(out)) {
        if (/content-security-policy/i.test(key) && typeof out[key] === "string") {
          out[key] = out[key].replace(/frame-ancestors\s+[^;]*/i, "frame-ancestors *");
        }
      }
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  req.pipe(upstream);
});

server.listen(PORT, "0.0.0.0");
