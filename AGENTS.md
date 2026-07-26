# Working in this repository

Read `docs/architecture.md` before changing data loading or viewer behavior. Keep
dependencies pointed toward the small domain modules:

- Import shared data shapes from `app/data/types.ts`.
- Reuse dimension-role predicates from `app/data/dimensions.ts`; do not add
  local latitude, initialization, or ensemble alias lists.
- Import coordinate, date, and selection logic from `app/data/axes.ts`.
- Import `app/dataset.ts` only for store discovery.
- Import point extraction from `app/data/point-series.ts`.
- Put store-specific behavior on `DatasetSourceConfig` capabilities instead of
  branching on dataset or source IDs.
- Keep pure viewer policy in `app/viewer/`; keep `ZarrViewer.tsx` focused on
  orchestration, effects, and composition.
- Put reusable React UI in `app/components/`.

Preserve `app/dataset.ts` re-exports for compatibility unless all consumers are
migrated in the same change. Run `npm test` after behavior-preserving refactors.
The remote-data checks are intentionally opt-in because they depend on live
third-party stores.
