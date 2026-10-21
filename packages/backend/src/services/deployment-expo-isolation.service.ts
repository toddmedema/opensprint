import fs from "node:fs/promises";
import path from "node:path";
import type { DeploymentConfig } from "@opensprint/shared";
import { checkExpoAuth, type ExpoAuthCheck } from "../utils/expo-auth-check.js";
import { getDeploymentMode } from "./deployment-mode.js";
import { DEFAULT_EAS_JSON } from "./eas-config.js";
import { getExpoDeployCommand } from "../utils/expo-deploy-command.js";

/** Hosted deployment never probes a repository CLI or borrows the host's Expo login. */
export async function checkDeploymentExpoAuth(
  repoPath: string,
  config: DeploymentConfig,
  environment?: Record<string, string>
): Promise<ExpoAuthCheck> {
  if (getDeploymentMode() !== "isolated-hosted")
    return checkExpoAuth(repoPath, { projectExpoToken: config.expoToken });
  const token = environment?.EXPO_TOKEN?.trim() || config.expoToken?.trim();
  if (token) return { ok: true, expoToken: token };
  return {
    ok: false,
    missing: "api_key",
    code: "EXPO_TOKEN_REQUIRED",
    message: "Hosted Expo deployment requires a project Expo access token.",
    prompt: "Ask the host to set an Expo access token in this project's delivery settings.",
  };
}

/** Readiness is a static read; no project executable runs on the backend. */
export async function hostedExpoReadiness(repoPath: string) {
  const read = async (name: string): Promise<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(repoPath, name), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const [pkg, app] = await Promise.all([read("package.json"), read("app.json")]);
  const dependencies = {
    ...(pkg.dependencies as Record<string, unknown>),
    ...(pkg.devDependencies as Record<string, unknown>),
  };
  const expo = app.expo as { extra?: { eas?: { projectId?: unknown } } } | undefined;
  return {
    expoInstalled: Boolean(dependencies.expo || dependencies["eas-cli"]),
    easProjectLinked:
      typeof expo?.extra?.eas?.projectId === "string" && expo.extra.eas.projectId.trim().length > 0,
  };
}

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/** Setup and deployment share one disposable workspace so install/config output survives. */
export function hostedExpoCommand(
  variant: "beta" | "prod",
  projectName = "App",
  easProjectId?: string
): string {
  const setup = `const fs=require("node:fs");
const input=${JSON.stringify({ projectName, easProjectId })};
const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):fallback;
const pkg=read("package.json",{});
const dynamic=fs.existsSync("app.config.js")||fs.existsSync("app.config.ts");
if(!dynamic||fs.existsSync("app.json")){
 const app=read("app.json",{});const expo=app.expo??{};
 expo.name ||= input.projectName.trim()||"App";
 expo.slug ||= input.projectName.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"app";
 expo.version ||= pkg.version||"1.0.0";
 if(input.easProjectId){expo.extra??={};expo.extra.eas??={};expo.extra.eas.projectId ||= input.easProjectId;}
 app.expo=expo;fs.writeFileSync("app.json",JSON.stringify(app,null,2));
}
if(!fs.existsSync("eas.json"))fs.writeFileSync("eas.json",JSON.stringify(${JSON.stringify(DEFAULT_EAS_JSON)},null,2));`;
  const install =
    "if [ -f package-lock.json ]; then npm ci --offline --ignore-scripts; else npm install --offline --ignore-scripts; fi";
  const link = easProjectId
    ? ` && if [ ! -f app.json ]; then npx --offline eas-cli init --id ${shellQuote(easProjectId)} --non-interactive; fi`
    : "";
  return `${install} && node -e ${shellQuote(setup)}${link} && ${getExpoDeployCommand(variant)}`;
}
