# ModulonR ModulonIdent Template

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

.modulon_label <- function(name) {
  parts <- strsplit(name, ".", fixed = TRUE)[[1]]
  parts[length(parts)]
}

.expand_k_range <- function(k_range) {
  k_range <- as.integer(k_range)
  if (length(k_range) == 0) {
    return(2:30)
  }
  if (length(k_range) == 2) {
    lo <- k_range[1]
    hi <- k_range[2]
    if (lo > hi) {
      stop(paste("k_range lower bound (", lo, ") must be <= upper bound (", hi, ")", sep = ""))
    }
    return(seq(lo, hi))
  }
  k_range
}

.order_states <- function(states, custom = NULL, annotation = NULL) {
  if (!is.null(custom) && length(custom) > 0) {
    custom <- as.character(custom)
    return(c(intersect(custom, states), setdiff(states, custom)))
  }
  if (!is.null(annotation)) {
    appearance <- unique(as.character(annotation))
    return(c(intersect(appearance, states), setdiff(states, appearance)))
  }
  sort(states)
}

.discrete_colors <- function(labels, palette = "Dynamic") {
  labels <- as.character(labels)
  if (length(labels) == 0) {
    return(setNames(character(0), character(0)))
  }
  cols <- grDevices::hcl.colors(length(labels), palette = palette)
  stats::setNames(cols, labels)
}

.plot_gds_barplot <- function(gds, best_k, out_base) {
  suppressPackageStartupMessages(library(ggplot2))
  y_min <- max(0, min(gds$avg_max_weight, na.rm = TRUE) - 0.05)
  y_max <- 1.25
  label_y <- 1.1
  x_breaks <- sort(unique(gds$NumCluster))

  p <- ggplot2::ggplot(
    gds,
    ggplot2::aes(x = NumCluster, y = avg_max_weight, fill = avg_max_weight)
  ) +
    ggplot2::coord_cartesian(ylim = c(y_min, y_max)) +
    ggplot2::geom_col(color = "blue") +
    ggplot2::scale_x_continuous(breaks = x_breaks) +
    ggplot2::theme_light() +
    ggplot2::theme(legend.position = "none") +
    ggplot2::ggtitle("Cell State Discriminancy") +
    ggplot2::xlab("Number of clusters (k)") +
    ggplot2::ylab("Global Discriminant Score (GDS)") +
    ggplot2::geom_vline(
      xintercept = best_k, linetype = "dashed", color = "red", linewidth = 1
    ) +
    ggplot2::annotate(
      "text",
      x = best_k,
      y = label_y,
      label = paste0("Optimal k = ", best_k),
      color = "red",
      vjust = 0.5
    )

  ggplot2::ggsave(paste0(out_base, ".pdf"), plot = p, width = 8, height = 5)
}

.plot_modulons_heatmap <- function(data, annotation, modulons, best_k, out_base, state_order = NULL) {
  suppressPackageStartupMessages(library(pheatmap))

  exp_mat_aggregated <- stats::aggregate(t(data), by = list(annotation), FUN = mean)
  rownames(exp_mat_aggregated) <- exp_mat_aggregated[, 1]
  exp_mat_aggregated <- exp_mat_aggregated[, -1, drop = FALSE]
  exp_mat_aggregated <- t(exp_mat_aggregated)

  states <- .order_states(colnames(exp_mat_aggregated), state_order, annotation)
  phm_input <- exp_mat_aggregated[, states, drop = FALSE]

  modulons_labeled <- modulons
  names(modulons_labeled) <- vapply(names(modulons_labeled), .modulon_label, character(1))

  modulon_annotation <- do.call(rbind, lapply(names(modulons_labeled), function(name) {
    data.frame(Modulon = name, TF = modulons_labeled[[name]], stringsAsFactors = FALSE)
  }))
  rownames(modulon_annotation) <- modulon_annotation$TF
  modulon_annotation$TF <- NULL
  modulon_annotation <- modulon_annotation[rownames(phm_input), , drop = FALSE]

  annotation_col <- data.frame(State = colnames(phm_input), row.names = colnames(phm_input))
  modulon_labels <- sort(unique(modulon_annotation$Modulon))

  ann_colors <- list(
    State = .discrete_colors(states, palette = "Dynamic"),
    Modulon = .discrete_colors(modulon_labels, palette = "Set2")
  )

  draw_heatmap <- function() {
    pheatmap::pheatmap(
      phm_input,
      main = "Regulon activity",
      cluster_rows = TRUE,
      cluster_cols = FALSE,
      fontsize_row = 0.5,
      annotation_col = annotation_col,
      annotation_colors = ann_colors,
      annotation_row = modulon_annotation,
      annotation_names_row = TRUE,
      annotation_names_col = TRUE,
      cutree_rows = best_k,
      show_rownames = FALSE,
      cellwidth = 12,
      cellheight = 0.5,
      fontsize_col = 12,
      scale = "row"
    )
  }

  grDevices::pdf(paste0(out_base, ".pdf"), width = 10, height = 12)
  draw_heatmap()
  grDevices::dev.off()
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript modulon_ident_template.R <config_file>")

config_file <- args[1]
if (!file.exists(config_file)) stop(paste("Configuration file not found:", config_file))

config <- fromJSON(config_file)
if (is.null(config$activity_matrix_file)) stop("'activity_matrix_file' must be provided.")
if (is.null(config$annotation_file)) stop("'annotation_file' must be provided.")
if (!file.exists(config$activity_matrix_file)) stop(paste("Activity matrix not found:", config$activity_matrix_file))
if (!file.exists(config$annotation_file)) stop(paste("Annotation file not found:", config$annotation_file))

data <- .load_matrix(config$activity_matrix_file)
annotation <- .load_annotation(config$annotation_file)

if (length(annotation) != ncol(data)) {
  stop(paste("Annotation length (", length(annotation), ") does not match matrix columns (", ncol(data), ")", sep = ""))
}

background_classes <- config$background_classes
query_classes <- config$query_classes
k_range <- if (!is.null(config$k_range)) .expand_k_range(config$k_range) else 2:30
message(paste("Exploring k values:", paste(k_range, collapse = ", ")))

seed <- if (!is.null(config$seed)) as.integer(config$seed) else 42L
set.seed(seed)
message(paste("Random seed set to", seed))

message("Running ModulonIdent...")
results <- ModulonIdent(
  data = data,
  annotation = annotation,
  BackgroundClasses = background_classes,
  QueryClasses = query_classes,
  k.range = k_range
)

if (!dir.exists('/home/Results')) dir.create('/home/Results', recursive = TRUE)

# Save modulons and GDS
saveRDS(results$Modulons, file = '/home/Results/modulon_ident_modulons.Rds')
write.csv(results$GDS, file = '/home/Results/modulon_ident_gds.csv', row.names = FALSE)

# Best k summary
best_k <- as.integer(results$GDS[which.max(results$GDS$avg_max_weight), "NumCluster"])
summary_df <- data.frame(
  best_k = best_k,
  num_modulons = length(unique(names(results$Modulons))),
  stringsAsFactors = FALSE
)
write.csv(summary_df, file = '/home/Results/modulon_ident_summary.csv', row.names = FALSE)

# Modulon membership table
modulon_members <- do.call(rbind, lapply(names(results$Modulons), function(name) {
  tfs <- results$Modulons[[name]]
  data.frame(Modulon = name, TF = tfs, stringsAsFactors = FALSE)
}))
write.csv(modulon_members, file = '/home/Results/modulon_ident_modulon_members.csv', row.names = FALSE)

generate_plots <- if (is.null(config$generate_plots)) TRUE else isTRUE(config$generate_plots)
if (generate_plots) {
  message("Generating GDS barplot and modulon heatmap...")
  gds <- results$GDS
  .plot_gds_barplot(
    gds = gds,
    best_k = best_k,
    out_base = "/home/Results/modulon_ident_gds_barplot"
  )
  .plot_modulons_heatmap(
    data = data,
    annotation = annotation,
    modulons = results$Modulons,
    best_k = best_k,
    out_base = "/home/Results/modulon_ident_modulons_heatmap",
    state_order = config$state_order
  )
  message("Plots saved to /home/Results/modulon_ident_gds_barplot.pdf and modulon_ident_modulons_heatmap.pdf")
}

message(paste("ModulonIdent completed. Best k =", best_k))
message("Results saved to /home/Results/modulon_ident_modulons.Rds and modulon_ident_gds.csv")
