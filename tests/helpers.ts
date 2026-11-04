import { chmod, writeFile } from "node:fs/promises";

/** Windows cannot spawn a shebang .mjs directly; exercise the normal .cmd path. */
export async function executableNodeScript(script: string): Promise<string> {
  if (process.platform !== "win32") {
    await chmod(script, 0o755);
    return script;
  }
  const command = `${script}.cmd`;
  await writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
  return command;
}
