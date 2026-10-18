import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { Catalog, localCatalogOperation } from "../src/core/catalog";
import { readExtensions } from "../src/renderer/extensions";

function fixture() {
  const rpc = Object.assign(new EventEmitter(), {
    call: vi.fn(async (_method: string, _params: unknown) => ({}) as any),
    close: vi.fn(async () => {}),
    reject: vi.fn(),
  });
  const open = vi.fn(async () => rpc as any);
  const update = vi.fn();
  let cli = "fixture-cli";
  const catalog = new Catalog("fixture-home", () => cli, update, open);
  return {
    rpc,
    open,
    update,
    catalog,
    changeCli: () => {
      cli = "replacement-cli";
    },
  };
}

it("retains one CLI process for OAuth completion and successive local operations", async () => {
  const { rpc, open, update, catalog } = fixture();
  rpc.call.mockResolvedValueOnce({
    authorizationUrl: "https://example.invalid/authorize",
    loginId: "login",
  });
  await catalog.operation("mcpServer/oauth/login", { name: "fixture" });
  expect(rpc.close).not.toHaveBeenCalled();
  rpc.emit("mcpServer/oauthLogin/completed", {
    name: "fixture",
    success: true,
    loginId: "login",
  });
  expect(update).toHaveBeenCalledWith({
    name: "fixture",
    success: true,
    loginId: "login",
  });
  await catalog.operation("mcpServerStatus/list", {});
  expect(open).toHaveBeenCalledTimes(1);
  await catalog.shutdown();
  expect(rpc.close).toHaveBeenCalledTimes(1);
  await expect(catalog.operation("config/read", {})).rejects.toThrow();
});

it("does not replay unknown-outcome writes and only reconnects on the next explicit operation", async () => {
  const { rpc, open, update, catalog } = fixture();
  await catalog.operation("mcpServer/oauth/login", { name: "fixture" });
  rpc.call.mockImplementationOnce(async () => {
    rpc.emit("disconnected", Error("lost"));
    throw Error("lost");
  });
  await expect(catalog.operation("config/value/write", {})).rejects.toThrow(
    "lost",
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ name: "fixture", success: false }),
  );
  expect(open).toHaveBeenCalledTimes(1);
  await catalog.operation("config/read", {});
  expect(open).toHaveBeenCalledTimes(2);
  await catalog.shutdown();
});

it("refuses a competing CLI process after shutdown or replacement fails to stop the previous one", async () => {
  const { rpc, open, catalog, changeCli } = fixture();
  await catalog.operation("config/read", {});
  rpc.close.mockRejectedValueOnce(Error("still running"));
  await expect(catalog.shutdown()).rejects.toThrow("still running");
  changeCli();
  rpc.close.mockRejectedValueOnce(Error("still running"));
  await expect(catalog.operation("config/read", {})).rejects.toThrow(
    "still running",
  );
  expect(open).toHaveBeenCalledTimes(1);
  await catalog.shutdown();
});

it("drains the active operation and refuses queued operations during shutdown", async () => {
  const { rpc, catalog } = fixture();
  let finish!: () => void;
  rpc.call.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const active = catalog.operation("config/read", {}).catch(() => {});
  await vi.waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
  const queued = catalog.operation("config/read", {}).catch((e) => e);
  const closing = catalog.shutdown();
  expect(rpc.close).not.toHaveBeenCalled();
  finish();
  await active;
  expect(await queued).toBeInstanceOf(Error);
  await closing;
  expect(rpc.call).toHaveBeenCalledTimes(1);
  expect(rpc.close).toHaveBeenCalledTimes(1);
});

it("runs account preparation only when supplied and keeps local capabilities independent of sign-in", async () => {
  const { rpc, catalog } = fixture();
  const prepare = vi.fn(async () => {});
  for (const method of [
    "skills/list",
    "mcpServerStatus/list",
    "mcpServer/oauth/login",
    "config/value/write",
  ])
    expect(localCatalogOperation(method)).toBe(true);
  expect(localCatalogOperation("plugin/install")).toBe(false);
  await catalog.operation("config/read", {});
  await catalog.operation("plugin/list", {}, prepare);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(rpc);
  await catalog.shutdown();
});

it("loads every MCP page and derives disabled state without making plugin-owned servers editable", async () => {
  const operation = vi
    .fn()
    .mockResolvedValueOnce({ data: [{ name: "one" }], nextCursor: "next" })
    .mockResolvedValueOnce({
      data: [{ name: "plugin_server", pluginId: "plugin" }],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      config: { mcp_servers: { one: { enabled: false }, plugin_server: {} } },
    });
  const result = await readExtensions("mcp", "", operation);
  expect(operation.mock.calls[1]).toEqual([
    "mcpServerStatus/list",
    { limit: 100, cursor: "next" },
  ]);
  expect(result.data).toEqual([
    { name: "one", enabled: false, manageable: true },
    {
      name: "plugin_server",
      pluginId: "plugin",
      enabled: true,
      manageable: false,
    },
  ]);
});

it("stops a repeated cursor and passes project discovery paths to plugins and Skills", async () => {
  const operation = vi
    .fn()
    .mockResolvedValue({ data: [], nextCursor: "repeated" });
  await expect(readExtensions("mcp", "", operation)).rejects.toThrow();
  expect(operation).toHaveBeenCalledTimes(2);
  await readExtensions("plugins", "project", operation);
  expect(operation).toHaveBeenLastCalledWith("plugin/list", {
    cwds: ["project"],
  });
  await readExtensions("skills", "project", operation);
  expect(operation).toHaveBeenLastCalledWith("skills/list", {
    cwds: ["project"],
    forceReload: true,
  });
});
