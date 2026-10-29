import {afterEach, expect, it, vi} from "vitest";
import {promises as fs} from "node:fs";
import {Readable} from "node:stream";
import os from "node:os";
import path from "node:path";

// A real receiver exits on its protocol trailer, as Git index-pack does. Delay
// the file stream's EOF notification so the old pipeline race is deterministic.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {...actual, createReadStream: (file: string, options?: any) => {
    if (!String(file).endsWith("delayed-eof.pack")) return actual.createReadStream(file, options);
    return Readable.from((async function* () {
      const bytes = await actual.promises.readFile(file);
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        yield bytes.subarray(offset, offset + 65536);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    })());
  }};
});
vi.mock("../src/core/process", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/core/process")>();
  return {...actual, resolveCli: async () => ({executable: process.execPath, prefix: ["-e", `
    let bytes = 0;
    process.stdin.on('data', chunk => {
      bytes += chunk.length;
      if (bytes >= Number(process.env.RELAY_TEST_RECEIVE_BYTES)) {
        process.stdout.write('received:' + bytes);
        process.exit(Number(process.env.RELAY_TEST_EXIT_CODE || 0));
      }
    });
  `, "--"]})};
});
import {CheckpointGit} from "../src/main/checkpoint-git";
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true, force:true})));});
async function fixture(bytes: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-transport-")); roots.push(root);
  const file = path.join(root, "delayed-eof.pack"); await fs.writeFile(file, Buffer.alloc(bytes, 97));
  return {root, file, git:new CheckpointGit(path.join(root, "scratch"), {native:false})};
}
it("accepts protocol completion after every byte is written even when receiver closes before source EOF", async () => {
  const {root,file,git} = await fixture(65536);
  const output = await git.run(root, ["index-pack"], {stdinFile:file, env:{RELAY_TEST_RECEIVE_BYTES:"65536"}});
  expect(output.toString()).toBe("received:65536");
});
it("rejects a successful process that closes its pipe before the remaining input is written", async () => {
  const {root,file,git} = await fixture(131072);
  await expect(git.run(root, ["index-pack"], {stdinFile:file, env:{RELAY_TEST_RECEIVE_BYTES:"65536"}})).rejects.toThrow();
});
it("preserves command failure even when the complete input was transferred", async () => {
  const {root,file,git} = await fixture(65536);
  await expect(git.run(root, ["index-pack"], {stdinFile:file, env:{RELAY_TEST_RECEIVE_BYTES:"65536", RELAY_TEST_EXIT_CODE:"7"}})).rejects.toMatchObject({code:7});
});
