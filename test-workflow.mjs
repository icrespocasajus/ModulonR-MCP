#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = "http://localhost:2030/mcp";

function summarize(result) {
  return result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
}

function ok(result, output) {
  return result.isError !== true && !/"exitCode"\s*:\s*[1-9]/.test(output) && !/^Error in run_/.test(output);
}

async function call(client, name, args = {}) {
  const t0 = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const output = summarize(result);
  return { name, ok: ok(result, output), ms: Date.now() - t0, output };
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "workflow-tester", version: "1.0.0" });
  await client.connect(transport);

  const tests = [
    ["run_modulon_ident", { activity_matrix_file: "mcp_test_activity.txt", annotation_file: "mcp_test_annotation.txt", k_range: [2, 4] }],
    ["run_modulon_select", { activity_matrix_file: "mcp_test_activity.txt", annotation_file: "mcp_test_annotation.txt", target_state: ["StateA"] }],
    ["run_modulon_pert", {
      regulons_file: "mcp_test_regulons.Rds",
      expression_matrix_file: "mcp_test_expression.Rds",
      weights_file: "mcp_test_weights.Rds",
      annotation_file: "mcp_test_annotation.txt",
      target_state: "StateA",
      target_modulon: "1",
      comb_size: 2,
    }],
    ["read_output_file", { filename: "modulon_ident_gds.csv" }],
  ];

  for (const [name, args] of tests) {
    const r = await call(client, name, args);
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${name} (${r.ms}ms)`);
    console.log(r.output.slice(0, 2000));
    console.log();
  }

  await transport.close();
}

main();
