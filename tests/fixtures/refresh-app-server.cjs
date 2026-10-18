// Local auth-rotation fixture. Only synthetic credentials supplied by its test.
const fs = require("node:fs"),
  path = require("node:path"),
  readline = require("node:readline");
const home = process.env.RELAY_TEST_HOME;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method !== "account/read") {
    send({ id: m.id, result: {} });
    return;
  }
  const file = path.join(home, "auth.json");
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  const sequenceFile = path.join(home, "sequence.json");
  const generation = fs.existsSync(sequenceFile)
    ? JSON.parse(fs.readFileSync(sequenceFile, "utf8")) + 1
    : 1;
  fs.writeFileSync(sequenceFile, JSON.stringify(generation));
  const prior = auth.tokens.access_token;
  auth.tokens.access_token = `synthetic-generation-${generation}`;
  auth.tokens.refresh_token = `synthetic-rotated-${generation}`;
  auth.last_refresh = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(auth));
  fs.appendFileSync(
    path.join(home, "refresh-journal.jsonl"),
    JSON.stringify({
      pid: process.pid,
      generation,
      prior,
      refreshToken: m.params.refreshToken,
    }) + "\n",
  );
  setTimeout(() => {
    const fail = path.join(home, "fail-after-rotate");
    if (fs.existsSync(fail)) {
      fs.unlinkSync(fail);
      send({
        id: m.id,
        error: {
          code: -32000,
          message: "synthetic temporary failure after rotation",
        },
      });
    } else send({ id: m.id, result: { account: { type: "chatgpt" } } });
  }, 100);
});
