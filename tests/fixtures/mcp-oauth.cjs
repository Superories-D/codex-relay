// Loopback-only OAuth/MCP fixture. All tokens and identities are synthetic.
const http = require("node:http");
exports.start = async () => {
  const counters = {
    registration: 0,
    authorization: 0,
    token: 0,
    authenticatedMcp: 0,
  };
  let origin;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const text = Buffer.concat(body).toString();
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return send(200, {
        resource: origin + "/mcp",
        authorization_servers: [origin],
        scopes_supported: ["fixture.read"],
      });
    if (url.pathname.startsWith("/.well-known/"))
      return send(200, {
        issuer: origin,
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        registration_endpoint: origin + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register") {
      counters.registration++;
      return send(201, {
        ...JSON.parse(text),
        client_id: "fixture-client",
        token_endpoint_auth_method: "none",
      });
    }
    if (url.pathname === "/authorize") {
      counters.authorization++;
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname))
        return send(400, {});
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: redirect.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      counters.token++;
      return send(200, {
        access_token: "fixture-access",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "fixture-refresh",
        scope: "fixture.read",
      });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer fixture-access") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        return res.end();
      }
      counters.authenticatedMcp++;
      if (req.method === "DELETE") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const message = JSON.parse(text);
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      let result = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-fixture", version: "1.0.0" },
        };
      if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "authorized_echo",
              description: "Authorized local fixture",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      if (message.method === "resources/list") result = { resources: [] };
      if (message.method === "resources/templates/list")
        result = { resourceTemplates: [] };
      return send(200, { jsonrpc: "2.0", id: message.id, result });
    }
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    counters,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
};
