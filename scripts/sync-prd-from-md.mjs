#!/usr/bin/env node
/**
 * Sync .opensprint/prd.json from PRD.md
 * Maps PRD.md sections to prd.json section keys.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PRD_MD = path.join(ROOT, "PRD.md");
const PRD_JSON = path.join(ROOT, ".opensprint", "prd.json");

/** Map PRD.md section numbers to prd.json keys. Some sections are combined. */
const SECTION_MAP = [
  { num: 1, key: "executive_summary" },
  { num: 2, key: "problem_statement" },
  { num: 3, key: "goals_and_metrics" },
  { num: 4, key: "user_personas" },
  { num: 5, key: "technical_architecture" },
  { num: 6, key: null }, // Project Setup - include in feature_list
  { num: 7, key: "feature_list" },
  { num: 8, key: null }, // Testing - include in feature_list
  { num: 9, key: null }, // Error Handling - include in feature_list
  { num: 10, key: "data_model" },
  { num: 11, key: "api_contracts" },
  { num: 12, key: null }, // Agent CLI - include in api_contracts
  { num: 13, key: null },
  { num: 14, key: null },
  { num: 15, key: "non_functional_requirements" },
  { num: 16, key: null },
  { num: 17, key: null },
  { num: 18, key: null },
  { num: 19, key: "open_questions" },
];

function extractSections(md) {
  const sections = {};
  const headerRe = /^## (\d+)\. (.+)$/gm;
  let match;
  const headers = [];
  while ((match = headerRe.exec(md)) !== null) {
    headers.push({ num: parseInt(match[1], 10), title: match[2], start: match.index });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].start;
    const end = i + 1 < headers.length ? headers[i + 1].start : md.length;
    let content = md.slice(start, end);
    // Strip the ## N. Title line (first line)
    const firstNewline = content.indexOf("\n");
    content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    content = content.replace(/^\s+/, "").replace(/\s+$/, "");
    sections[headers[i].num] = content;
  }
  return sections;
}

function buildPrdSections(mdSections) {
  const result = {};
  const now = new Date().toISOString();

  // feature_list: sections 6, 7, 8, 9
  const featureParts = [6, 7, 8, 9].filter((n) => mdSections[n]).map((n) => mdSections[n]);
  result.feature_list = featureParts.length
    ? featureParts.join("\n\n---\n\n")
    : "";

  // api_contracts: sections 11, 12
  const apiParts = [11, 12].filter((n) => mdSections[n]).map((n) => mdSections[n]);
  result.api_contracts = apiParts.length ? apiParts.join("\n\n---\n\n") : "";

  // Direct mappings
  for (const { num, key } of SECTION_MAP) {
    if (key && mdSections[num] && !result[key]) {
      result[key] = mdSections[num];
    }
  }

  return result;
}

function main() {
  const md = fs.readFileSync(PRD_MD, "utf-8");
  const mdSections = extractSections(md);
  const sectionContents = buildPrdSections(mdSections);

  const sectionKeys = [
    "executive_summary",
    "problem_statement",
    "goals_and_metrics",
    "user_personas",
    "technical_architecture",
    "feature_list",
    "data_model",
    "api_contracts",
    "non_functional_requirements",
    "open_questions",
  ];

  const now = new Date().toISOString();
  const sections = {};
  for (const key of sectionKeys) {
    const content = sectionContents[key] ?? "";
    sections[key] = {
      content,
      version: 1,
      updatedAt: now,
    };
  }

  const changeLog = sectionKeys.map((section) => ({
    section,
    version: 1,
    source: "spec",
    timestamp: now,
    diff: `[PRD.md sync: ${section}]`,
  }));

  const prd = {
    version: 1,
    sections,
    changeLog,
  };

  fs.writeFileSync(PRD_JSON, JSON.stringify(prd, null, 2), "utf-8");
  console.log("Updated .opensprint/prd.json from PRD.md");
}

main();
