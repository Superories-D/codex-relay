import { parseArgs } from "node:util";
import {
  backupPassword,
  createBackup,
  verifyBackup,
  restoreBackup,
} from "./backup";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      file: { type: "string" },
      "password-file": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(
      "Relay encrypted offline backup (Linux)\ncreate --data-dir DIR --file BACKUP --password-file PRIVATE_FILE\nverify --file BACKUP --password-file PRIVATE_FILE\nrestore --data-dir ORIGINAL_DIR --file BACKUP --password-file PRIVATE_FILE\nStop the service cleanly first. Restore never overwrites existing directories. Password files must be private; backup includes account credentials and native history.",
    );
    return;
  }
  if (!values.file || !values["password-file"])
    throw Error("--file and --password-file are required");
  const password = await backupPassword(values["password-file"]),
    operation = positionals[0];
  if (operation !== "verify" && !values["data-dir"])
    throw Error("--data-dir is required");
  const result =
    operation === "create"
      ? await createBackup(values["data-dir"]!, values.file, password)
      : operation === "verify"
        ? await verifyBackup(values.file, password)
        : operation === "restore"
          ? await restoreBackup(values.file, values["data-dir"]!, password)
          : undefined;
  if (!result) throw Error("Choose create, verify or restore");
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
