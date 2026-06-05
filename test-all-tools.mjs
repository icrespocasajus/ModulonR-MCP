#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL || "http://localhost:2030/mcp";

function summarize(result) {
  const text = result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
  return text.length > 1500 ? text.slice(0, 1500) + "\n... [truncated]" : text;
}

function looksLikeToolError(output) {
  return /Error in run_|"success"\s*:\s*false|"exitCode"\s*:\s*[1-9]/.test(output || "");
}

async function callTool(client, name, args = {}) {
  const started = Date.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const ms = Date.now() - started;
    const output = summarize(result);
    const ok = result.isError !== true && !looksLikeToolError(output);
    return { name, ok, ms, output, error: ok ? null : output };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, output: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const SETUP_SCRIPT = `
library(ModulonR)
set.seed(42)
n <- 30
tfs <- paste0("TF", 1:8)
states <- rep(c("StateA", "StateB"), each = 15)
mat <- matrix(abs(rnorm(length(tfs) * n)), nrow = length(tfs), dimnames = list(tfs, paste0("cell", 1:n)))
write.table(cbind(TF = rownames(mat), mat), file = "/home/Data/mcp_test_activity.txt", sep = "\\t", quote = FALSE, row.names = FALSE)
write.table(states, file = "/home/Data/mcp_test_annotation.txt", sep = "\\t", quote = FALSE, row.names = FALSE, col.names = FALSE)
regulons <- as.list(setNames(lapply(tfs, function(tf) paste0("G", sample(1:20, 5, replace = TRUE))), tfs))
saveRDS(regulons, "/home/Data/mcp_test_regulons.Rds")
genes <- unique(unlist(regulons))
exp <- matrix(abs(rnorm(length(genes) * n)), nrow = length(genes), dimnames = list(genes, paste0("cell", 1:n)))
saveRDS(exp, "/home/Data/mcp_test_expression.Rds")
weights <- data.frame(TF = rep(tfs, each = 3), Target = sample(genes, length(tfs) * 3, replace = TRUE), weight = runif(length(tfs) * 3))
saveRDS(weights, "/home/Data/mcp_test_weights.Rds")
cat("Setup complete\\n")
`;

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "modulonr-tool-tester", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  console.log(`Connected to ${MCP_URL}`);
  console.log(`Tools: ${listed.tools.map((t) => t.name).join(", ")}\n`);

  const results = [];

  results.push(await callTool(client, "modulonr_tutorial"));
  results.push(await callTool(client, "list_input_files"));
  results.push(await callTool(client, "read_input_file", {
    filename: "MODULON_TCR_IL2_AUC_table_Human_annotation_100x.txt",
  }));
  results.push(await callTool(client, "list_modulonr_scripts"));
  results.push(await callTool(client, "list_output_files"));

  results.push(
    await callTool(client, "run_modulonr_script", {
      code: 'library(ModulonR)\ncat("ModulonR", as.character(packageVersion("ModulonR")), "\\n")',
      scriptName: "mcp_smoke_test",
    })
  );

  results.push(await callTool(client, "run_modulonr_script_by_name", { scriptName: "mcp_smoke_test" }));

  results.push(
    await callTool(client, "run_modulonr_script", {
      code: SETUP_SCRIPT,
      scriptName: "mcp_setup_test_data",
    })
  );

  results.push(
    await callTool(client, "run_modulon_ident", {
      activity_matrix_file: "mcp_test_activity.txt",
      annotation_file: "mcp_test_annotation.txt",
      k_range: [2, 4],
    })
  );

  results.push(
    await callTool(client, "run_modulon_select", {
      activity_matrix_file: "mcp_test_activity.txt",
      annotation_file: "mcp_test_annotation.txt",
      target_state: ["StateA"],
    })
  );

  results.push(
    await callTool(client, "run_modulon_pert", {
      regulons_file: "mcp_test_regulons.Rds",
      expression_matrix_file: "mcp_test_expression.Rds",
      weights_file: "mcp_test_weights.Rds",
      annotation_file: "mcp_test_annotation.txt",
      target_state: "StateA",
      target_modulon: "1",
      comb_size: 2,
    })
  );

  results.push(await callTool(client, "list_output_files"));

  const listOut = results.find((r) => r.name === "list_output_files" && r.ok);
  if (listOut) {
    try {
      const parsed = JSON.parse(listOut.output);
      const file = (parsed.files || []).find((f) => f.includes("modulon_ident_gds") && f.endsWith(".csv"));
      if (file) results.push(await callTool(client, "read_output_file", { filename: file }));
    } catch {
      /* ignore */
    }
  }

  await transport.close();

  console.log("=".repeat(72));
  console.log("ModulonR MCP tool test results");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(`\n[${r.ok ? "PASS" : "FAIL"}] ${r.name} (${r.ms}ms)`);
    console.log(r.ok ? r.output : `Error: ${r.error}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Summary: ${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
