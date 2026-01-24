import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, CLI_NAME } from "./constants";

/** Environment variable to override config directory (useful for testing) */
const CONFIG_DIR_ENV = `${CLI_NAME.toUpperCase()}_CONFIG_DIR`;

export interface Config {
  /** Path to the dev version binary to use instead of self */
  devVersionPath?: string;
}

function getConfigDir(): string {
  // Allow override via environment variable for testing
  const envDir = process.env[CONFIG_DIR_ENV];
  if (envDir) {
    return envDir;
  }
  return join(homedir(), CONFIG_DIR_NAME);
}

function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

export async function ensureConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  const file = Bun.file(configDir);
  if (!(await file.exists())) {
    await Bun.write(join(configDir, ".keep"), "");
    // Create dir by writing a file, then we can use it
  }
  try {
    const { mkdir } = await import("fs/promises");
    await mkdir(configDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}

export async function loadConfig(): Promise<Config> {
  await ensureConfigDir();
  const configPath = getConfigPath();
  const file = Bun.file(configPath);

  if (await file.exists()) {
    try {
      const content = await file.text();
      return JSON.parse(content) as Config;
    } catch {
      return {};
    }
  }

  return {};
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  const configPath = getConfigPath();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

export async function getDevVersionPath(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.devVersionPath;
}

export async function setDevVersionPath(path: string): Promise<void> {
  const config = await loadConfig();
  config.devVersionPath = path;
  await saveConfig(config);
}

export async function clearDevVersionPath(): Promise<void> {
  const config = await loadConfig();
  delete config.devVersionPath;
  await saveConfig(config);
}

export { getConfigDir, getConfigPath };
