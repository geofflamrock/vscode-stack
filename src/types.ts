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
    children: StackBranch[];
};

export type GitHubPullRequest = {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
};

export type ParentBranchStatus = {
    name: string;
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

// Lightweight summary for list views (avoids fetching full branch graph)
export type StackSummary = {
    name: string;
    sourceBranch: string;
    branchCount: number;
};

export function canCompareBranchToParent(branch: StackBranch): boolean {
    return (
        branch.exists &&
        (branch.remoteTrackingBranch === null || branch.remoteTrackingBranch.exists)
    );
}
