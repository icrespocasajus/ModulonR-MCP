# ModulonR

ModulonR identifies "modulons"—clusters of transcription factors (TFs) exhibiting coordinated activity across different cell states, which are further characterized based on their ability to discriminate a particular cell state from the rest. By leveraging exploration of the inferred gene regulatory network (GRN), ModulonR predicts the set of TFs that might be essential for the commitment/stability of a particular cell state.

ModulonR takes, as input, the transcription factor (TF) activity matrix with single-cell resolution and a GRN. The analysis consists of three steps:

1. **Modulon identification** (`ModulonIdent`) — Hierarchical clustering of TFs by activity across cell states, followed by OPLS-DA discriminant analysis. A Global Discriminant Score (GDS) selects the optimal clustering resolution (k).

2. **Modulon selection** (`ModulonSelect`) — Modulon signatures are calculated per cell and used for cell state discriminant analysis. The top discriminant modulon of a given state is selected.

3. **Modulon perturbation** (`ModulonPert`) — Ranks combinations of TF knockouts for optimal disruption of modulon activity and dependent cell states, using a Weighted Coverage Score (WCS).

## Installation

ModulonR is pre-installed in the `agora_2025_v3` container. To install manually:

```r
install.packages("devtools")
devtools::install_github("icrespocasajus/ModulonR")
```

## Example Workflow

### Load input data

```r
library(ModulonR)

regulon.activity.matrix = readRDS("./data-raw/Regulon_Activity_Matrix_TILs.Rds")
annotation = readRDS("./data-raw/Annotation_TILs.Rds")
regulons = readRDS("./data-raw/Regulons.TILS.w.Tox.Rds")
gene.expression.matrix = readRDS("./data-raw/Gene_Expression_Matrix_TILs.Rds")
Tex.GENIE3.links = readRDS("./data-raw/1.4_GENIE3_linkList_CD8_Tex.w.Tox.Rds")
```

### Step 1: Modulon Identification

```r
ModulonIdent.results = ModulonIdent(
  data = regulon.activity.matrix,
  annotation = annotation,
  BackgroundClasses = NULL,
  QueryClasses = NULL,
  k.range = c(2:10)
)

GDS = ModulonIdent.results[['GDS']]
Best.k = GDS[which.max(GDS$avg_max_weight), 'NumCluster']
modulons = ModulonIdent.results[['Modulons']]
```

### Step 2: Modulon Selection

```r
TargetState = c('CD8_Tex')

ModulonSelect.results = ModulonSelect(
  data = regulon.activity.matrix,
  modulons = modulons,
  annotation = annotation,
  BackgroundClasses = NULL,
  TargetState = TargetState
)

ModulonSelect.results[["Selected_Modulon"]][[TargetState]]
```

### Step 3: Modulon Perturbation

```r
ModulonPert.results = ModulonPert(
  Regulons = regulons,
  Modulons = modulons,
  ExpMat = gene.expression.matrix,
  annotation = annotation,
  BackgroundClasses = NULL,
  TargetState = 'CD8_Tex',
  TargetModulon = ModulonSelect.results[["Selected_Modulon"]][["CD8_Tex"]],
  CombSize = 3,
  Weights = Tex.GENIE3.links
)

head(ModulonPert.results[["Combinations"]], 5)
```

## References

1. Andreatta, M. et al. Nature communications 12, 2965 (2021). doi:10.1038/s41467-021-23324-4
2. Aibar, S. et al. Nature methods 14.11 (2017): 1083-1086.

## Authors

Isaac Crespo, Ana Rodriguez Sanchez-Archidona, Remy Petremand — Ludwig Institute for Cancer Research, Lausanne Branch (AGORA).

GitHub: https://github.com/icrespocasajus/ModulonR
