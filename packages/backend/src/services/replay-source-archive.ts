import fs from "node:fs/promises";
import path from "node:path";
/** Git archives are untrusted input: validate the entire archive before any host filesystem writes. */
export async function extractReplayArchive(archive: string, destination: string): Promise<void> {
  if ((await fs.stat(archive)).size > 64 * 1024 * 1024)
    throw new Error("Replay source archive exceeds its retention budget");
  const tar = await fs.readFile(archive);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const string = (buffer: Buffer) =>
    decoder.decode(buffer.subarray(0, buffer.indexOf(0) < 0 ? buffer.length : buffer.indexOf(0)));
  const entries: Array<{ name: string; directory: boolean; body: Buffer; mode: number }> = [];
  const names = new Map<string, boolean>();
  let pax: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeField = string(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("Unsupported replay archive size header");
    const size = parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("Truncated replay source archive");
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = header[156];
    if (type === 120 || type === 103) {
      const values: Record<string, string> = {};
      for (let position = 0; position < body.length; ) {
        const separator = body.indexOf(32, position);
        if (separator < 0) throw new Error("Invalid replay archive extension");
        const lengthText = body.subarray(position, separator).toString("ascii");
        if (!/^\d+$/.test(lengthText)) throw new Error("Invalid replay archive extension length");
        const length = Number(lengthText);
        if (
          length <= separator - position + 1 ||
          position + length > body.length ||
          body[position + length - 1] !== 10
        )
          throw new Error("Invalid replay archive extension record");
        const record = decoder.decode(body.subarray(separator + 1, position + length - 1));
        const equals = record.indexOf("=");
        if (equals < 1) throw new Error("Invalid replay archive extension key");
        values[record.slice(0, equals)] = record.slice(equals + 1);
        position += length;
      }
      if (values.linkpath || values.size || (type === 103 && values.path))
        throw new Error("Unsupported replay archive link or global path metadata");
      if (type === 120) pax = values;
      continue;
    }
    if (![0, 48, 53].includes(type))
      throw new Error("Replay archive links and special files are unsupported");
    const prefix = string(header.subarray(345, 500));
    const filename = string(header.subarray(0, 100));
    const raw = pax.path ?? (prefix ? `${prefix}/${filename}` : filename);
    pax = {};
    const name = raw.replace(/\/$/, "");
    const parts = name.split("/");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      throw new Error("Replay archive contains an unsafe or reserved Git path");
    const key = name.toLowerCase();
    if (names.has(key))
      throw new Error("Replay archive contains duplicate or case-conflicting paths");
    for (let i = 1; i < parts.length; i++)
      if (names.get(parts.slice(0, i).join("/").toLowerCase()) === false)
        throw new Error("Replay archive contains conflicting parent paths");
    const directory = type === 53;
    if (!directory && [...names.keys()].some((existing) => existing.startsWith(`${key}/`)))
      throw new Error("Replay archive contains a conflicting file parent");
    names.set(key, directory);
    entries.push({
      name,
      directory,
      body,
      mode: parseInt(string(header.subarray(100, 108)).trim(), 8) & 0o777,
    });
    if (entries.length > 100_000) throw new Error("Replay archive has too many files");
  }
  for (const entry of entries) {
    const target = path.join(destination, entry.name);
    if (entry.directory) await fs.mkdir(target, { recursive: true, mode: 0o700 });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.body, { flag: "wx", mode: entry.mode || 0o600 });
    }
  }
}
