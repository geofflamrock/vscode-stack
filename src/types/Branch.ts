import { Commit } from "./Commit";
import { RemoteTrackingBranchStatus } from "./RemoteTrackingBranchStatus";
import { GitHubPullRequest } from "./GitHubPullRequest";
import { ParentBranchStatus } from "./ParentBranchStatus";

export type Branch = {
  name: string;
  exists: boolean;
  tip: Commit;
  remoteTrackingBranch: RemoteTrackingBranchStatus | null;
  pullRequest: GitHubPullRequest | null;
  parent: ParentBranchStatus | null;
};

export function canCompareBranchToParent(branch: Branch): boolean {
  return (
    branch.exists &&
    (branch.remoteTrackingBranch === null || branch.remoteTrackingBranch.exists)
  );
}
