export type ProductionFileFixture = {
  path: string;
  content: string;
  mode?: number;
};

export type ProductionApplyPatchFixture = {
  id: string;
  sourceFingerprints: string[];
  productionObservation: string;
  characteristics: string[];
  initialFiles: ProductionFileFixture[];
  patch: string;
  expected:
    | {
        outcome: "success";
        files: ProductionFileFixture[];
        absent: string[];
        changeKinds: Array<"add" | "delete" | "move" | "update">;
      }
    | {
        outcome: "verification-error";
        messagePattern: RegExp;
      };
};
