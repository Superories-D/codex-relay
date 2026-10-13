// Test process preload only. Production CLI always uses its authenticated local pipe.
const net = require("node:net");
const createConnection = net.createConnection;
net.createConnection = function (endpoint, ...args) {
  return typeof endpoint === "string"
    ? createConnection(
        { port: Number(process.env.RELAY_TEST_PORT), host: "127.0.0.1" },
        ...args,
      )
    : createConnection(endpoint, ...args);
};
