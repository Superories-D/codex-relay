import type { GitBranchList } from "../shared/git";

type Git = (cwd: string, args: string[]) => Promise<string>;

export async function readBranches(
  git: Git,
  cwd: string,
): Promise<GitBranchList> {
  let current = "",
    oid = "";
  try {
    current = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  } catch (error: any) {
    if (error.code !== 1) throw error;
  }
  try {
    oid = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
  } catch (error: any) {
    if (error.code !== 1) throw error;
  }
  const raw = await git(cwd, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(symref)%00%(upstream:short)%00%(worktreepath)",
    "refs/heads",
    "refs/remotes",
  ]);
  return {
    current,
    head: `${current}:${oid}`,
    branches: raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [ref, symref, upstream, worktree] = line
          .replace(/\r$/, "")
          .split("\0");
        if (symref) return []; // Remote HEAD aliases are not branches.
        return [
          {
            ref,
            name: ref.replace(/^refs\/(heads|remotes)\//, ""),
            remote: ref.startsWith("refs/remotes/"),
            upstream,
            worktree,
          },
        ];
      }),
  };
}

export async function switchBranch(
  git: Git,
  cwd: string,
  ref: string,
  expectedHead: string,
  name?: string,
) {
  const before = await readBranches(git, cwd);
  if (before.head !== expectedHead)
    throw new Error("当前分支或提交已变化，请刷新分支列表后重试");
  const target = before.branches.find((branch) => branch.ref === ref);
  if (!target && !(ref === "HEAD" && name))
    throw new Error("所选分支已不存在，请刷新分支列表");
  if (name !== undefined) {
    if (
      !name ||
      name === "HEAD" ||
      name.startsWith("-") ||
      name.trim() !== name
    )
      throw new Error("新分支名称无效");
    try {
      await git(cwd, ["check-ref-format", `refs/heads/${name}`]);
    } catch {
      throw new Error("新分支名称无效");
    }
    // -c is transactional: a failed checkout does not leave a new branch.
    await git(cwd, [
      "switch",
      "--no-guess",
      "-c",
      name,
      ...(target?.remote ? ["--track"] : []),
      ...(ref === "HEAD" ? [] : ["--", ref]),
    ]);
  } else {
    if (target!.remote) throw new Error("请为远程分支创建本地跟踪分支");
    await git(cwd, ["switch", "--no-guess", "--", target!.name]);
  }
}
