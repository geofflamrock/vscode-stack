export type Branch = {
  name: string;
  exists: boolean;
  tip: Commit;
  remoteTrackingBranch: RemoteTrackingBranchStatus | null;
};

export type Commit = {
  sha: string;
  message: string;
};

export type StackBranch = Branch & {
  pullRequest: GitHubPullRequest | null;
  parent: ParentBranchStatus;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
};

export type ParentBranchStatus = {
  branch: Branch;
  ahead: number;
  behind: number;
};

export type RemoteTrackingBranchStatus = {
  name: string;
  exists: boolean;
  ahead: number;
  behind: number;
};

export type Stack = {
  name: string;
  sourceBranch: Branch;
  branches: StackBranch[];
};

export function canCompareBranchToParent(branch: StackBranch): boolean {
  return (
    branch.exists &&
    (branch.remoteTrackingBranch === null || branch.remoteTrackingBranch.exists)
  );
}
