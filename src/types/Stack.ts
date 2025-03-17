import { SourceBranch } from "./SourceBranch";
import { Branch } from "./Branch";

export type Stack = {
  name: string;
  sourceBranch: SourceBranch;
  branches: Branch[];
};
