/**
 * Parse and validate cm.yml configuration
 */

import { parse as parseYaml } from "yaml";
import { dirname, join } from "path";
import { ConfigNotFoundError, ConfigValidationError } from "../errors";
import type {
  CmConfig,
  RawCmConfig,
  RawWorkflow,
  RawWorkflowStep,
  Workflow,
  WorkflowStep,
  Model,
} from "./types";

/** Name of the config file */
const CONFIG_FILENAME = "cm.yml";

/** Valid model values */
const VALID_MODELS: Model[] = ["opus", "sonnet", "haiku"];

/**
 * Find cm.yml by searching up the directory tree
 */
export async function findConfigFile(startPath: string): Promise<string> {
  let currentDir = startPath;

  while (true) {
    const configPath = join(currentDir, CONFIG_FILENAME);
    const file = Bun.file(configPath);

    if (await file.exists()) {
      return configPath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root
      throw new ConfigNotFoundError(startPath);
    }
    currentDir = parentDir;
  }
}

/**
 * Validate and normalize a workflow step
 */
function validateStep(raw: RawWorkflowStep, index: number): WorkflowStep {
  if (!raw.name || typeof raw.name !== "string") {
    throw new ConfigValidationError(
      `Step ${index + 1} must have a "name" property`
    );
  }

  const step: WorkflowStep = {
    name: raw.name,
  };

  if (raw.model !== undefined) {
    if (!VALID_MODELS.includes(raw.model as Model)) {
      throw new ConfigValidationError(
        `Step "${raw.name}" has invalid model "${raw.model}". Valid models: ${VALID_MODELS.join(", ")}`
      );
    }
    step.model = raw.model as Model;
  }

  if (raw.agent !== undefined) {
    if (typeof raw.agent !== "string") {
      throw new ConfigValidationError(
        `Step "${raw.name}" agent must be a string path`
      );
    }
    step.agent = raw.agent;
  }

  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== "string") {
      throw new ConfigValidationError(
        `Step "${raw.name}" prompt must be a string`
      );
    }
    step.prompt = raw.prompt;
  }

  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "number" || raw.timeout <= 0) {
      throw new ConfigValidationError(
        `Step "${raw.name}" timeout must be a positive number`
      );
    }
    step.timeout = raw.timeout;
  }

  return step;
}

/**
 * Validate and normalize a workflow
 */
function validateWorkflow(raw: RawWorkflow, name: string): Workflow {
  if (!raw.steps || !Array.isArray(raw.steps)) {
    throw new ConfigValidationError(
      `Workflow "${name}" must have a "steps" array`
    );
  }

  if (raw.steps.length === 0) {
    throw new ConfigValidationError(
      `Workflow "${name}" must have at least one step`
    );
  }

  const steps = raw.steps.map((step, index) => validateStep(step, index));

  // Check for duplicate step names
  const stepNames = new Set<string>();
  for (const step of steps) {
    if (stepNames.has(step.name)) {
      throw new ConfigValidationError(
        `Workflow "${name}" has duplicate step name "${step.name}"`
      );
    }
    stepNames.add(step.name);
  }

  return { steps };
}

/**
 * Validate and normalize the entire config
 */
function validateConfig(raw: RawCmConfig): CmConfig {
  // Validate version
  if (!raw.version || typeof raw.version !== "string") {
    throw new ConfigValidationError('Config must have a "version" property');
  }

  if (raw.version !== "1") {
    throw new ConfigValidationError(
      `Unsupported config version "${raw.version}". Supported versions: 1`
    );
  }

  // Validate workflows
  if (!raw.workflows || typeof raw.workflows !== "object") {
    throw new ConfigValidationError('Config must have a "workflows" object');
  }

  const workflowNames = Object.keys(raw.workflows);
  if (workflowNames.length === 0) {
    throw new ConfigValidationError(
      "Config must have at least one workflow defined"
    );
  }

  const workflows: Record<string, Workflow> = {};
  for (const [name, rawWorkflow] of Object.entries(raw.workflows)) {
    workflows[name] = validateWorkflow(rawWorkflow, name);
  }

  const config: CmConfig = {
    version: raw.version,
    workflows,
  };

  // Validate defaults if present
  if (raw.defaults) {
    config.defaults = {};

    if (raw.defaults.allowedTools !== undefined) {
      if (!Array.isArray(raw.defaults.allowedTools)) {
        throw new ConfigValidationError(
          "defaults.allowedTools must be an array"
        );
      }
      config.defaults.allowedTools = raw.defaults.allowedTools;
    }

    if (raw.defaults.timeout !== undefined) {
      if (
        typeof raw.defaults.timeout !== "number" ||
        raw.defaults.timeout <= 0
      ) {
        throw new ConfigValidationError(
          "defaults.timeout must be a positive number"
        );
      }
      config.defaults.timeout = raw.defaults.timeout;
    }
  }

  return config;
}

/**
 * Load and validate cm.yml from a file path
 */
export async function loadConfig(configPath: string): Promise<CmConfig> {
  const file = Bun.file(configPath);
  const content = await file.text();

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    throw new ConfigValidationError(
      `YAML parse error: ${(error as Error).message}`
    );
  }

  if (!raw || typeof raw !== "object") {
    throw new ConfigValidationError("Config must be a YAML object");
  }

  return validateConfig(raw as RawCmConfig);
}

/**
 * Find and load cm.yml from the current directory or parents
 */
export async function findAndLoadConfig(
  startPath: string = process.cwd()
): Promise<{ config: CmConfig; configPath: string }> {
  const configPath = await findConfigFile(startPath);
  const config = await loadConfig(configPath);
  return { config, configPath };
}

/**
 * Get a specific workflow from the config
 */
export function getWorkflow(config: CmConfig, name: string): Workflow {
  const workflow = config.workflows[name];
  if (!workflow) {
    const available = Object.keys(config.workflows).join(", ");
    throw new ConfigValidationError(
      `Workflow "${name}" not found. Available workflows: ${available}`
    );
  }
  return workflow;
}
