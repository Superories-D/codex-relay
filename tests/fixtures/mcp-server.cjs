// Deterministic local MCP service. No network, shell execution or model requests.
const readline = require("node:readline");
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "relay-fixture", version: "1.0.0" },
      });
    case "tools/list":
      return send(request.id, {
        tools: [
          {
            name: "echo",
            description: "Echo a local fixture value",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      });
    case "tools/call":
      return send(request.id, {
        content: [
          { type: "text", text: String(request.params.arguments.value) },
        ],
      });
    case "resources/list":
      return send(request.id, {
        resources: [
          {
            uri: "fixture://note",
            name: "Fixture note",
            mimeType: "text/plain",
          },
        ],
      });
    case "resources/templates/list":
      return send(request.id, { resourceTemplates: [] });
    case "resources/read":
      return send(request.id, {
        contents: [
          {
            uri: "fixture://note",
            mimeType: "text/plain",
            text: "Local MCP resource",
          },
        ],
      });
    case "ping":
      return send(request.id, {});
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Unsupported fixture method" },
        }) + "\n",
      );
  }
});
