import { Commit } from "./Commit";
import { RemoteTrackingBranchStatus } from "./RemoteTrackingBranchStatus";
import { GitHubPullRequest } from "./GitHubPullRequest";
import { ParentBranchStatus } from "./ParentBranchStatus";

export type Branch = {
  name: string;
  exists: boolean;
  tip?: Commit;
  remoteTrackingBranch?: RemoteTrackingBranchStatus;
  pullRequest?: GitHubPullRequest;
  parent?: ParentBranchStatus;
};
