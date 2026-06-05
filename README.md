# ModulonR MCP Server Container

This container exposes ModulonR tools over MCP (Model Context Protocol) with **Streamable HTTP** transport. It executes R code inside the `agora_2025_v3` Docker container to identify modulons, select state-discriminant modulons, and rank TF knockout combinations.

This module is part of the umbrella repository `Agora_2025_MCP_Umbrella`.

## Overview

[ModulonR](https://github.com/icrespocasajus/ModulonR) identifies clusters of transcription factors with coordinated activity across cell states and predicts TF combinations essential for cell state commitment. This MCP server allows AI assistants and MCP clients to:

- Run modulon identification from regulon activity matrices
- Select the top discriminant modulon for a target cell state
- Rank TF knockout combinations by weighted coverage score
- Execute custom ModulonR R scripts
- List and read input/output files in the shared workspace

## Prerequisites

- **Docker** and **Docker Compose** installed
- The `agora_2025_v3` image available locally (ModulonR is pre-installed)

### Pulling from GitHub Container Registry (ghcr.io)

```bash
docker pull ghcr.io/icrespocasajus/agora_2025_v3:latest
docker tag ghcr.io/icrespocasajus/agora_2025_v3:latest bioconductor/agora_2025_v3:latest
```

## How to Run

### Option 1: Individual deployment (ModulonR only)

From the project root:

```bash
cd modulonr-mcp-server-container
docker compose up -d
```

### Option 2: Unified deployment (all MCP servers)

From the project root:

```bash
docker compose up -d
```

ModulonR will be available on port **2030**.

### Rebuild after code changes

```bash
docker compose up -d --build
```

## Endpoints

| Endpoint | URL | Description |
|----------|-----|-------------|
| MCP | `http://localhost:2030/mcp` | Streamable HTTP MCP transport |
| Health | `http://localhost:2030/health` | Health check |

## MCP Client Configuration

Configure your MCP client to connect using Streamable HTTP:

```json
{
  "mcpServers": {
    "modulonr": {
      "url": "http://localhost:2030/mcp"
    }
  }
}
```

## Workspace Structure

The server uses a shared workspace mounted at `/home` in the container:

| Host path | Container path | Purpose |
|-----------|----------------|---------|
| `./workspace/Data/` | `/home/Data/` | Input data (activity matrices, annotations, regulons, GRN weights) |
| `./workspace/Scripts/` | `/home/Scripts/` | R scripts |
| `./workspace/Results/` | `/home/Results/` | Output files (modulons, GDS, perturbation rankings) |

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `run_modulon_ident` | Step 1: Identify modulons via hierarchical clustering and OPLS-DA |
| `run_modulon_select` | Step 2: Select top discriminant modulon for a target cell state |
| `run_modulon_pert` | Step 3: Rank TF KO combinations by weighted coverage score |
| `run_modulonr_script` | Execute arbitrary ModulonR R code |
| `run_modulonr_script_by_name` | Execute a script from the Scripts directory |
| `list_modulonr_scripts` | List R scripts in the Scripts directory |
| `list_input_files` | List files in the Data directory |
| `read_input_file` | Read a Data file |
| `list_output_files` | List files in the Results directory |
| `read_output_file` | Read a Results file |
| `modulonr_tutorial` | Get the ModulonR tutorial content |

## Implementation

- Programming language: TypeScript (Node.js runtime)
- Transport: MCP over **Streamable HTTP** (not SSE)

## Example Workflow

1. Place regulon activity matrix, annotation, regulons, expression matrix, and GRN weights in `workspace/Data/`.
2. Ask your AI MCP client:

   > "Use ModulonR-mcp to identify modulons from the regulon activity matrix in workspace/Data/, then select the top modulon for CD8_Tex and rank 3-TF knockout combinations."

## Port Mappings

| Service | Port |
|---------|------|
| ModulonR MCP Server | 2030 |
| Agora container (when run individually) | 8004 |

## Troubleshooting

### Port conflicts

```bash
lsof -i :2030
```

### Container not found

```bash
docker ps | grep agora_2025_v3
```

### View logs

```bash
docker compose logs -f
```

## Further Documentation

- **ModulonR tutorial:** `ModulonR_Tutorial.md`
- **ModulonR GitHub:** https://github.com/icrespocasajus/ModulonR
