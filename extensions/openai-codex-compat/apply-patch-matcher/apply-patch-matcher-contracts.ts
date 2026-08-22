export type UpdateHunkLine = {
  kind: "add" | "context" | "delete";
  text: string;
};

export type UpdateChunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  lines: UpdateHunkLine[];
  endOfFile: boolean;
};
