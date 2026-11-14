import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

export function openDatabase(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  db.pragma("user_version = 1");
  return db;
}
