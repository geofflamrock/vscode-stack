import { Commit } from "./Commit";
import { RemoteTrackingBranchStatus } from "./RemoteTrackingBranchStatus";

export type SourceBranch = {
  name: string;
  exists: boolean;
  tip: Commit;
  remoteTrackingBranch: RemoteTrackingBranchStatus | null;
};
