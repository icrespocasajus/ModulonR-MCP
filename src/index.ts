#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exec, spawn } from "child_process";
import * as fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as fsPromises from "fs/promises";
import express from "express";
import cors from "cors";
import { Request, Response } from "express";
import Docker from "dockerode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docker = new Docker();

const AGORA_CONTAINER_NAME = process.env.AGORA_CONTAINER_NAME || "agora_2025_v3";
const SHARED_WORKSPACE_PATH = "/home";

let scriptFileCounter = 0;

function createToolLogger(toolName: string) {
  const debugLogPath = join(__dirname, "..", `${toolName}_debug.log`);
  fs.writeFileSync(debugLogPath, `--- [${toolName}] DEBUG LOG STARTED ${new Date().toISOString()} ---\n`);
  return {
    log: (message: string) => {
      fs.appendFileSync(debugLogPath, `${new Date().toISOString()}: ${message}\n`);
      console.log(`[Tool:${toolName}] ${message}`);
    },
    error: (error: unknown) => {
      const errorMsg = error instanceof Error ? error.stack : String(error);
      fs.appendFileSync(debugLogPath, `${new Date().toISOString()}: ERROR: ${errorMsg}\n`);
      console.error(`[Tool:${toolName}] Error: ${errorMsg}`);
    },
    getLogPath: () => debugLogPath,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsPromises.access(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const createTempScript = async (content: string, filename: string): Promise<string> => {
  const baseDir = join(__dirname, "..");
  const tmpDir = join(baseDir, "tmp");
  const scriptsDir = join(tmpDir, "scripts");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir);
  const filePath = join(scriptsDir, filename);
  await fsPromises.writeFile(filePath, content);
  return filePath;
};

const copyToSharedWorkspace = async (sourcePath: string, targetFilename: string): Promise<string> => {
  const targetPath = join(SHARED_WORKSPACE_PATH, "Scripts", targetFilename);
  const scriptsDir = join(SHARED_WORKSPACE_PATH, "Scripts");
  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
  await fsPromises.copyFile(sourcePath, targetPath);
  return targetPath;
};

const buildRWrapperScript = (scriptPath: string, saveWorkspace: boolean, prefix: string = "ModulonR"): string => {
  if (!saveWorkspace) {
    return `source('${scriptPath}')`;
  }
  return `
source('${scriptPath}')
save.image(file='/home/Results/${prefix}_workspace.RData')
capture.output(sessionInfo(), file='/home/Results/${prefix}_session_info.txt')
capture.output(ls(), file='/home/Results/${prefix}_objects.txt')
`;
};

const executeRScript = async (
  scriptPath: string,
  args: string[] = [],
  logger?: { log: (message: string) => void; error: (error: unknown) => void },
  options: { saveWorkspace?: boolean; workspacePrefix?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const wrapperScript = buildRWrapperScript(scriptPath, options.saveWorkspace !== false, options.workspacePrefix);
    const wrapperScriptPath = `/tmp/wrapper_${timestamp}.R`;
    const command = `docker exec ${AGORA_CONTAINER_NAME} bash -c "cat > ${wrapperScriptPath} << 'EOF'
${wrapperScript}
EOF
Rscript ${wrapperScriptPath} ${args.join(" ")}"`;

    logger?.log(`Executing with workspace saving: ${command}`);
    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (error as NodeJS.ErrnoException).code || 1 : 0;
      logger?.log(`Script execution completed with exit code: ${exitCode}`);
      resolve({ stdout, stderr, exitCode: Number(exitCode) });
    });
  });
};

const streamRScript = async (
  scriptPath: string,
  args: string[] = [],
  logger?: { log: (message: string) => void; error: (error: unknown) => void },
  options: { saveWorkspace?: boolean; workspacePrefix?: string } = {}
): Promise<{ output: string; exitCode: number }> => {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const wrapperScript = buildRWrapperScript(scriptPath, options.saveWorkspace !== false, options.workspacePrefix);
    const wrapperScriptPath = `/tmp/wrapper_${timestamp}.R`;
    logger?.log("Streaming execution with workspace saving");

    const child = spawn(
      "docker",
      [
        "exec",
        AGORA_CONTAINER_NAME,
        "bash",
        "-c",
        `cat > ${wrapperScriptPath} << 'EOF'
${wrapperScript}
EOF
Rscript ${wrapperScriptPath} ${args.join(" ")}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let output = "";
    let errorOutput = "";

    child.stdout?.on("data", (data) => {
      const c = data.toString();
      output += c;
      logger?.log(`STDOUT: ${c}`);
    });

    child.stderr?.on("data", (data) => {
      const c = data.toString();
      errorOutput += c;
      logger?.log(`STDERR: ${c}`);
    });

    child.on("close", (code) => {
      const exitCode = code || 0;
      const fullOutput = output + (errorOutput ? `\n--- STDERR ---\n${errorOutput}` : "");
      logger?.log(`Stream script execution completed with exit code: ${exitCode}`);
      resolve({ output: fullOutput, exitCode });
    });

    child.on("error", (error) => {
      logger?.error(error);
      reject(error);
    });
  });
};

const ensureContainerRunning = async (
  logger?: { log: (message: string) => void; error: (error: unknown) => void }
): Promise<void> => {
  try {
    const container = docker.getContainer(AGORA_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      logger?.log(`Starting container: ${AGORA_CONTAINER_NAME}`);
      await container.start();
    }
  } catch (error) {
    logger?.error(`Error ensuring container is running: ${error}`);
    throw new Error(`Failed to ensure container is running: ${error}`);
  }
};

const listResultsFiles = async (): Promise<string[]> => {
  const outputDir = join(SHARED_WORKSPACE_PATH, "Results");
  if (!(await fileExists(outputDir))) return [];
  const files = await fsPromises.readdir(outputDir);
  return files.filter((f) => ![".DS_Store", "Thumbs.db", ".gitignore", ".gitkeep"].includes(f));
};

const isBinaryFile = (filename: string): boolean => {
  const binaryExtensions = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".svg", ".pdf", ".zip", ".tar", ".gz", ".rdata", ".rda", ".rds"];
  return binaryExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
};

const readResultFile = async (filename: string): Promise<string> => {
  const filePath = join(SHARED_WORKSPACE_PATH, "Results", filename);
  if (!(await fileExists(filePath))) throw new Error(`Results file does not exist: ${filePath}`);
  if (isBinaryFile(filename)) return `[Binary file: ${filename}]`;
  return fsPromises.readFile(filePath, "utf8");
};

const listInputFiles = async (): Promise<string[]> => {
  const dataDir = join(SHARED_WORKSPACE_PATH, "Data");
  if (!(await fileExists(dataDir))) return [];
  const files = await fsPromises.readdir(dataDir);
  return files.filter((f) => ![".DS_Store", "Thumbs.db", ".gitignore", ".gitkeep"].includes(f));
};

const readInputFile = async (filename: string): Promise<string> => {
  const filePath = join(SHARED_WORKSPACE_PATH, "Data", filename);
  if (!(await fileExists(filePath))) throw new Error(`Input file does not exist: ${filePath}`);
  if (isBinaryFile(filename)) return `[Binary file: ${filename}]`;
  return fsPromises.readFile(filePath, "utf8");
};

const resolveDataPath = (filename: string): string => join(SHARED_WORKSPACE_PATH, "Data", filename);
const resolveResultsPath = (filename: string): string => join(SHARED_WORKSPACE_PATH, "Results", filename);

const prepareScriptFromTemplate = async (templateName: string, scriptName: string): Promise<string> => {
  const templatePath = join(__dirname, "..", "src", "templates", templateName);
  if (!(await fileExists(templatePath))) throw new Error(`Template file not found at: ${templatePath}`);
  const content = await fsPromises.readFile(templatePath, "utf8");
  const scriptsDir = join(SHARED_WORKSPACE_PATH, "Scripts");
  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, scriptName);
  await fsPromises.writeFile(scriptPath, content);
  return scriptPath;
};

const prepareConfigFromTemplate = async (
  templateName: string,
  configName: string,
  overrides: Record<string, unknown>
): Promise<string> => {
  const templatePath = join(__dirname, "..", "src", "templates", templateName);
  if (!(await fileExists(templatePath))) throw new Error(`Config template file not found at: ${templatePath}`);
  const templateContent = await fsPromises.readFile(templatePath, "utf8");
  const configJson = { ...JSON.parse(templateContent), ...overrides };
  const scriptsDir = join(SHARED_WORKSPACE_PATH, "Scripts");
  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
  const configPath = join(scriptsDir, configName);
  await fsPromises.writeFile(configPath, JSON.stringify(configJson, null, 2));
  return configPath;
};

const formatExecutionResult = (executionResult: { output?: string; exitCode?: number; stdout?: string; stderr?: string }) => {
  if ("output" in executionResult) {
    return {
      stdout: executionResult.output,
      stderr: "",
      exitCode: executionResult.exitCode,
      success: executionResult.exitCode === 0,
    };
  }
  return {
    ...executionResult,
    success: executionResult.exitCode === 0,
  };
};

let mcpServerInstance: McpServer | null = null;

function createModulonRMcpServer() {
  return new McpServer({ name: "modulonr-mcp-server", version: "1.0.0", capabilities: { resources: {}, tools: {} } });
}

function getModulonRMcpServer() {
  if (!mcpServerInstance) {
    mcpServerInstance = createModulonRMcpServer();
    registerTools(mcpServerInstance);
  }
  return mcpServerInstance;
}

function registerTools(server: McpServer) {
  server.tool(
    "run_modulonr_script",
    "Execute ModulonR (R) code by creating a script file and running it in the Agora container",
    {
      code: z.string(),
      scriptName: z.string().optional(),
      streamOutput: z.boolean().optional().default(false),
    },
    async ({ code, scriptName, streamOutput }) => {
      const toolName = "run_modulonr_script";
      const { log, error } = createToolLogger(toolName);
      try {
        await ensureContainerRunning({ log, error });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const baseName = scriptName || `script_${timestamp}_${++scriptFileCounter}`;
        const scriptFilename = `${baseName}.R`;
        const tempScriptPath = await createTempScript(code, scriptFilename);
        const sharedScriptPath = await copyToSharedWorkspace(tempScriptPath, scriptFilename);
        const executionResult = streamOutput
          ? await streamRScript(sharedScriptPath, [], { log, error })
          : await executeRScript(sharedScriptPath, [], { log, error });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { summary: "ModulonR Script Execution Results", scriptName: scriptFilename, executionResult },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  server.tool(
    "run_modulonr_script_by_name",
    "Execute a ModulonR script that already exists in the Scripts directory",
    {
      scriptName: z.string(),
      streamOutput: z.boolean().optional().default(false),
    },
    async ({ scriptName, streamOutput }) => {
      const toolName = "run_modulonr_script_by_name";
      const { log, error } = createToolLogger(toolName);
      try {
        await ensureContainerRunning({ log, error });
        const normalizedScriptName = scriptName.endsWith(".R") ? scriptName : `${scriptName}.R`;
        const scriptPath = join(SHARED_WORKSPACE_PATH, "Scripts", normalizedScriptName);
        if (!(await fileExists(scriptPath))) throw new Error(`Script file does not exist: ${scriptPath}`);
        const executionResult = streamOutput
          ? await streamRScript(scriptPath, [], { log, error })
          : await executeRScript(scriptPath, [], { log, error });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { summary: "ModulonR Script Execution Results", scriptName: normalizedScriptName, executionResult },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  server.tool("list_modulonr_scripts", "List all ModulonR scripts in the Scripts directory", {}, async () => {
    const scriptsDir = join(SHARED_WORKSPACE_PATH, "Scripts");
    if (!(await fileExists(scriptsDir))) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { summary: "ModulonR Scripts Directory", scripts: [], message: "Scripts directory does not exist" },
              null,
              2
            ),
          },
        ],
      };
    }
    const files = await fsPromises.readdir(scriptsDir);
    const rScripts = files.filter((f) => f.toLowerCase().endsWith(".r"));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ summary: "ModulonR Scripts Directory", scripts: rScripts, totalCount: rScripts.length }, null, 2),
        },
      ],
    };
  });

  server.tool("list_output_files", "List all files in the Results directory", {}, async () => {
    const outputFiles = await listResultsFiles();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ summary: "Results Files Directory", files: outputFiles, totalCount: outputFiles.length }, null, 2),
        },
      ],
    };
  });

  server.tool("read_output_file", "Read the content of a specific Results file", { filename: z.string() }, async ({ filename }) => {
    const content = await readResultFile(filename);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ summary: "Results File Content", filename, content, size: content.length }, null, 2),
        },
      ],
    };
  });

  server.tool("modulonr_tutorial", "Get the ModulonR tutorial content", {}, async () => {
    const tutorialPath = join(__dirname, "..", "ModulonR_Tutorial.md");
    if (!(await fileExists(tutorialPath))) throw new Error(`ModulonR tutorial file not found at: ${tutorialPath}`);
    const tutorialContent = await fsPromises.readFile(tutorialPath, "utf8");
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              summary: "ModulonR Tutorial Content",
              title: "ModulonR Tutorial",
              content: tutorialContent,
              size: tutorialContent.length,
              source: "ModulonR_Tutorial.md",
            },
            null,
            2
          ),
        },
      ],
    };
  });

  server.tool("list_input_files", "List all files in the Data directory", {}, async () => {
    const inputFiles = await listInputFiles();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ summary: "Input Files Directory", files: inputFiles, totalCount: inputFiles.length }, null, 2),
        },
      ],
    };
  });

  server.tool("read_input_file", "Read the content of a specific Data file", { filename: z.string() }, async ({ filename }) => {
    const content = await readInputFile(filename);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ summary: "Input File Content", filename, content, size: content.length }, null, 2),
        },
      ],
    };
  });

  server.tool(
    "run_modulon_ident",
    "Step 1: Identify modulons by hierarchical clustering of TF activity and OPLS-DA discriminant analysis (ModulonIdent)",
    {
      activity_matrix_file: z
        .string()
        .optional()
        .describe("Name of file in workspace/Data with regulon activity matrix (.Rds or tab-separated .txt)."),
      annotation_file: z
        .string()
        .optional()
        .describe("Name of file in workspace/Data with cell state annotation (.Rds vector or single-column .txt)."),
      background_classes: z.array(z.string()).optional().describe("Background classes for discriminant analysis."),
      query_classes: z.array(z.string()).optional().describe("Query classes for discriminant analysis."),
      k_range: z
        .array(z.number())
        .optional()
        .describe(
          "Clustering resolutions to explore. Two values [min, max] expand to every integer from min through max (default: [2, 10] → k=2..10). More than two values are used as an explicit list."
        ),
      streamOutput: z.boolean().optional().default(false),
    },
    async ({ activity_matrix_file, annotation_file, background_classes, query_classes, k_range, streamOutput }) => {
      const toolName = "run_modulon_ident";
      const { log, error } = createToolLogger(toolName);
      try {
        await ensureContainerRunning({ log, error });

        const matrixFile = activity_matrix_file || "regulon_activity_matrix.Rds";
        const annotationFile = annotation_file || "annotation.Rds";
        const matrixPath = resolveDataPath(matrixFile);
        const annotationPath = resolveDataPath(annotationFile);

        if (!(await fileExists(matrixPath))) throw new Error(`Activity matrix file not found: ${matrixPath}`);
        if (!(await fileExists(annotationPath))) throw new Error(`Annotation file not found: ${annotationPath}`);

        const scriptPath = await prepareScriptFromTemplate("modulon_ident_template.R", "modulon_ident.R");
        const configPath = await prepareConfigFromTemplate("modulon_ident_config_template.json", "modulon_ident_config.json", {
          activity_matrix_file: matrixPath,
          annotation_file: annotationPath,
          background_classes: background_classes && background_classes.length > 0 ? background_classes : null,
          query_classes: query_classes && query_classes.length > 0 ? query_classes : null,
          k_range: k_range && k_range.length > 0 ? k_range : [2, 10],
        });

        log(`Created modulon_ident.R at ${scriptPath}`);
        log(`Created config at ${configPath}`);

        const identRunOptions = { workspacePrefix: "modulon_ident" };
        const executionResult = streamOutput
          ? await streamRScript(scriptPath, [configPath], { log, error }, identRunOptions)
          : await executeRScript(scriptPath, [configPath], { log, error }, identRunOptions);

        const identOutputFiles = [
          "modulon_ident_modulons.Rds",
          "modulon_ident_gds.csv",
          "modulon_ident_summary.csv",
          "modulon_ident_modulon_members.csv",
          "modulon_ident_gds_barplot.pdf",
          "modulon_ident_modulons_heatmap.pdf",
          "modulon_ident_workspace.RData",
          "modulon_ident_session_info.txt",
          "modulon_ident_objects.txt",
        ];
        const outputFiles = (await listResultsFiles()).filter((f) => identOutputFiles.includes(f));
        let gdsContent: string | null = null;
        let membersContent: string | null = null;
        if (outputFiles.includes("modulon_ident_gds.csv")) gdsContent = await readResultFile("modulon_ident_gds.csv");
        if (outputFiles.includes("modulon_ident_modulon_members.csv")) membersContent = await readResultFile("modulon_ident_modulon_members.csv");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: "ModulonR ModulonIdent completed",
                  status: "success",
                  files_created: { script: scriptPath, config: configPath },
                  execution_results: formatExecutionResult(executionResult),
                  generated_output_files: outputFiles,
                  gds_data: gdsContent ? { filename: "modulon_ident_gds.csv", content: gdsContent } : null,
                  modulon_members: membersContent ? { filename: "modulon_ident_modulon_members.csv", content: membersContent } : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  server.tool(
    "run_modulon_select",
    "Step 2: Select the top discriminant modulon for a target cell state (ModulonSelect)",
    {
      activity_matrix_file: z.string().optional().describe("Regulon activity matrix file in workspace/Data."),
      modulons_file: z
        .string()
        .optional()
        .describe("Modulons RDS from run_modulon_ident. Defaults to Results/modulon_ident_modulons.Rds."),
      annotation_file: z.string().optional().describe("Cell state annotation file in workspace/Data."),
      background_classes: z.array(z.string()).optional(),
      target_state: z.array(z.string()).describe("Target cell state(s) for modulon selection."),
      generate_plots: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), save State Modulon Discriminancy barplot PDF(s) to Results/."),
      streamOutput: z.boolean().optional().default(false),
    },
    async ({ activity_matrix_file, modulons_file, annotation_file, background_classes, target_state, generate_plots, streamOutput }) => {
      const toolName = "run_modulon_select";
      const { log, error } = createToolLogger(toolName);
      try {
        await ensureContainerRunning({ log, error });

        const matrixFile = activity_matrix_file || "regulon_activity_matrix.Rds";
        const modulonsFile = modulons_file || "modulon_ident_modulons.Rds";
        const annotationFile = annotation_file || "annotation.Rds";

        const matrixPath = resolveDataPath(matrixFile);
        const modulonsPath = modulons_file ? resolveDataPath(modulons_file) : resolveResultsPath(modulonsFile);
        const annotationPath = resolveDataPath(annotationFile);

        if (!(await fileExists(matrixPath))) throw new Error(`Activity matrix file not found: ${matrixPath}`);
        if (!(await fileExists(modulonsPath))) throw new Error(`Modulons file not found: ${modulonsPath}. Run run_modulon_ident first.`);
        if (!(await fileExists(annotationPath))) throw new Error(`Annotation file not found: ${annotationPath}`);

        const scriptPath = await prepareScriptFromTemplate("modulon_select_template.R", "modulon_select.R");
        const configPath = await prepareConfigFromTemplate("modulon_select_config_template.json", "modulon_select_config.json", {
          activity_matrix_file: matrixPath,
          modulons_file: modulonsPath,
          annotation_file: annotationPath,
          background_classes: background_classes && background_classes.length > 0 ? background_classes : null,
          target_state,
          generate_plots,
        });

        const selectRunOptions = { workspacePrefix: "modulon_select" };
        const executionResult = streamOutput
          ? await streamRScript(scriptPath, [configPath], { log, error }, selectRunOptions)
          : await executeRScript(scriptPath, [configPath], { log, error }, selectRunOptions);

        const selectOutputFiles = [
          "modulon_select_results.Rds",
          "modulon_select_modulons.csv",
          "modulon_select_modulon_da.csv",
          "modulon_select_workspace.RData",
          "modulon_select_session_info.txt",
          "modulon_select_objects.txt",
        ];
        const outputFiles = (await listResultsFiles()).filter(
          (f) =>
            selectOutputFiles.includes(f) ||
            (f.startsWith("modulon_select_modulon_da_barplot") && f.endsWith(".pdf"))
        );
        let selectedContent: string | null = null;
        if (outputFiles.includes("modulon_select_modulons.csv")) {
          selectedContent = await readResultFile("modulon_select_modulons.csv");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: "ModulonR ModulonSelect completed",
                  status: "success",
                  parameters: { target_state, generate_plots },
                  execution_results: formatExecutionResult(executionResult),
                  generated_output_files: outputFiles,
                  selected_modulons: selectedContent
                    ? { filename: "modulon_select_modulons.csv", content: selectedContent }
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );

  server.tool(
    "run_modulon_pert",
    "Step 3: Rank TF knockout combinations by expected impact on a target modulon and cell state (ModulonPert)",
    {
      regulons_file: z.string().optional().describe("Regulons RDS file in workspace/Data."),
      modulons_file: z.string().optional().describe("Modulons RDS from run_modulon_ident. Defaults to Results/modulon_ident_modulons.Rds."),
      expression_matrix_file: z.string().optional().describe("Gene expression matrix file in workspace/Data."),
      annotation_file: z.string().optional().describe("Cell state annotation file in workspace/Data."),
      weights_file: z.string().optional().describe("Optional TF-target GRN weights RDS in workspace/Data."),
      background_classes: z.array(z.string()).optional(),
      target_state: z.string().describe("Target cell state to disrupt."),
      target_modulon: z.string().describe("Target modulon ID (from ModulonSelect results)."),
      comb_size: z.number().optional().default(1).describe("Number of TFs per knockout combination."),
      generate_plots: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), save a horizontal barplot of the top TF KO combinations to Results/."),
      top_n: z
        .number()
        .optional()
        .default(30)
        .describe("Number of top-ranked combinations to include in the barplot (default: 30)."),
      streamOutput: z.boolean().optional().default(false),
    },
    async ({
      regulons_file,
      modulons_file,
      expression_matrix_file,
      annotation_file,
      weights_file,
      background_classes,
      target_state,
      target_modulon,
      comb_size,
      generate_plots,
      top_n,
      streamOutput,
    }) => {
      const toolName = "run_modulon_pert";
      const { log, error } = createToolLogger(toolName);
      try {
        await ensureContainerRunning({ log, error });

        const regulonsFile = regulons_file || "regulons.Rds";
        const modulonsFile = modulons_file || "modulon_ident_modulons.Rds";
        const expressionFile = expression_matrix_file || "gene_expression_matrix.Rds";
        const annotationFile = annotation_file || "annotation.Rds";

        const regulonsPath = resolveDataPath(regulonsFile);
        const modulonsPath = modulons_file ? resolveDataPath(modulons_file) : resolveResultsPath(modulonsFile);
        const expressionPath = resolveDataPath(expressionFile);
        const annotationPath = resolveDataPath(annotationFile);

        if (!(await fileExists(regulonsPath))) throw new Error(`Regulons file not found: ${regulonsPath}`);
        if (!(await fileExists(modulonsPath))) throw new Error(`Modulons file not found: ${modulonsPath}`);
        if (!(await fileExists(expressionPath))) throw new Error(`Expression matrix file not found: ${expressionPath}`);
        if (!(await fileExists(annotationPath))) throw new Error(`Annotation file not found: ${annotationPath}`);

        let weightsPath: string | null = null;
        if (weights_file) {
          weightsPath = resolveDataPath(weights_file);
          if (!(await fileExists(weightsPath))) throw new Error(`Weights file not found: ${weightsPath}`);
        }

        const scriptPath = await prepareScriptFromTemplate("modulon_pert_template.R", "modulon_pert.R");
        const configPath = await prepareConfigFromTemplate("modulon_pert_config_template.json", "modulon_pert_config.json", {
          regulons_file: regulonsPath,
          modulons_file: modulonsPath,
          expression_matrix_file: expressionPath,
          annotation_file: annotationPath,
          weights_file: weightsPath,
          background_classes: background_classes && background_classes.length > 0 ? background_classes : null,
          target_state,
          target_modulon,
          comb_size: comb_size ?? 1,
          generate_plots,
          top_n: top_n ?? 30,
        });

        const pertRunOptions = { workspacePrefix: "modulon_pert" };
        const executionResult = streamOutput
          ? await streamRScript(scriptPath, [configPath], { log, error }, pertRunOptions)
          : await executeRScript(scriptPath, [configPath], { log, error }, pertRunOptions);

        const pertOutputFiles = [
          "modulon_pert_results.Rds",
          "modulon_pert_combinations.csv",
          "modulon_pert_bipartite_graph.csv",
          "modulon_pert_combinations_barplot.pdf",
          "modulon_pert_workspace.RData",
          "modulon_pert_session_info.txt",
          "modulon_pert_objects.txt",
        ];
        const outputFiles = (await listResultsFiles()).filter(
          (f) => pertOutputFiles.includes(f) || (f.startsWith("modulon_pert_combinations_barplot") && f.endsWith(".pdf"))
        );
        let combinationsContent: string | null = null;
        if (outputFiles.includes("modulon_pert_combinations.csv")) {
          combinationsContent = await readResultFile("modulon_pert_combinations.csv");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: "ModulonR ModulonPert completed",
                  status: "success",
                  parameters: {
                    target_state,
                    target_modulon,
                    comb_size: comb_size ?? 1,
                    generate_plots,
                    top_n: top_n ?? 30,
                  },
                  execution_results: formatExecutionResult(executionResult),
                  generated_output_files: outputFiles,
                  top_combinations: combinationsContent
                    ? { filename: "modulon_pert_combinations.csv", content: combinationsContent }
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }
  );
}

// Express + Streamable HTTP
const app = express();
app.use(cors());
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

const mcpPostHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      const server = getModulonRMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
    console.error("[Server] Error handling MCP POST request:", error);
  }
};

const mcpGetHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

const mcpDeleteHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.post("/mcp", mcpPostHandler);
app.get("/mcp", mcpGetHandler);
app.delete("/mcp", mcpDeleteHandler);

app.get("/health", (_req: Request, res: Response) => {
  res.send({ status: "ok" });
});

app.get("/", (_req: Request, res: Response) => {
  res.send({
    name: "ModulonR MCP Server",
    version: "1.0.0",
    description: "ModulonR code execution server using Model Context Protocol (Streamable HTTP)",
    endpoints: {
      "/": "This information",
      "/health": "Health check",
      "/mcp": "Streamable HTTP MCP endpoint (POST initialize, GET SSE stream, DELETE terminate)",
    },
  });
});

const PORT = process.env.PORT || 2030;
const httpServer = app.listen(PORT, () => {
  console.log(`[Server] ModulonR MCP Server started. Listening on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`[Server] Error closing transport for session ${sessionId}:`, error);
    }
  }
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", async () => {
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`[Server] Error closing transport for session ${sessionId}:`, error);
    }
  }
  httpServer.close(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Server] Unhandled Promise Rejection at:", promise, "reason:", reason);
});
