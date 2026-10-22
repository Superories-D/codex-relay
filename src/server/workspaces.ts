import { promises as fs } from "node:fs";
import path from "node:path";
const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
};
export async function prepareWorkspaces(
  dataRoot: string,
  workspaces: string[],
) {
  const roots = [
    ...new Set(
      await Promise.all(
        workspaces.map(async (p) => {
          const real = await fs.realpath(p);
          if (!(await fs.stat(real)).isDirectory())
            throw Error("Workspace must be a directory");
          return real;
        }),
      ),
    ),
  ];
  if (
    roots.some((root) => contains(root, dataRoot) || contains(dataRoot, root))
  )
    throw Error(
      "Workspaces must not overlap the private server data directory",
    );
  return roots;
}
export async function resolveWorkspace(roots: string[], value: unknown) {
  if (typeof value !== "string") throw Error("Workspace path is required");
  const real = await fs.realpath(value);
  if (!roots.some((root) => contains(root, real)))
    throw Error("Path is outside configured workspaces");
  return real;
}
