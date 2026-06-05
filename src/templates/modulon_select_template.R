# ModulonR ModulonSelect Template

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

.discrete_colors <- function(labels, palette = "Dynamic") {
  labels <- as.character(labels)
  if (length(labels) == 0) {
    return(setNames(character(0), character(0)))
  }
  cols <- grDevices::hcl.colors(length(labels), palette = palette)
  stats::setNames(cols, labels)
}

.safe_filename <- function(x) {
  gsub("[^A-Za-z0-9._-]+", "_", x)
}

.plot_modulon_da_barplot <- function(da, target_state, out_base) {
  suppressPackageStartupMessages(library(ggplot2))

  input.tmp <- da
  input.tmp$label <- as.character(input.tmp$feature)
  input.tmp <- input.tmp[order(input.tmp$weightStarMN, decreasing = TRUE), ]
  input.tmp$order <- factor(seq_len(nrow(input.tmp)))

  modulon_colors <- .discrete_colors(sort(unique(input.tmp$label)), palette = "Set2")

  p <- ggplot2::ggplot(
    input.tmp,
    ggplot2::aes(x = order, y = weightStarMN, fill = label)
  ) +
    ggplot2::coord_cartesian(ylim = c(-1, 1)) +
    ggplot2::geom_col(color = "black") +
    ggplot2::theme_light() +
    ggplot2::theme(
      legend.position = "none",
      axis.text.x = ggplot2::element_blank(),
      axis.ticks.x = ggplot2::element_blank()
    ) +
    ggplot2::ggtitle(paste0(target_state, " State Modulon Discriminancy")) +
    ggplot2::xlab("Modulons") +
    ggplot2::ylab("Discriminant Score") +
    ggplot2::labs(fill = "Modulon") +
    ggplot2::scale_fill_manual(values = modulon_colors) +
    ggplot2::geom_text(
      ggplot2::aes(
        label = label,
        vjust = ifelse(weightStarMN >= 0, -0.5, 1.5)
      ),
      color = "black"
    )

  ggplot2::ggsave(paste0(out_base, ".pdf"), plot = p, width = 8, height = 5)
}

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript modulon_select_template.R <config_file>")

config_file <- args[1]
if (!file.exists(config_file)) stop(paste("Configuration file not found:", config_file))

config <- fromJSON(config_file)
required <- c("activity_matrix_file", "modulons_file", "annotation_file")
for (field in required) {
  if (is.null(config[[field]])) stop(paste("'", field, "' must be provided.", sep = ""))
  if (!file.exists(config[[field]])) stop(paste("File not found:", config[[field]]))
}

data <- .load_matrix(config$activity_matrix_file)
modulons <- readRDS(config$modulons_file)
annotation <- .load_annotation(config$annotation_file)

if (length(annotation) != ncol(data)) {
  stop(paste("Annotation length (", length(annotation), ") does not match matrix columns (", ncol(data), ")", sep = ""))
}

background_classes <- config$background_classes
target_state <- config$target_state

message("Running ModulonSelect...")
results <- ModulonSelect(
  data = data,
  modulons = modulons,
  annotation = annotation,
  BackgroundClasses = background_classes,
  TargetState = target_state
)

if (!dir.exists('/home/Results')) dir.create('/home/Results', recursive = TRUE)

saveRDS(results, file = '/home/Results/modulon_select_results.Rds')

# Selected modulons per target state
selected_df <- data.frame(
  TargetState = names(results$Selected_Modulon),
  Selected_Modulon = unlist(results$Selected_Modulon),
  stringsAsFactors = FALSE
)
write.csv(selected_df, file = '/home/Results/modulon_select_modulons.csv', row.names = FALSE)

# Discriminant scores per modulon per state
da_rows <- list()
for (state in names(results$Modulon_DA)) {
  da <- results$Modulon_DA[[state]]
  da$TargetState <- state
  da_rows[[state]] <- da
}
da_combined <- do.call(rbind, da_rows)
write.csv(da_combined, file = '/home/Results/modulon_select_modulon_da.csv', row.names = FALSE)

generate_plots <- if (is.null(config$generate_plots)) TRUE else isTRUE(config$generate_plots)
if (generate_plots) {
  message("Generating modulon discriminant barplots...")
  states <- names(results$Modulon_DA)
  for (state in states) {
    out_base <- if (length(states) == 1) {
      "/home/Results/modulon_select_modulon_da_barplot"
    } else {
      paste0("/home/Results/modulon_select_modulon_da_barplot_", .safe_filename(state))
    }
    .plot_modulon_da_barplot(
      da = results$Modulon_DA[[state]],
      target_state = state,
      out_base = out_base
    )
    message(paste("Barplot saved to", paste0(out_base, ".pdf")))
  }
}

message("ModulonSelect completed.")
print(selected_df)
