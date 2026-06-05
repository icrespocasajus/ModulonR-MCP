# ModulonR ModulonPert Template

suppressPackageStartupMessages(library(jsonlite))
# matrixStats shim for agora_2025_v3: 1.5.0 rejects useNames=NA from ModulonR deps
suppressPackageStartupMessages(library(matrixStats))
ms_ns <- asNamespace("matrixStats")
unlockBinding("colRanks", ms_ns)
.colRanks_orig <- get("colRanks", ms_ns)
assign("colRanks", function(x, ..., useNames = NA) {
  if (length(useNames) == 0L || is.na(useNames)) useNames <- FALSE
  .colRanks_orig(x, ..., useNames = useNames)
}, ms_ns)
lockBinding("colRanks", ms_ns)
suppressPackageStartupMessages(library(ModulonR))

.load_matrix <- function(path) {
  if (grepl("\\.rds$", path, ignore.case = TRUE)) {
    obj <- readRDS(path)
    if (is.data.frame(obj)) return(as.matrix(obj))
    return(obj)
  }
  as.matrix(read.table(path, header = TRUE, sep = "\t", check.names = FALSE, row.names = 1))
}

.load_annotation <- function(path) {
  if (grepl("\\.rds$", path, ignore.case = TRUE)) {
    return(as.vector(readRDS(path)))
  }
  ann <- read.table(path, header = FALSE, stringsAsFactors = FALSE, sep = "\t")
  as.vector(ann[, 1])
}

.format_combination_label <- function(row, element_cols) {
  elements <- as.character(unlist(row[element_cols]))
  elements <- elements[!is.na(elements) & elements != ""]
  paste(elements, collapse = " + ")
}

.plot_top_combinations_barplot <- function(
  combinations,
  target_state,
  target_modulon,
  comb_size,
  top_n = 30L,
  out_base
) {
  suppressPackageStartupMessages(library(ggplot2))

  element_cols <- grep("^Element_", names(combinations), value = TRUE)
  if (length(element_cols) == 0) {
    stop("No Element_* columns found in combinations.")
  }

  ordered <- combinations[order(combinations$WCS, decreasing = TRUE), , drop = FALSE]
  top_n <- min(as.integer(top_n), nrow(ordered))
  if (top_n < 1) {
    stop("No combinations available to plot.")
  }

  top <- ordered[seq_len(top_n), , drop = FALSE]
  top$label <- apply(top[, element_cols, drop = FALSE], 1, .format_combination_label, element_cols = element_cols)
  fill_cols <- grDevices::hcl.colors(2, palette = "Blues")

  p <- ggplot2::ggplot(top, ggplot2::aes(x = WCS, y = reorder(label, WCS))) +
    ggplot2::geom_col(ggplot2::aes(fill = WCS), width = 0.8, color = "black", linewidth = 0.2) +
    ggplot2::scale_fill_gradient(low = fill_cols[1], high = fill_cols[2]) +
    ggplot2::coord_cartesian(expand = FALSE) +
    ggplot2::theme_light() +
    ggplot2::theme(
      legend.position = "none",
      axis.text.y = ggplot2::element_text(size = 8)
    ) +
    ggplot2::labs(
      title = paste0(
        "Top ", top_n, " TF KO combinations (", target_state,
        ", modulon ", target_modulon, ", n = ", comb_size, ")"
      ),
      x = "Weighted Coverage Score (WCS)",
      y = NULL
    )

  plot_height <- max(5, 0.25 * top_n + 1.5)
  ggplot2::ggsave(paste0(out_base, ".pdf"), plot = p, width = 9, height = plot_height)
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript modulon_pert_template.R <config_file>")

config_file <- args[1]
if (!file.exists(config_file)) stop(paste("Configuration file not found:", config_file))

config <- fromJSON(config_file)
required <- c("regulons_file", "modulons_file", "expression_matrix_file", "annotation_file",
              "target_state", "target_modulon")
for (field in required) {
  if (is.null(config[[field]])) stop(paste("'", field, "' must be provided.", sep = ""))
}

for (field in c("regulons_file", "modulons_file", "expression_matrix_file", "annotation_file")) {
  if (!file.exists(config[[field]])) stop(paste("File not found:", config[[field]]))
}

Regulons <- readRDS(config$regulons_file)
regulons <- Regulons  # ModulonPert references lowercase 'regulons' internally
Modulons <- readRDS(config$modulons_file)
ExpMat <- .load_matrix(config$expression_matrix_file)
annotation <- .load_annotation(config$annotation_file)

if (length(annotation) != ncol(ExpMat)) {
  stop(paste("Annotation length (", length(annotation), ") does not match expression matrix columns (", ncol(ExpMat), ")", sep = ""))
}

Weights <- NULL
if (!is.null(config$weights_file) && !is.na(config$weights_file) && file.exists(config$weights_file)) {
  Weights <- readRDS(config$weights_file)
}

background_classes <- config$background_classes
target_state <- config$target_state
target_modulon <- as.character(config$target_modulon)
comb_size <- if (is.null(config$comb_size)) 1L else as.integer(config$comb_size)

message("Running ModulonPert...")
results <- ModulonPert(
  Regulons = Regulons,
  Modulons = Modulons,
  ExpMat = ExpMat,
  annotation = annotation,
  BackgroundClasses = background_classes,
  TargetState = target_state,
  TargetModulon = target_modulon,
  CombSize = comb_size,
  Weights = Weights
)

if (!dir.exists('/home/Results')) dir.create('/home/Results', recursive = TRUE)

saveRDS(results, file = '/home/Results/modulon_pert_results.Rds')

if (!is.null(results$Combinations)) {
  write.csv(results$Combinations, file = '/home/Results/modulon_pert_combinations.csv', row.names = TRUE)
}

if (!is.null(results$Bipartite_Graph)) {
  write.csv(results$Bipartite_Graph, file = '/home/Results/modulon_pert_bipartite_graph.csv', row.names = FALSE)
}

generate_plots <- if (is.null(config$generate_plots)) TRUE else isTRUE(config$generate_plots)
top_n <- if (is.null(config$top_n)) 30L else as.integer(config$top_n)
if (generate_plots && !is.null(results$Combinations)) {
  message(paste("Generating top", top_n, "combinations barplot..."))
  .plot_top_combinations_barplot(
    combinations = results$Combinations,
    target_state = target_state,
    target_modulon = target_modulon,
    comb_size = comb_size,
    top_n = top_n,
    out_base = "/home/Results/modulon_pert_combinations_barplot"
  )
  message("Barplot saved to /home/Results/modulon_pert_combinations_barplot.pdf")
}

message("ModulonPert completed.")
if (!is.null(results$Combinations)) {
  message("Top 5 TF KO combinations by WCS:")
  print(head(results$Combinations[order(results$Combinations$WCS, decreasing = TRUE), ], 5))
}
